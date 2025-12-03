const crypto = require('crypto');
const fs = require('fs').promises;

/**
 * Determine piece size based on file size
 */
function getPieceSize(fileSize) {
  if (fileSize < 128 * 1024 * 1024) { // < 128 MB
    return 64 * 1024; // 64 KB
  } else if (fileSize < 1024 * 1024 * 1024) { // < 1 GB
    return 256 * 1024; // 256 KB
  } else if (fileSize < 4 * 1024 * 1024 * 1024) { // < 4 GB
    return 512 * 1024; // 512 KB
  } else if (fileSize < 16 * 1024 * 1024 * 1024) { // < 16 GB
    return 1024 * 1024; // 1 MB
  } else if (fileSize < 64 * 1024 * 1024 * 1024) { // < 64 GB
    return 2 * 1024 * 1024; // 2 MB
  } else if (fileSize < 256 * 1024 * 1024 * 1024) { // < 256 GB
    return 4 * 1024 * 1024; // 4 MB
  } else { // > 256 GB
    return 8 * 1024 * 1024; // 8 MB
  }
}

/**
 * Calculate hash for a piece of data
 */
function hashPiece(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Process file and create pieces with hashes
 */
async function processFile(filePath, pieceSize = null) {
  const stats = await fs.stat(filePath);
  const fileSize = stats.size;
  
  if (!pieceSize) {
    pieceSize = getPieceSize(fileSize);
  }
  
  const totalPieces = Math.ceil(fileSize / pieceSize);
  const pieces = [];
  
  const fd = await fs.open(filePath, 'r');
  
  try {
    for (let i = 0; i < totalPieces; i++) {
      const offset = i * pieceSize;
      const remainingBytes = fileSize - offset;
      const currentPieceSize = Math.min(pieceSize, remainingBytes);
      
      const buffer = Buffer.alloc(currentPieceSize);
      await fd.read(buffer, 0, currentPieceSize, offset);
      
      const hash = hashPiece(buffer);
      
      pieces.push({
        pieceIndex: i,
        hash,
        size: currentPieceSize,
        offset,
        data: buffer
      });
    }
  } finally {
    await fd.close();
  }
  
  return {
    pieces,
    pieceSize,
    totalPieces,
    fileSize
  };
}

/**
 * Process file stream and create pieces (for large files)
 */
async function processFileStream(filePath, pieceSize = null, onPiece = null) {
  const stats = await fs.stat(filePath);
  const fileSize = stats.size;
  
  if (!pieceSize) {
    pieceSize = getPieceSize(fileSize);
  }
  
  const totalPieces = Math.ceil(fileSize / pieceSize);
  const pieces = [];
  
  const stream = require('fs').createReadStream(filePath);
  let currentPiece = Buffer.alloc(0);
  let currentPieceIndex = 0;
  let currentOffset = 0;
  
  return new Promise((resolve, reject) => {
    const piecePromises = [];
    
    stream.on('data', (chunk) => {
      currentPiece = Buffer.concat([currentPiece, chunk]);
      
      while (currentPiece.length >= pieceSize) {
        const pieceData = currentPiece.slice(0, pieceSize);
        const hash = hashPiece(pieceData);
        
        const piece = {
          pieceIndex: currentPieceIndex,
          hash,
          size: pieceSize,
          offset: currentOffset
        };
        
        pieces.push(piece);
        
        if (onPiece) {
          // Call onPiece callback - if it returns a promise, track it
          const result = onPiece(piece);
          if (result && typeof result.then === 'function') {
            piecePromises.push(result.catch(err => {
              console.error(`Error in onPiece callback for piece ${piece.pieceIndex}:`, err);
            }));
          }
        }
        
        currentPiece = currentPiece.slice(pieceSize);
        currentPieceIndex++;
        currentOffset += pieceSize;
      }
    });
    
    stream.on('end', async () => {
      // Handle remaining data
      if (currentPiece.length > 0) {
        const hash = hashPiece(currentPiece);
        const lastPiece = {
          pieceIndex: currentPieceIndex,
          hash,
          size: currentPiece.length,
          offset: currentOffset
        };
        pieces.push(lastPiece);
        
        if (onPiece) {
          const result = onPiece(lastPiece);
          if (result && typeof result.then === 'function') {
            piecePromises.push(result.catch(err => {
              console.error(`Error in onPiece callback for last piece:`, err);
            }));
          }
        }
      }
      
      // Wait for all piece processing to complete (but don't block on errors)
      try {
        await Promise.all(piecePromises);
      } catch (err) {
        // Individual errors are already caught, just log if there's a general issue
        console.error('Some piece processing callbacks failed:', err);
      }
      
      resolve({
        pieces,
        pieceSize,
        totalPieces,
        fileSize
      });
    });
    
    stream.on('error', reject);
  });
}

/**
 * Verify piece hash
 */
function verifyPiece(data, expectedHash) {
  const actualHash = hashPiece(data);
  return actualHash === expectedHash;
}

module.exports = {
  getPieceSize,
  hashPiece,
  processFile,
  processFileStream,
  verifyPiece
};

