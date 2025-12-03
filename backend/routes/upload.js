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
    // Get fileId from request if it was pre-initialized via chunk/init
    // For multiple files, each file should have its own fileId in the form data
    // Multer puts form fields in req.body, but for multiple files we need to match by filename
    let fileId = null;
    
    // Try to get fileId from form data (frontend sends it via FormData)
    // For multiple files, we might need to match by filename
    if (req.body && typeof req.body === 'object') {
      // Check if there's a fileId field
      fileId = req.body.fileId;
      // If it's an array (multiple files), try to match by index or use first
      if (Array.isArray(fileId)) {
        fileId = fileId[0]; // Use first fileId for now
      }
    }
    
    // If no fileId provided, generate a new one
    if (!fileId) {
      fileId = uuidv4();
    }
    
    const fileExtension = path.extname(file.originalname);
    const finalFilename = `${fileId}${fileExtension}`;
    const finalPath = path.join(UPLOADS_DIR, finalFilename);
    
    // Store fileId in file object for later retrieval
    file.fileId = fileId;
    
    // Create write stream
    const writeStream = require('fs').createWriteStream(finalPath);
    const { getPieceSize, hashPiece } = require('../utils/chunking');
    
    let totalBytes = 0;
    let pieceSize = null;
    let totalPieces = 0;
    let currentPiece = Buffer.alloc(0);
    let currentPieceIndex = 0;
    let fileCreated = false;
    let piecesCreated = false;
    
    // Check if file already exists in database (from chunk/init) - do this synchronously if possible
    // But we need to handle async, so use a promise that resolves before processing starts
    const fileSetupPromise = (async () => {
      try {
        const existingFile = await db.getFileById(fileId);
        
        if (existingFile) {
          // File was pre-initialized, use existing piece size
          pieceSize = existingFile.piece_size;
          totalPieces = existingFile.total_pieces;
          piecesCreated = true;
          fileCreated = true;
          console.log(`[${fileId}] Using existing file entry with ${totalPieces} pieces`);
          return { pieceSize, totalPieces };
        } else {
          // New file - use a reasonable initial estimate
          // For multipart uploads, we don't know the total size upfront
          const INITIAL_ESTIMATE = 100 * 1024 * 1024; // 100MB initial estimate
          
          // Start with initial estimate
          const newPieceSize = getPieceSize(INITIAL_ESTIMATE);
          const newTotalPieces = Math.ceil(INITIAL_ESTIMATE / newPieceSize);
          
          await db.createFile({
            id: fileId,
            filename: finalFilename,
            originalFilename: file.originalname,
            size: INITIAL_ESTIMATE, // Will be updated later
            pieceSize: newPieceSize,
            totalPieces: newTotalPieces,
            mimeType: mimeTypes.lookup(file.originalname) || 'application/octet-stream',
            filePath: finalPath
          });
          
          // Create piece entries with initial estimate
          const dbPieces = [];
          for (let i = 0; i < newTotalPieces; i++) {
            const offset = i * newPieceSize;
            const remainingBytes = INITIAL_ESTIMATE - offset;
            const currentPieceSize = Math.min(newPieceSize, remainingBytes);
            
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
          pieceSize = newPieceSize;
          totalPieces = newTotalPieces;
          piecesCreated = true;
          fileCreated = true;
          console.log(`[${fileId}] Created file entry and ${totalPieces} pieces (initial estimate)`);
          return { pieceSize: newPieceSize, totalPieces: newTotalPieces };
        }
      } catch (err) {
        console.error(`[${fileId}] Error creating/checking file entry:`, err);
        cb(err);
        throw err;
      }
    })();
    
    // Set up data handler immediately - it will check piecesCreated before processing
    file.stream.on('data', (chunk) => {
      totalBytes += chunk.length;
      
      // Wait for file setup if not ready yet, then process
      fileSetupPromise.then(() => {
        // Update piece size if needed based on actual size (only if we started with estimate)
        if (fileCreated && totalBytes > 100 * 1024 * 1024) {
          const newPieceSize = getPieceSize(totalBytes);
          const newTotalPieces = Math.ceil(totalBytes / newPieceSize);
          
          // Only update if piece size changed significantly
          if (newPieceSize !== pieceSize) {
            pieceSize = newPieceSize;
            totalPieces = newTotalPieces;
            
            // Update file entry
            db.updateFile(fileId, {
              pieceSize: newPieceSize,
              totalPieces: newTotalPieces,
              size: totalBytes
            }).catch(err => {
              console.error(`[${fileId}] Error updating file size:`, err);
            });
            
            // Add more pieces if needed
            db.getPiecesByFileId(fileId).then(existingPieces => {
              if (existingPieces.length < newTotalPieces) {
                const newPieces = [];
                for (let i = existingPieces.length; i < newTotalPieces; i++) {
                  const offset = i * pieceSize;
                  const remainingBytes = totalBytes - offset;
                  const currentPieceSize = Math.min(pieceSize, remainingBytes);
                  
                  newPieces.push({
                    fileId,
                    pieceIndex: i,
                    hash: '',
                    size: currentPieceSize,
                    offset,
                    isComplete: 0
                  });
                }
                if (newPieces.length > 0) {
                  db.createPieces(newPieces).catch(err => {
                    console.error(`[${fileId}] Error creating additional pieces:`, err);
                  });
                }
              }
            });
          }
        }
        
        // Accumulate chunks into pieces
        currentPiece = Buffer.concat([currentPiece, chunk]);
        
        // Process complete pieces as they're formed - this happens DURING upload
        while (currentPiece.length >= pieceSize && piecesCreated) {
          const pieceData = currentPiece.slice(0, pieceSize);
          const hash = hashPiece(pieceData);
          
          // Mark piece as complete immediately (don't await - let it run in background)
          const pieceIndex = currentPieceIndex;
          Promise.all([
            db.updatePieceHash(fileId, pieceIndex, hash),
            db.updatePieceComplete(fileId, pieceIndex, true)
          ]).then(() => {
            if (pieceIndex % 100 === 0 || pieceIndex < 10) {
              console.log(`[${fileId}] Processed piece ${pieceIndex + 1} during upload (${totalBytes} bytes received)`);
            }
          }).catch(err => {
            console.error(`[${fileId}] Error processing piece ${pieceIndex}:`, err);
          });
          
          currentPiece = currentPiece.slice(pieceSize);
          currentPieceIndex++;
        }
      }).catch(err => {
        // File setup failed, but continue writing to disk
        console.error(`[${fileId}] File setup error, continuing upload:`, err);
      });
      
      // Always write to disk, even if setup isn't complete
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
      // The fileId is stored in the file object by the storage engine
      const fileId = file.fileId || path.basename(file.filename, path.extname(file.filename));
      const fileStats = await fs.stat(file.path);
      
      // Get file info from database (already created by storage)
      const dbFile = await db.getFileById(fileId);
      if (!dbFile) {
        console.error(`[${fileId}] File not found in database after upload`);
        continue;
      }
      
      // Update final file size
      if (fileStats.size !== dbFile.size) {
        await db.updateFile(fileId, { size: fileStats.size });
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

