const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const db = require('../database');

const router = express.Router();

/**
 * Download file by ID
 */
router.get('/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const { piece } = req.query;
    
    const file = await db.getFileById(fileId);
    
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // If requesting a specific piece
    if (piece !== undefined) {
      const pieceIndex = parseInt(piece);
      const pieces = await db.getPiecesByFileId(fileId);
      const requestedPiece = pieces.find(p => p.piece_index === pieceIndex);
      
      if (!requestedPiece) {
        return res.status(404).json({ error: 'Piece not found' });
      }
      
      // Check if piece is complete
      if (!requestedPiece.is_complete) {
        return res.status(206).json({ 
          error: 'Piece not yet available',
          pieceIndex,
          isComplete: false
        });
      }
      
      // Read and send piece - handle case where file might still be uploading
      try {
        const fd = await fs.open(file.file_path, 'r');
        try {
          const buffer = Buffer.alloc(requestedPiece.size);
          const bytesRead = await fd.read(buffer, 0, requestedPiece.size, requestedPiece.offset);
          
          // If we read less than expected, pad with zeros or return partial
          if (bytesRead.bytesRead < requestedPiece.size) {
            const partialBuffer = buffer.slice(0, bytesRead.bytesRead);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', bytesRead.bytesRead);
            res.setHeader('Content-Range', `bytes ${requestedPiece.offset}-${requestedPiece.offset + bytesRead.bytesRead - 1}/${file.size}`);
            res.status(206); // Partial content
            res.send(partialBuffer);
          } else {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', requestedPiece.size);
            res.setHeader('Content-Range', `bytes ${requestedPiece.offset}-${requestedPiece.offset + requestedPiece.size - 1}/${file.size}`);
            res.send(buffer);
          }
        } finally {
          await fd.close();
        }
      } catch (err) {
        // File might not exist yet or be locked - return 206 to indicate piece not ready
        if (err.code === 'ENOENT' || err.code === 'EBUSY') {
          return res.status(206).json({ 
            error: 'Piece not yet available',
            pieceIndex,
            isComplete: false
          });
        }
        throw err;
      }
      
      return;
    }
    
    // Check if file is still being processed (not all pieces complete)
    const pieces = await db.getPiecesByFileId(fileId);
    const completePieces = pieces.filter(p => p.is_complete === 1);
    const allComplete = completePieces.length === file.total_pieces && file.total_pieces > 0;
    
    // If file is not complete, stream available pieces and wait for more
    if (!allComplete && file.total_pieces > 0) {
      res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${file.original_filename || file.filename}"`);
      res.setHeader('Transfer-Encoding', 'chunked'); // Use chunked encoding for streaming
      res.setHeader('Cache-Control', 'no-cache');
      
      // Stream available pieces first
      const availablePieces = pieces
        .filter(p => p.is_complete === 1)
        .sort((a, b) => a.piece_index - b.piece_index);
      
      let streamedBytes = 0;
      
      // Stream all available pieces
      for (const piece of availablePieces) {
        try {
          const fd = await fs.open(file.file_path, 'r');
          try {
            const buffer = Buffer.alloc(piece.size);
            const readResult = await fd.read(buffer, 0, piece.size, piece.offset);
            
            if (readResult.bytesRead > 0) {
              res.write(buffer.slice(0, readResult.bytesRead));
              streamedBytes += readResult.bytesRead;
            }
          } finally {
            await fd.close();
          }
        } catch (err) {
          console.error(`Error streaming piece ${piece.piece_index}:`, err);
        }
      }
      
      // Now poll for new pieces and stream them as they become available
      const pollInterval = setInterval(async () => {
        try {
          // Check if client disconnected
          if (res.closed || res.destroyed) {
            clearInterval(pollInterval);
            return;
          }
          
          // Get updated piece status
          const updatedPieces = await db.getPiecesByFileId(fileId);
          const newCompletePieces = updatedPieces
            .filter(p => p.is_complete === 1 && p.piece_index >= availablePieces.length)
            .sort((a, b) => a.piece_index - b.piece_index);
          
          // Stream any new complete pieces
          for (const piece of newCompletePieces) {
            try {
              const fd = await fs.open(file.file_path, 'r');
              try {
                const buffer = Buffer.alloc(piece.size);
                const readResult = await fd.read(buffer, 0, piece.size, piece.offset);
                
                if (readResult.bytesRead > 0) {
                  res.write(buffer.slice(0, readResult.bytesRead));
                  streamedBytes += readResult.bytesRead;
                  availablePieces.push(piece);
                }
              } finally {
                await fd.close();
              }
            } catch (err) {
              console.error(`Error streaming new piece ${piece.piece_index}:`, err);
            }
          }
          
          // Check if all pieces are now complete
          const allPiecesNow = updatedPieces.filter(p => p.is_complete === 1).length;
          if (allPiecesNow === file.total_pieces) {
            clearInterval(pollInterval);
            res.end(); // Close the response
          }
        } catch (err) {
          console.error('Error polling for new pieces:', err);
          clearInterval(pollInterval);
          if (!res.headersSent || !res.closed) {
            res.end();
          }
        }
      }, 1000); // Poll every second
      
      // Clean up on client disconnect
      res.on('close', () => {
        clearInterval(pollInterval);
      });
      
      // Set a timeout to prevent hanging forever (e.g., 10 minutes)
      setTimeout(() => {
        clearInterval(pollInterval);
        if (!res.closed && !res.destroyed) {
          res.end();
        }
      }, 10 * 60 * 1000);
      
      return;
    }
    
    // Download entire file (all pieces complete)
    const fileStats = await fs.stat(file.file_path);
    
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.original_filename || file.filename}"`);
    res.setHeader('Content-Length', fileStats.size);
    res.setHeader('Accept-Ranges', 'bytes');
    
    // Support range requests
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileStats.size - 1;
      const chunksize = (end - start) + 1;
      
      const fd = await fs.open(file.file_path, 'r');
      try {
        const buffer = Buffer.alloc(chunksize);
        await fd.read(buffer, 0, chunksize, start);
        
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileStats.size}`);
        res.setHeader('Content-Length', chunksize);
        res.send(buffer);
      } finally {
        await fd.close();
      }
    } else {
      // Stream entire file
      const stream = fsSync.createReadStream(file.file_path);
      stream.pipe(res);
    }
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get file metadata
 */
router.get('/:fileId/info', async (req, res) => {
  try {
    const { fileId } = req.params;
    
    const file = await db.getFileById(fileId);
    
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const pieces = await db.getPiecesByFileId(fileId);
    const completePieces = pieces.filter(p => p.is_complete === 1).length;
    
    res.json({
      id: file.id,
      filename: file.original_filename || file.filename,
      size: file.size,
      pieceSize: file.piece_size,
      totalPieces: file.total_pieces,
      completePieces,
      mimeType: file.mime_type,
      createdAt: file.created_at,
      pieces: pieces.map(p => ({
        index: p.piece_index,
        hash: p.hash,
        size: p.size,
        offset: p.offset,
        isComplete: p.is_complete === 1
      }))
    });
  } catch (error) {
    console.error('File info error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

