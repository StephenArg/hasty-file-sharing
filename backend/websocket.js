const WebSocket = require('ws');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const mimeTypes = require('mime-types');
const db = require('./database');
const { getPieceSize, hashPiece } = require('./utils/chunking');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../uploads');

// Track active uploads and downloads
const activeUploads = new Map(); // fileId -> { filePath, writeStream, uploadedChunks: Set, totalPieces, pieceSize }
const activeDownloads = new Map(); // fileId -> Set<WebSocket>

/**
 * Initialize WebSocket server
 */
function initializeWebSocket(server) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    console.log('WebSocket client connected');

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleMessage(ws, message);
      } catch (err) {
        console.error('Error handling WebSocket message:', err);
        sendError(ws, 'INVALID_MESSAGE', err.message);
      }
    });

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      // Clean up any active uploads/downloads for this connection
      cleanupConnection(ws);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      cleanupConnection(ws);
    });
  });

  return wss;
}

/**
 * Handle incoming WebSocket messages
 */
async function handleMessage(ws, message) {
  const { type, payload } = message;

  switch (type) {
    case 'UPLOAD_INIT':
      await handleUploadInit(ws, payload);
      break;
    case 'UPLOAD_CHUNK':
      await handleUploadChunk(ws, payload);
      break;
    case 'DOWNLOAD_INIT':
      await handleDownloadInit(ws, payload);
      break;
    case 'DOWNLOAD_REQUEST':
      await handleDownloadRequest(ws, payload);
      break;
    case 'DOWNLOAD_CANCEL':
      await handleDownloadCancel(ws, payload);
      break;
    default:
      sendError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type: ${type}`);
  }
}

/**
 * Initialize file upload
 */
async function handleUploadInit(ws, payload) {
  try {
    const { filename, size, mimeType, requestId } = payload;

    if (!filename || !size) {
      sendError(ws, 'UPLOAD_INIT_ERROR', 'Missing filename or size');
      return;
    }

    // Check storage space
    const totalUsed = await db.getTotalStorageUsed();
    const STORAGE_LIMIT = parseStorageLimit(process.env.STORAGE_LIMIT || '100GB');
    if (totalUsed + size > STORAGE_LIMIT) {
      sendError(ws, 'STORAGE_LIMIT_EXCEEDED', 'Storage limit exceeded');
      return;
    }

    const fileId = uuidv4();
    const fileExtension = path.extname(filename);
    const finalFilename = `${fileId}${fileExtension}`;
    const finalPath = path.join(UPLOADS_DIR, finalFilename);

    // Determine piece size
    const pieceSize = getPieceSize(size);
    const totalPieces = Math.ceil(size / pieceSize);

    // Create file entry in database
    await db.createFile({
      id: fileId,
      filename: finalFilename,
      originalFilename: filename,
      size,
      pieceSize,
      totalPieces,
      mimeType: mimeType || mimeTypes.lookup(filename) || 'application/octet-stream',
      filePath: finalPath
    });

    // Create piece entries
    const dbPieces = [];
    for (let i = 0; i < totalPieces; i++) {
      const offset = i * pieceSize;
      const remainingBytes = size - offset;
      const currentPieceSize = Math.min(pieceSize, remainingBytes);

      dbPieces.push({
        fileId,
        pieceIndex: i,
        hash: '',
        size: currentPieceSize,
        offset,
        isComplete: 0
      });
    }
    await db.createPieces(dbPieces);

    // Create empty file
    await fs.writeFile(finalPath, Buffer.alloc(0));

    // Track upload session
    activeUploads.set(fileId, {
      filePath: finalPath,
      uploadedChunks: new Set(),
      totalPieces,
      pieceSize,
      size,
      ws
    });

    // Send confirmation (echo back requestId and file info for matching)
    ws.send(JSON.stringify({
      type: 'UPLOAD_INIT_SUCCESS',
      payload: {
        fileId,
        pieceSize,
        totalPieces,
        requestId: payload.requestId, // Echo back request ID
        filename: filename, // Include filename for matching
        size: size // Include size for matching
      }
    }));

    console.log(`[${fileId}] Upload initialized: ${filename} (${totalPieces} pieces)`);
  } catch (err) {
    console.error('Upload init error:', err);
    sendError(ws, 'UPLOAD_INIT_ERROR', err.message);
  }
}

/**
 * Handle chunk upload
 */
async function handleUploadChunk(ws, payload) {
  try {
    const { fileId, chunkIndex, data, hash } = payload;

    if (!fileId || chunkIndex === undefined || !data) {
      sendError(ws, 'UPLOAD_CHUNK_ERROR', 'Missing required fields');
      return;
    }

    const upload = activeUploads.get(fileId);
    if (!upload) {
      sendError(ws, 'UPLOAD_NOT_FOUND', 'Upload session not found');
      return;
    }

    // Decode base64 data
    const chunkData = Buffer.from(data, 'base64');

    // Verify hash
    const actualHash = hashPiece(chunkData);
    if (hash && actualHash !== hash) {
      sendError(ws, 'HASH_MISMATCH', 'Chunk hash mismatch');
      return;
    }

    // Calculate offset
    const offset = chunkIndex * upload.pieceSize;

    // Write chunk to file at correct offset
    // Use fs.promises for proper async file writing
    const fd = await require('fs').promises.open(upload.filePath, 'r+');
    try {
      // FileHandle.write() signature: (buffer, offset?, length?, position?)
      // We want to write chunkData at position 'offset'
      // offset=0 means start from beginning of buffer, length=chunkData.length, position=file offset
      const result = await fd.write(chunkData, 0, chunkData.length, offset);
      
      // Verify bytes written
      if (result.bytesWritten !== chunkData.length) {
        throw new Error(`Only wrote ${result.bytesWritten} of ${chunkData.length} bytes`);
      }
      
      await fd.sync(); // Ensure data is written to disk
    } finally {
      await fd.close();
    }

    // Update piece in database
    await Promise.all([
      db.updatePieceHash(fileId, chunkIndex, actualHash),
      db.updatePieceComplete(fileId, chunkIndex, true)
    ]);

    // Track uploaded chunk
    upload.uploadedChunks.add(chunkIndex);

    // Send confirmation
    ws.send(JSON.stringify({
      type: 'UPLOAD_CHUNK_SUCCESS',
      payload: {
        fileId,
        chunkIndex,
        uploadedChunks: upload.uploadedChunks.size,
        totalPieces: upload.totalPieces
      }
    }));

    // Notify downloaders that new chunk is available
    notifyDownloaders(fileId, chunkIndex).catch(err => {
      console.error(`[${fileId}] Error notifying downloaders:`, err);
    });

    // Check if upload is complete
    if (upload.uploadedChunks.size === upload.totalPieces) {
      activeUploads.delete(fileId);

      ws.send(JSON.stringify({
        type: 'UPLOAD_COMPLETE',
        payload: { fileId }
      }));

      console.log(`[${fileId}] Upload complete`);
    }
  } catch (err) {
    console.error('Upload chunk error:', err);
    sendError(ws, 'UPLOAD_CHUNK_ERROR', err.message);
  }
}

/**
 * Initialize file download
 */
async function handleDownloadInit(ws, payload) {
  try {
    const { fileId } = payload;

    if (!fileId) {
      sendError(ws, 'DOWNLOAD_INIT_ERROR', 'Missing fileId');
      return;
    }

    const file = await db.getFileById(fileId);
    if (!file) {
      sendError(ws, 'FILE_NOT_FOUND', 'File not found');
      return;
    }

    // Get available chunks
    const pieces = await db.getPiecesByFileId(fileId);
    const availableChunks = pieces
      .filter(p => p.is_complete === 1)
      .map(p => ({
        index: p.piece_index,
        hash: p.hash,
        size: p.size,
        offset: p.offset
      }))
      .sort((a, b) => a.index - b.index);

    // Track download session
    if (!activeDownloads.has(fileId)) {
      activeDownloads.set(fileId, new Set());
    }
    activeDownloads.get(fileId).add(ws);

    // Send file info and available chunks
    ws.send(JSON.stringify({
      type: 'DOWNLOAD_INIT_SUCCESS',
      payload: {
        fileId,
        filename: file.original_filename || file.filename,
        size: file.size,
        pieceSize: file.piece_size,
        totalPieces: file.total_pieces,
        availableChunks: availableChunks.length,
        chunks: availableChunks
      }
    }));

    console.log(`[${fileId}] Download initialized: ${availableChunks.length}/${file.total_pieces} chunks available`);
  } catch (err) {
    console.error('Download init error:', err);
    sendError(ws, 'DOWNLOAD_INIT_ERROR', err.message);
  }
}

/**
 * Handle chunk download request
 */
async function handleDownloadRequest(ws, payload) {
  try {
    const { fileId, chunkIndex } = payload;

    if (!fileId || chunkIndex === undefined) {
      sendError(ws, 'DOWNLOAD_REQUEST_ERROR', 'Missing required fields');
      return;
    }

    const file = await db.getFileById(fileId);
    if (!file) {
      sendError(ws, 'FILE_NOT_FOUND', 'File not found');
      return;
    }

    const pieces = await db.getPiecesByFileId(fileId);
    const piece = pieces.find(p => p.piece_index === chunkIndex && p.is_complete === 1);

    if (!piece) {
      sendError(ws, 'CHUNK_NOT_AVAILABLE', 'Chunk not available');
      return;
    }

    // Read chunk from file
    const fd = await require('fs').promises.open(file.file_path, 'r');
    try {
      const buffer = Buffer.alloc(piece.size);
      const result = await fd.read(buffer, 0, piece.size, piece.offset);
      
      // Verify bytes read
      if (result.bytesRead !== piece.size) {
        sendError(ws, 'READ_ERROR', `Only read ${result.bytesRead} of ${piece.size} bytes`);
        await fd.close();
        return;
      }

      // Send chunk
      ws.send(JSON.stringify({
        type: 'DOWNLOAD_CHUNK',
        payload: {
          fileId,
          chunkIndex: piece.piece_index,
          data: buffer.toString('base64'),
          hash: piece.hash,
          size: piece.size,
          offset: piece.offset
        }
      }));
    } finally {
      await fd.close();
    }
  } catch (err) {
    console.error('Download request error:', err);
    sendError(ws, 'DOWNLOAD_REQUEST_ERROR', err.message);
  }
}

/**
 * Handle download cancel
 */
async function handleDownloadCancel(ws, payload) {
  const { fileId } = payload;
  if (fileId && activeDownloads.has(fileId)) {
    activeDownloads.get(fileId).delete(ws);
    if (activeDownloads.get(fileId).size === 0) {
      activeDownloads.delete(fileId);
    }
  }
}

/**
 * Clean up connection
 */
function cleanupConnection(ws) {
  // Remove from active uploads
  for (const [fileId, upload] of activeUploads.entries()) {
    if (upload.ws === ws) {
      activeUploads.delete(fileId);
    }
  }

  // Remove from active downloads
  for (const [fileId, downloadSet] of activeDownloads.entries()) {
    downloadSet.delete(ws);
    if (downloadSet.size === 0) {
      activeDownloads.delete(fileId);
    }
  }
}

/**
 * Send error message
 */
function sendError(ws, errorType, message) {
  ws.send(JSON.stringify({
    type: 'ERROR',
    payload: {
      errorType,
      message
    }
  }));
}

/**
 * Parse storage limit
 */
function parseStorageLimit(limit) {
  if (typeof limit === 'number') return limit;
  if (typeof limit !== 'string') return 100 * 1024 * 1024 * 1024;
  
  const match = limit.match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)?$/i);
  if (!match) return 100 * 1024 * 1024 * 1024;
  
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  
  const multipliers = {
    'B': 1,
    'KB': 1024,
    'MB': 1024 * 1024,
    'GB': 1024 * 1024 * 1024,
    'TB': 1024 * 1024 * 1024 * 1024
  };
  
  return Math.floor(value * (multipliers[unit] || 1));
}

/**
 * Notify downloaders when new chunks become available
 */
async function notifyDownloaders(fileId, chunkIndex) {
  if (!activeDownloads.has(fileId) || activeDownloads.get(fileId).size === 0) {
    return;
  }

  const file = await db.getFileById(fileId);
  if (!file) return;

  const pieces = await db.getPiecesByFileId(fileId);
  const piece = pieces.find(p => p.piece_index === chunkIndex && p.is_complete === 1);
  if (!piece) return;

    // Read and send chunk to all active downloaders
    const fd = await require('fs').promises.open(file.file_path, 'r');
    try {
      const buffer = Buffer.alloc(piece.size);
      const result = await fd.read(buffer, 0, piece.size, piece.offset);
      
      // Verify bytes read
      if (result.bytesRead !== piece.size) {
        console.error(`[${fileId}] Only read ${result.bytesRead} of ${piece.size} bytes for chunk ${chunkIndex}`);
        return;
      }

    const message = JSON.stringify({
      type: 'DOWNLOAD_CHUNK',
      payload: {
        fileId,
        chunkIndex: piece.piece_index,
        data: buffer.toString('base64'),
        hash: piece.hash,
        size: piece.size,
        offset: piece.offset
      }
    });

    // Send to all downloaders
    const downloadSet = activeDownloads.get(fileId);
    for (const ws of downloadSet) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  } finally {
    await fd.close();
  }
}

module.exports = {
  initializeWebSocket,
  notifyDownloaders
};

