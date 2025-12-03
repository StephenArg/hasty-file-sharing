import wsClient from './websocketClient';
import { getPieceSize, hashPiece } from './chunking';

/**
 * Upload file via WebSocket
 */
export async function uploadFileViaWebSocket(file, onProgress, onFileStart) {
  return new Promise(async (resolve, reject) => {
    try {
      // Connect to WebSocket
      await wsClient.connect();

      const fileSize = file.size;
      let uploadedChunks = 0;
      let fileId = null;
      let totalPieces = 0;

      // Initialize upload
      wsClient.send('UPLOAD_INIT', {
        filename: file.name,
        size: fileSize,
        mimeType: file.type || 'application/octet-stream'
      });

      // Handle upload init success
      const initHandler = (payload) => {
        fileId = payload.fileId;
        totalPieces = payload.totalPieces;
        
        if (onFileStart) {
          onFileStart({
            id: fileId,
            filename: file.name,
            size: fileSize,
            totalPieces: payload.totalPieces,
            pieceSize: payload.pieceSize,
            uploadComplete: false
          });
        }

        // Start uploading chunks
        uploadChunks(file, fileId, payload.pieceSize, payload.totalPieces, onProgress, resolve, reject);
      };

      wsClient.on('UPLOAD_INIT_SUCCESS', initHandler);

      // Handle chunk upload success
      const chunkHandler = (payload) => {
        uploadedChunks = payload.uploadedChunks;
        const progress = totalPieces > 0 ? (uploadedChunks / totalPieces) * 100 : 0;
        
        if (onProgress) {
          onProgress({
            filename: file.name,
            progress: Math.round(progress),
            loaded: uploadedChunks,
            total: totalPieces,
            speed: ''
          });
        }
      };

      wsClient.on('UPLOAD_CHUNK_SUCCESS', chunkHandler);

      // Handle upload complete
      const completeHandler = (payload) => {
        wsClient.off('UPLOAD_INIT_SUCCESS', initHandler);
        wsClient.off('UPLOAD_CHUNK_SUCCESS', chunkHandler);
        wsClient.off('UPLOAD_COMPLETE', completeHandler);
        wsClient.off('ERROR', errorHandler);

        if (onProgress) {
          onProgress({
            filename: file.name,
            progress: 100,
            loaded: totalPieces,
            total: totalPieces,
            speed: ''
          });
        }

        resolve({
          success: true,
          fileId: payload.fileId
        });
      };

      wsClient.on('UPLOAD_COMPLETE', completeHandler);

      // Handle errors
      const errorHandler = (payload) => {
        if (payload.errorType === 'UPLOAD_INIT_ERROR' || 
            payload.errorType === 'UPLOAD_CHUNK_ERROR' ||
            payload.errorType === 'STORAGE_LIMIT_EXCEEDED' ||
            payload.errorType === 'HASH_MISMATCH') {
          wsClient.off('UPLOAD_INIT_SUCCESS', initHandler);
          wsClient.off('UPLOAD_CHUNK_SUCCESS', chunkHandler);
          wsClient.off('UPLOAD_COMPLETE', completeHandler);
          wsClient.off('ERROR', errorHandler);
          reject(new Error(payload.message));
        }
      };

      wsClient.on('ERROR', errorHandler);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Upload chunks sequentially
 */
async function uploadChunks(file, fileId, pieceSize, totalPieces, onProgress, resolve, reject) {
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
      
      // Upload next chunk immediately (WebSocket handles backpressure)
      // Small delay to avoid overwhelming the server
      setTimeout(uploadNextChunk, 5);
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
 */
function uint8ArrayToBase64(uint8Array) {
  const chunkSize = 8192; // Process in chunks of 8KB
  let result = '';
  
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const chunk = uint8Array.subarray(i, i + chunkSize);
    result += String.fromCharCode.apply(null, chunk);
  }
  
  return btoa(result);
}

