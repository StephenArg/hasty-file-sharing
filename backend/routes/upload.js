const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const mimeTypes = require('mime-types');
const db = require('../database');
const { processFile } = require('../utils/chunking');
const { zipDirectory, zipFiles } = require('../utils/zip');

const router = express.Router();
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../../uploads');

// Parse storage limit (same logic as server.js)
function parseStorageLimit(limit) {
  if (typeof limit === 'number') return limit;
  if (typeof limit !== 'string') return 100 * 1024 * 1024 * 1024; // 100GB default
  
  const match = limit.match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)?$/i);
  if (!match) return 100 * 1024 * 1024 * 1024; // 100GB default
  
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

const STORAGE_LIMIT = parseStorageLimit(process.env.STORAGE_LIMIT || '100GB');

// Check if there's enough storage space
async function checkStorageSpace(requiredBytes) {
  const totalUsed = await db.getTotalStorageUsed();
  const available = STORAGE_LIMIT - totalUsed;
  return {
    hasSpace: available >= requiredBytes,
    available,
    totalUsed,
    totalLimit: STORAGE_LIMIT,
    required: requiredBytes
  };
}

// Custom storage that processes pieces as file is being written
class StreamingProcessingStorage {
  constructor() {
    this.getDestination = async (req, file, cb) => {
      await fs.mkdir(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    };
  }

  _handleFile(req, file, cb) {
    // Get fileId from request (may be set by chunk/init)
    const fileId = req.body.fileId || uuidv4();
    const fileExtension = path.extname(file.originalname);
    const finalFilename = `${fileId}${fileExtension}`;
    const finalPath = path.join(UPLOADS_DIR, finalFilename);
    
    // Create write stream
    const writeStream = require('fs').createWriteStream(finalPath);
    const { getPieceSize, hashPiece } = require('../utils/chunking');
    
    let totalBytes = 0;
    let pieceSize = null;
    let totalPieces = 0;
    let currentPiece = Buffer.alloc(0);
    let currentPieceIndex = 0;
    let currentOffset = 0;
    let fileCreated = false;
    let piecesCreated = false;
    
    // Process file metadata and create database entry as soon as we know the file is starting
    file.stream.on('data', async (chunk) => {
      totalBytes += chunk.length;
      
      // Determine piece size on first chunk
      if (!pieceSize) {
        // Estimate file size from Content-Length header if available
        const estimatedSize = parseInt(req.headers['content-length']) || totalBytes;
        pieceSize = getPieceSize(estimatedSize);
        totalPieces = Math.ceil(estimatedSize / pieceSize);
        
        // Create file entry immediately
        if (!fileCreated) {
          fileCreated = true;
          try {
            await db.createFile({
              id: fileId,
              filename: finalFilename,
              originalFilename: file.originalname,
              size: estimatedSize,
              pieceSize,
              totalPieces,
              mimeType: mimeTypes.lookup(file.originalname) || 'application/octet-stream',
              filePath: finalPath
            });
            
            // Create piece entries
            const dbPieces = [];
            for (let i = 0; i < totalPieces; i++) {
              const offset = i * pieceSize;
              const remainingBytes = estimatedSize - offset;
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
            piecesCreated = true;
            console.log(`[${fileId}] Created file entry and ${totalPieces} pieces`);
          } catch (err) {
            console.error(`[${fileId}] Error creating file entry:`, err);
          }
        }
      }
      
      // Accumulate chunks into pieces
      currentPiece = Buffer.concat([currentPiece, chunk]);
      
      // Process complete pieces as they're formed
      while (currentPiece.length >= pieceSize && piecesCreated) {
        const pieceData = currentPiece.slice(0, pieceSize);
        const hash = hashPiece(pieceData);
        
        // Mark piece as complete immediately
        const pieceIndex = currentPieceIndex;
        Promise.all([
          db.updatePieceHash(fileId, pieceIndex, hash),
          db.updatePieceComplete(fileId, pieceIndex, true)
        ]).then(() => {
          if (pieceIndex % 100 === 0) {
            console.log(`[${fileId}] Processed piece ${pieceIndex + 1}/${totalPieces} during upload`);
          }
        }).catch(err => {
          console.error(`[${fileId}] Error processing piece ${pieceIndex}:`, err);
        });
        
        currentPiece = currentPiece.slice(pieceSize);
        currentPieceIndex++;
        currentOffset += pieceSize;
      }
      
      // Write to disk
      writeStream.write(chunk);
    });
    
    file.stream.on('end', async () => {
      // Handle remaining data (last partial piece)
      if (currentPiece.length > 0 && piecesCreated) {
        const hash = hashPiece(currentPiece);
        const pieceIndex = currentPieceIndex;
        
        try {
          await Promise.all([
            db.updatePieceHash(fileId, pieceIndex, hash),
            db.updatePieceComplete(fileId, pieceIndex, true)
          ]);
          console.log(`[${fileId}] Processed final piece ${pieceIndex + 1}/${totalPieces}`);
        } catch (err) {
          console.error(`[${fileId}] Error processing final piece:`, err);
        }
      }
      
      writeStream.end();
      
      // Update file size with actual size
      try {
        await db.updateFile(fileId, { size: totalBytes });
      } catch (err) {
        console.error(`[${fileId}] Error updating file size:`, err);
      }
      
      cb(null, {
        destination: UPLOADS_DIR,
        filename: finalFilename,
        path: finalPath,
        size: totalBytes
      });
    });
    
    file.stream.on('error', (err) => {
      writeStream.destroy();
      cb(err);
    });
    
    writeStream.on('error', (err) => {
      cb(err);
    });
  }

  _removeFile(req, file, cb) {
    if (file.path) {
      fs.unlink(file.path, cb);
    } else {
      cb(null);
    }
  }
}

const upload = multer({ 
  storage: new StreamingProcessingStorage(),
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10GB limit
});

/**
 * Upload single or multiple files with streaming processing
 * Processes pieces as they're uploaded, not after upload completes
 */
router.post('/files', upload.array('files'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    
    // Calculate total size of files being uploaded
    const totalUploadSize = req.files.reduce((sum, f) => sum + f.size, 0);
    
    // Check storage space
    const storageCheck = await checkStorageSpace(totalUploadSize);
    if (!storageCheck.hasSpace) {
      // Clean up uploaded temp files
      for (const file of req.files) {
        try {
          await fs.unlink(file.path);
        } catch (err) {
          // Ignore cleanup errors
        }
      }
      return res.status(413).json({ 
        error: 'Storage limit exceeded',
        available: storageCheck.available,
        required: storageCheck.required,
        totalUsed: storageCheck.totalUsed,
        totalLimit: storageCheck.totalLimit
      });
    }
    
    const results = [];
    const processingPromises = [];
    
    for (const file of req.files) {
      // File has already been processed during upload by StreamingProcessingStorage
      // The fileId is in the filename (extracted from path)
      const fileId = path.basename(file.filename, path.extname(file.filename));
      const fileStats = await fs.stat(file.path);
      
      // Get file info from database (already created by storage)
      const dbFile = await db.getFileById(fileId);
      if (!dbFile) {
        console.error(`[${fileId}] File not found in database after upload`);
        continue;
      }
      
      // Return file info
      results.push({
        id: fileId,
        filename: file.originalname,
        size: fileStats.size,
        url: `/api/download/${fileId}`,
        pieceSize: dbFile.piece_size,
        totalPieces: dbFile.total_pieces
      });
    }
    
    res.json({ 
      success: true, 
      files: results 
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload directory (zip it first)
 */
router.post('/directory', upload.single('directory'), async (req, res) => {
  try {
    // This endpoint expects a zip file containing a directory
    // The frontend will zip the directory before sending
    if (!req.file) {
      return res.status(400).json({ error: 'No directory uploaded' });
    }
    
    // Check storage space
    const storageCheck = await checkStorageSpace(req.file.size);
    if (!storageCheck.hasSpace) {
      // Clean up uploaded temp file
      try {
        await fs.unlink(req.file.path);
      } catch (err) {
        // Ignore cleanup errors
      }
      return res.status(413).json({ 
        error: 'Storage limit exceeded',
        available: storageCheck.available,
        required: storageCheck.required,
        totalUsed: storageCheck.totalUsed,
        totalLimit: storageCheck.totalLimit
      });
    }
    
    const fileId = uuidv4();
    const finalFilename = `${fileId}.zip`;
    const finalPath = path.join(UPLOADS_DIR, finalFilename);
    
    // Move file to final location
    await fs.rename(req.file.path, finalPath);
    
    // Process file into pieces
    const { pieces, pieceSize, totalPieces, fileSize } = await processFile(finalPath);
    
    // Save to database
    await db.createFile({
      id: fileId,
      filename: finalFilename,
      originalFilename: req.body.originalName || 'directory.zip',
      size: fileSize,
      pieceSize,
      totalPieces,
      mimeType: 'application/zip',
      filePath: finalPath
    });
    
    // Save pieces to database
    const dbPieces = pieces.map(piece => ({
      fileId,
      pieceIndex: piece.pieceIndex,
      hash: piece.hash,
      size: piece.size,
      offset: piece.offset,
      isComplete: 1
    }));
    
    await db.createPieces(dbPieces);
    
    res.json({
      success: true,
      file: {
        id: fileId,
        filename: req.body.originalName || 'directory.zip',
        size: fileSize,
        url: `/api/download/${fileId}`,
        pieceSize,
        totalPieces
      }
    });
  } catch (error) {
    console.error('Directory upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload file in chunks (for large files)
 */
router.post('/chunk', async (req, res) => {
  try {
    const { fileId, pieceIndex, hash, data, filename, pieceSize, totalPieces, size, mimeType } = req.body;
    
    if (!fileId || pieceIndex === undefined || !hash || !data) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Decode base64 data
    const pieceData = Buffer.from(data, 'base64');
    
    // Verify hash
    const crypto = require('crypto');
    const actualHash = crypto.createHash('sha256').update(pieceData).digest('hex');
    
    if (actualHash !== hash) {
      return res.status(400).json({ error: 'Piece hash mismatch' });
    }
    
    // Check if file exists in database
    let file = await db.getFileById(fileId);
    
    if (!file) {
      // Create new file entry
      const fileExtension = path.extname(filename || '');
      const finalFilename = `${fileId}${fileExtension}`;
      const finalPath = path.join(UPLOADS_DIR, finalFilename);
      
      await db.createFile({
        id: fileId,
        filename: finalFilename,
        originalFilename: filename,
        size: size || 0,
        pieceSize: pieceSize || 256 * 1024,
        totalPieces: totalPieces || 1,
        mimeType: mimeType || 'application/octet-stream',
        filePath: finalPath
      });
      
      file = await db.getFileById(fileId);
    }
    
    // Write piece to file
    const fd = await fs.open(file.file_path, pieceIndex === 0 ? 'w' : 'r+');
    try {
      const offset = pieceIndex * file.piece_size;
      await fd.write(pieceData, 0, pieceData.length, offset);
    } finally {
      await fd.close();
    }
    
    // Update piece in database
    await db.updatePieceComplete(fileId, pieceIndex, true);
    
    // Check if all pieces are complete
    const pieces = await db.getPiecesByFileId(fileId);
    const allComplete = pieces.every(p => p.is_complete === 1);
    
    res.json({
      success: true,
      pieceIndex,
      allComplete,
      totalPieces: pieces.length
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Initialize chunked upload
 */
router.post('/chunk/init', async (req, res) => {
  try {
    const { filename, size, mimeType } = req.body;
    
    if (!filename || !size) {
      return res.status(400).json({ error: 'Missing filename or size' });
    }
    
    // Check storage space
    const storageCheck = await checkStorageSpace(parseInt(size));
    if (!storageCheck.hasSpace) {
      return res.status(413).json({ 
        error: 'Storage limit exceeded',
        available: storageCheck.available,
        required: storageCheck.required,
        totalUsed: storageCheck.totalUsed,
        totalLimit: storageCheck.totalLimit
      });
    }
    
    const fileId = uuidv4();
    const { getPieceSize } = require('../utils/chunking');
    const pieceSize = getPieceSize(size);
    const totalPieces = Math.ceil(size / pieceSize);
    
    const fileExtension = path.extname(filename);
    const finalFilename = `${fileId}${fileExtension}`;
    const finalPath = path.join(UPLOADS_DIR, finalFilename);
    
    // Create empty file
    await fs.writeFile(finalPath, Buffer.alloc(0));
    
    // Create file entry
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
    
    // Create piece entries (all incomplete initially)
    const pieces = [];
    for (let i = 0; i < totalPieces; i++) {
      const offset = i * pieceSize;
      const remainingBytes = size - offset;
      const currentPieceSize = Math.min(pieceSize, remainingBytes);
      
      pieces.push({
        fileId,
        pieceIndex: i,
        hash: '', // Will be set when piece is uploaded
        size: currentPieceSize,
        offset,
        isComplete: 0
      });
    }
    
    await db.createPieces(pieces);
    
    res.json({
      success: true,
      fileId,
      pieceSize,
      totalPieces
    });
  } catch (error) {
    console.error('Chunk init error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Manual reprocess endpoint for debugging
 * POST /api/upload/reprocess/:fileId
 */
router.post('/reprocess/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const file = await db.getFileById(fileId);
    
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    console.log(`[${fileId}] Manual reprocess requested`);
    
    const { processFile } = require('../utils/chunking');
    const { pieces } = await processFile(file.file_path, file.piece_size);
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const piece of pieces) {
      try {
        await Promise.all([
          db.updatePieceHash(fileId, piece.pieceIndex, piece.hash),
          db.updatePieceComplete(fileId, piece.pieceIndex, true)
        ]);
        successCount++;
      } catch (err) {
        console.error(`[${fileId}] Error updating piece ${piece.pieceIndex}:`, err);
        errorCount++;
      }
    }
    
    const finalPieces = await db.getPiecesByFileId(fileId);
    const completeCount = finalPieces.filter(p => p.is_complete === 1).length;
    
    res.json({
      success: true,
      processed: successCount,
      errors: errorCount,
      totalPieces: pieces.length,
      completePieces: completeCount
    });
  } catch (error) {
    console.error('Reprocess error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

