import wsClient from './websocketClient';
import { getPieceSize, hashPiece } from './chunking';

/**
 * Upload file via WebSocket
 */
export async function uploadFileViaWebSocket(file, onProgress, onFileStart) {
  return new Promise(async (resolve, reject) => {
    // Create a unique upload session ID to isolate this upload
    const uploadSessionId = `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Connect to WebSocket
      await wsClient.connect();

      const fileSize = file.size;
      let uploadedChunks = 0;
      let fileId = null;
      let totalPieces = 0;
      let pieceSize = 0;
      const fileName = file.name;
      let isResolved = false;
      
      // Generate a unique request ID to match responses
      const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Initialize upload with request ID
      wsClient.send('UPLOAD_INIT', {
        filename: fileName,
        size: fileSize,
        mimeType: file.type || 'application/octet-stream',
        requestId: requestId // Include request ID to match response
      });

      // Track if we've received our init response
      let initReceived = false;
      
      // Handle upload init success - scoped to this specific upload session
      const initHandler = (payload) => {
        // If we already received init, ignore
        if (initReceived) {
          return;
        }
        
        // Match by requestId if available, otherwise by filename+size
        const matchesRequest = payload.requestId === requestId;
        const matchesFile = payload.filename === fileName && payload.size === fileSize;
        
        if (!matchesRequest && !matchesFile) {
          return; // Not our response
        }
        
        // Accept this as our response and set fileId
        fileId = payload.fileId;
        initReceived = true;
        
        totalPieces = payload.totalPieces;
        pieceSize = payload.pieceSize;
        
        if (onFileStart) {
          onFileStart({
            id: fileId,
            filename: fileName,
            size: fileSize,
            totalPieces: payload.totalPieces,
            pieceSize: payload.pieceSize,
            uploadComplete: false
          });
        }
        
        // Start uploading chunks
        uploadChunks(file, fileId, pieceSize, payload.totalPieces, fileSize, onProgress, resolve, reject, uploadSessionId);
      };

      // Handle chunk upload success - scoped to this specific file
      const chunkHandler = (payload) => {
        // Only handle chunks for this specific file
        if (!fileId || payload.fileId !== fileId) {
          return; // Not our file
        }
        
        uploadedChunks = payload.uploadedChunks;
        const progress = totalPieces > 0 ? (uploadedChunks / totalPieces) * 100 : 0;
        
        // Calculate bytes transferred
        let bytesTransferred = 0;
        if (uploadedChunks > 0 && pieceSize > 0) {
          if (uploadedChunks === totalPieces) {
            bytesTransferred = fileSize;
          } else {
            const fullChunksBytes = (uploadedChunks - 1) * pieceSize;
            const lastChunkSize = Math.min(pieceSize, fileSize - fullChunksBytes);
            bytesTransferred = fullChunksBytes + lastChunkSize;
          }
        }
        
        if (onProgress) {
          onProgress({
            filename: fileName,
            progress: Math.round(progress),
            loaded: uploadedChunks,
            total: totalPieces,
            bytesLoaded: bytesTransferred,
            bytesTotal: fileSize,
            speed: ''
          });
        }
      };

      // Handle upload complete - scoped to this specific file
      const completeHandler = (payload) => {
        if (payload.fileId !== fileId || isResolved) {
          return; // Not our file or already resolved
        }
        
        isResolved = true;
        
        // Clean up handlers
        wsClient.off('UPLOAD_INIT_SUCCESS', initHandler);
        wsClient.off('UPLOAD_CHUNK_SUCCESS', chunkHandler);
        wsClient.off('UPLOAD_COMPLETE', completeHandler);
        wsClient.off('ERROR', errorHandler);

        if (onProgress) {
          onProgress({
            filename: fileName,
            progress: 100,
            loaded: totalPieces,
            total: totalPieces,
            bytesLoaded: fileSize,
            bytesTotal: fileSize,
            speed: ''
          });
        }

        resolve({
          success: true,
          fileId: payload.fileId
        });
      };

      // Handle errors - scoped to this specific file
      const errorHandler = (payload) => {
        // Only handle errors for our file or init errors (before we have fileId)
        if (fileId && payload.fileId && payload.fileId !== fileId) {
          return; // Not our file's error
        }
        
        if (payload.errorType === 'AUTH_REQUIRED') {
          // Authentication required - trigger login
          if (!isResolved) {
            isResolved = true;
            // Clean up handlers
            wsClient.off('UPLOAD_INIT_SUCCESS', initHandler);
            wsClient.off('UPLOAD_CHUNK_SUCCESS', chunkHandler);
            wsClient.off('UPLOAD_COMPLETE', completeHandler);
            wsClient.off('ERROR', errorHandler);
            reject(new Error('Authentication required. Please log in.'));
          }
          return;
        }
        
        if (payload.errorType === 'UPLOAD_INIT_ERROR' || 
            payload.errorType === 'UPLOAD_CHUNK_ERROR' ||
            payload.errorType === 'STORAGE_LIMIT_EXCEEDED' ||
            payload.errorType === 'HASH_MISMATCH') {
          
          if (!isResolved) {
            isResolved = true;
            // Clean up handlers
            wsClient.off('UPLOAD_INIT_SUCCESS', initHandler);
            wsClient.off('UPLOAD_CHUNK_SUCCESS', chunkHandler);
            wsClient.off('UPLOAD_COMPLETE', completeHandler);
            wsClient.off('ERROR', errorHandler);
            reject(new Error(payload.message));
          }
        }
      };

      // Register all handlers
      wsClient.on('UPLOAD_INIT_SUCCESS', initHandler);
      wsClient.on('UPLOAD_CHUNK_SUCCESS', chunkHandler);
      wsClient.on('UPLOAD_COMPLETE', completeHandler);
      wsClient.on('ERROR', errorHandler);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Upload chunks sequentially
 */
async function uploadChunks(file, fileId, pieceSize, totalPieces, fileSize, onProgress, resolve, reject, uploadSessionId) {
  let currentChunkIndex = 0;
  let errorOccurred = false;

  const uploadNextChunk = async () => {
    if (errorOccurred || currentChunkIndex >= totalPieces) {
      return; // All chunks uploaded or error occurred
    }

    try {
      const offset = currentChunkIndex * pieceSize;
      const remainingBytes = file.size - offset;
      const currentChunkSize = Math.min(pieceSize, remainingBytes);
      const chunk = file.slice(offset, offset + currentChunkSize);

      // Read chunk as ArrayBuffer
      const arrayBuffer = await chunk.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      
      // Convert to base64 in chunks to avoid "too many function arguments" error
      const base64Data = uint8ArrayToBase64(uint8Array);
      
      // Calculate hash
      const hash = await hashPiece(uint8Array);

      // Send chunk
      wsClient.send('UPLOAD_CHUNK', {
        fileId,
        chunkIndex: currentChunkIndex,
        data: base64Data,
        hash
      });

      currentChunkIndex++;
      
      // Upload next chunk with minimal delay to allow parallel uploads
      setTimeout(uploadNextChunk, 1);
    } catch (err) {
      errorOccurred = true;
      reject(new Error(`Error uploading chunk ${currentChunkIndex}: ${err.message}`));
    }
  };

  // Start uploading chunks
  uploadNextChunk();
}

/**
 * Convert Uint8Array to base64 in chunks to avoid argument limit
 * This ensures perfect fidelity by processing in manageable chunks
 */
function uint8ArrayToBase64(uint8Array) {
  const chunkSize = 8192; // Process in chunks of 8KB
  let result = '';
  
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const chunk = uint8Array.subarray(i, i + chunkSize);
    // Use Array.from to convert to array, then apply
    const chunkArray = Array.from(chunk);
    result += String.fromCharCode.apply(null, chunkArray);
  }
  
  return btoa(result);
}
