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

// Configure multer for temporary file storage
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10GB limit
});

/**
 * Upload single or multiple files
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
    
    for (const file of req.files) {
      // Check if file was pre-initialized (via chunk/init)
      // If so, use that fileId; otherwise create new one
      // Note: multer puts form fields in req.body, but fileId might be in the form data
      let fileId = req.body.fileId || (Array.isArray(req.body.fileId) ? req.body.fileId[0] : null);
      let existingFile = null;
      
      if (fileId) {
        existingFile = await db.getFileById(fileId);
      }
      
      if (!existingFile) {
        fileId = uuidv4();
      }
      
      const fileExtension = path.extname(file.originalname);
      const finalFilename = `${fileId}${fileExtension}`;
      const finalPath = path.join(UPLOADS_DIR, finalFilename);
      
      // Move file to final location
      await fs.rename(file.path, finalPath);
      
      // Wait a moment to ensure file is fully written to disk
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Get file size and determine piece size
      const fileStats = await fs.stat(finalPath);
      const fileSize = fileStats.size;
      const { getPieceSize } = require('../utils/chunking');
      const pieceSize = getPieceSize(fileSize);
      const totalPieces = Math.ceil(fileSize / pieceSize);
      
      // Create or update file entry
      if (!existingFile) {
        await db.createFile({
          id: fileId,
          filename: finalFilename,
          originalFilename: file.originalname,
          size: fileSize,
          pieceSize,
          totalPieces,
          mimeType: mimeTypes.lookup(file.originalname) || 'application/octet-stream',
          filePath: finalPath
        });
        
        // Create piece entries (initially incomplete)
        const dbPieces = [];
        for (let i = 0; i < totalPieces; i++) {
          const offset = i * pieceSize;
          const remainingBytes = fileSize - offset;
          const currentPieceSize = Math.min(pieceSize, remainingBytes);
          
          dbPieces.push({
            fileId,
            pieceIndex: i,
            hash: '', // Will be set during processing
            size: currentPieceSize,
            offset,
            isComplete: 0
          });
        }
        await db.createPieces(dbPieces);
      } else {
        // Update existing file entry with actual size
        await db.updateFile(fileId, {
          size: fileSize,
          pieceSize: pieceSize,
          totalPieces: totalPieces
        });
        
        // Check if pieces exist and match the expected count
        const existingPieces = await db.getPiecesByFileId(fileId);
        
        // If pieces don't exist or count doesn't match, recreate them
        if (existingPieces.length === 0 || existingPieces.length !== totalPieces) {
          console.log(`Recreating ${totalPieces} pieces for ${fileId} (had ${existingPieces.length})`);
          
          // Delete old pieces if they exist
          if (existingPieces.length > 0) {
            const sqlite3 = require('sqlite3').verbose();
            const path = require('path');
            const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
            const DB_PATH = path.join(DATA_DIR, 'files.db');
            const database = new sqlite3.Database(DB_PATH);
            
            await new Promise((resolve, reject) => {
              database.run(
                `DELETE FROM pieces WHERE file_id = ?`,
                [fileId],
                (err) => {
                  database.close();
                  if (err) reject(err);
                  else resolve();
                }
              );
            });
          }
          
          // Create new pieces
          const dbPieces = [];
          for (let i = 0; i < totalPieces; i++) {
            const offset = i * pieceSize;
            const remainingBytes = fileSize - offset;
            const currentPieceSize = Math.min(pieceSize, remainingBytes);
            
            dbPieces.push({
              fileId,
              pieceIndex: i,
              hash: '', // Will be set during processing
              size: currentPieceSize,
              offset,
              isComplete: 0
            });
          }
          await db.createPieces(dbPieces);
        } else {
          // Pieces exist and count matches
          // Don't reset them - if they're already complete, keep them complete
          // Only reset if we're sure this is a restart (which we can't easily detect)
          // Instead, let the background processing handle updating them
          console.log(`[${fileId}] Pieces already exist (${existingPieces.length}), will update during processing`);
        }
      }
      
      // Return immediately so file appears in list
      results.push({
        id: fileId,
        filename: file.originalname,
        size: fileSize,
        url: `/api/download/${fileId}`,
        pieceSize,
        totalPieces
      });
      
      // Process file into pieces incrementally as they become available
      // This allows pieces to be available for download progressively
      // Process pieces in parallel batches for faster availability
      (async () => {
        try {
          console.log(`[${fileId}] Starting incremental processing for file at ${finalPath}`);
          
          // Wait a moment for file to be fully written
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Verify pieces exist in database
          let dbPieces = await db.getPiecesByFileId(fileId);
          if (dbPieces.length === 0) {
            console.error(`[${fileId}] No pieces found in database!`);
            return;
          }
          
          // Process pieces incrementally using streaming
          const { processFileStream } = require('../utils/chunking');
          
          // Track processed pieces for logging
          let processedCount = 0;
          const BATCH_SIZE = 10; // Process 10 pieces in parallel at a time
          let currentBatch = [];
          
          // Use streaming processing - pieces are processed and marked complete as they're read
          await processFileStream(finalPath, pieceSize, async (piece) => {
            // Add to current batch
            currentBatch.push(piece);
            
            // When batch is full, process all pieces in parallel
            if (currentBatch.length >= BATCH_SIZE) {
              const batch = [...currentBatch];
              currentBatch = [];
              
              // Process batch in parallel (don't await - let it run in background)
              Promise.all(batch.map(async (p) => {
                try {
                  const [hashResult, completeResult] = await Promise.all([
                    db.updatePieceHash(fileId, p.pieceIndex, p.hash),
                    db.updatePieceComplete(fileId, p.pieceIndex, true)
                  ]);
                  
                  if (hashResult === 0 || completeResult === 0) {
                    console.warn(`[${fileId}] Piece ${p.pieceIndex} update returned 0 changes`);
                  } else {
                    processedCount++;
                    // Log progress every 100 pieces
                    if (processedCount % 100 === 0) {
                      console.log(`[${fileId}] Processed ${processedCount}/${totalPieces} pieces`);
                    }
                  }
                } catch (err) {
                  console.error(`[${fileId}] Error processing piece ${p.pieceIndex}:`, err);
                }
              })).catch(err => {
                console.error(`[${fileId}] Error in batch processing:`, err);
              });
            }
          });
          
          // Process any remaining pieces in the batch
          if (currentBatch.length > 0) {
            await Promise.all(currentBatch.map(async (p) => {
              try {
                const [hashResult, completeResult] = await Promise.all([
                  db.updatePieceHash(fileId, p.pieceIndex, p.hash),
                  db.updatePieceComplete(fileId, p.pieceIndex, true)
                ]);
                
                if (hashResult > 0 && completeResult > 0) {
                  processedCount++;
                }
              } catch (err) {
                console.error(`[${fileId}] Error processing piece ${p.pieceIndex}:`, err);
              }
            }));
          }
          
          // Wait a moment for all async processing to complete
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Final verification
          const finalPieces = await db.getPiecesByFileId(fileId);
          const finalCompleteCount = finalPieces.filter(p => p.is_complete === 1).length;
          console.log(`[${fileId}] Processing complete: ${finalCompleteCount}/${finalPieces.length} pieces marked complete`);
        } catch (err) {
          console.error(`[${fileId}] Error processing file:`, err);
          console.error(err.stack);
        }
      })();
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

