import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { UploadSession, ActiveUploadsMap } from './types';

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory state for active uploads
// fileId -> UploadSession
const activeUploads: ActiveUploadsMap = new Map();

// Directory for uploaded files
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../uploads');

/**
 * Get the file path for a given fileId.
 * Files are stored without extensions for simplicity.
 */
function getFilePath(fileId: string): string {
  return path.join(UPLOADS_DIR, fileId);
}

/**
 * Ensure the uploads directory exists.
 */
function ensureUploadsDir(): void {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

// Initialize uploads directory
ensureUploadsDir();

// Middleware: parse raw body for binary uploads
// We disable body parsing for upload routes to handle raw streams
app.use('/upload/:fileId', express.raw({ type: '*/*', limit: '10gb' }));

/**
 * Upload route: POST /upload/:fileId
 * 
 * Handles file uploads with live streaming to active downloaders.
 * 
 * Flow:
 * 1. Create a write stream to disk
 * 2. For each chunk received:
 *    - Write to disk
 *    - Increment uploadedBytes counter
 *    - Fan-out chunk to all active download responses
 * 3. On completion:
 *    - Close write stream
 *    - Mark session as completed
 *    - End all download responses
 *    - Remove session from map
 */
app.post('/upload/:fileId', (req: Request, res: Response) => {
  const { fileId } = req.params;

  // Validate fileId (basic sanitization)
  if (!fileId || fileId.includes('..') || fileId.includes('/')) {
    return res.status(400).json({ error: 'Invalid fileId' });
  }

  const filePath = getFilePath(fileId);

  // Ensure only one active upload per fileId
  if (activeUploads.has(fileId)) {
    return res.status(409).json({ 
      error: 'Upload already in progress for this fileId' 
    });
  }

  // Ensure uploads directory exists
  ensureUploadsDir();

  // Create write stream for the file
  const writeStream = fs.createWriteStream(filePath);

  // Create upload session
  const session: UploadSession = {
    filePath,
    writeStream,
    uploadedBytes: 0,
    completed: false,
    downloadResponses: new Set()
  };

  activeUploads.set(fileId, session);

  // Handle incoming data chunks
  req.on('data', (chunk: Buffer) => {
    try {
      // Update uploaded bytes counter
      session.uploadedBytes += chunk.length;

      // Write chunk to disk
      // Note: We don't await here - writeStream handles backpressure internally
      const canContinue = writeStream.write(chunk);

      // If writeStream's buffer is full, pause the request stream
      // This handles backpressure automatically
      if (!canContinue) {
        req.pause();
        writeStream.once('drain', () => {
          req.resume();
        });
      }

      // Fan-out chunk to all active download responses
      // This is the "live streaming" part - downloaders get chunks as they arrive
      for (const downloadRes of session.downloadResponses) {
        try {
          const canWrite = downloadRes.write(chunk);
          
          // Handle backpressure for download responses
          if (!canWrite) {
            // Pause the request stream if any download response is backed up
            // In a production system, you might want more sophisticated backpressure handling
            req.pause();
            downloadRes.once('drain', () => {
              req.resume();
            });
          }
        } catch (err) {
          // If a download response errors, remove it from the set
          console.error(`Error writing to download response for ${fileId}:`, err);
          session.downloadResponses.delete(downloadRes);
        }
      }
    } catch (err) {
      console.error(`Error processing chunk for ${fileId}:`, err);
      // Clean up on error
      writeStream.destroy(err as Error);
      for (const downloadRes of session.downloadResponses) {
        downloadRes.destroy(err as Error);
      }
      activeUploads.delete(fileId);
      res.status(500).json({ error: 'Upload processing failed' });
    }
  });

  // Handle upload completion
  req.on('end', () => {
    writeStream.end();
    session.completed = true;

    // End all active download responses
    // They've received all the data, so we can close them
    for (const downloadRes of session.downloadResponses) {
      try {
        downloadRes.end();
      } catch (err) {
        console.error(`Error ending download response for ${fileId}:`, err);
      }
    }

    // Clear the download responses set
    session.downloadResponses.clear();

    // Remove session from map
    activeUploads.delete(fileId);

    // Send success response to uploader
    res.json({ 
      status: 'ok', 
      uploadedBytes: session.uploadedBytes,
      fileId 
    });
  });

  // Handle upload errors
  req.on('error', (err: Error) => {
    console.error(`Upload error for ${fileId}:`, err);
    
    // Clean up write stream
    writeStream.destroy(err);

    // Clean up all download responses
    for (const downloadRes of session.downloadResponses) {
      try {
        downloadRes.destroy(err);
      } catch (destroyErr) {
        console.error(`Error destroying download response:`, destroyErr);
      }
    }

    // Remove session
    activeUploads.delete(fileId);

    // Try to delete partial file
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        console.error(`Error deleting partial file ${filePath}:`, unlinkErr);
      }
    });

    // Send error response (if response hasn't been sent)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Upload failed', details: err.message });
    }
  });

  // Handle client disconnect during upload
  req.on('close', () => {
    if (!session.completed) {
      console.log(`Upload cancelled for ${fileId}`);
      writeStream.destroy();
      activeUploads.delete(fileId);
      
      // Clean up download responses
      for (const downloadRes of session.downloadResponses) {
        downloadRes.destroy(new Error('Upload cancelled'));
      }
    }
  });
});

/**
 * Download route: GET /download/:fileId
 * 
 * Handles file downloads with support for:
 * 1. Live streaming while upload is in progress (catch-up + join live)
 * 2. Full file download if upload is complete
 * 3. 404 if file doesn't exist
 * 
 * Flow for active upload:
 * 1. If uploadedBytes > 0:
 *    - Create read stream from disk (0 to uploadedBytes-1)
 *    - Pipe to response with end: false
 *    - When read stream ends, add response to downloadResponses set
 *    - Response will now receive future chunks live from upload handler
 * 2. If uploadedBytes == 0:
 *    - Immediately add response to downloadResponses set
 *    - Response will receive all chunks live from upload handler
 * 3. When upload completes, upload handler calls res.end() for all downloaders
 * 
 * Flow for completed upload:
 * - Simply stream the full file from disk
 */
app.get('/download/:fileId', (req: Request, res: Response) => {
  const { fileId } = req.params;

  // Validate fileId
  if (!fileId || fileId.includes('..') || fileId.includes('/')) {
    return res.status(400).json({ error: 'Invalid fileId' });
  }

  const filePath = getFilePath(fileId);
  const session = activeUploads.get(fileId);

  // Set headers for binary file download
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${fileId}"`);
  res.setHeader('Cache-Control', 'no-cache');

  // Case 1: Upload is still in progress
  if (session && !session.completed) {
    const { uploadedBytes } = session;

    // Sub-case 1a: Some data already on disk - catch up first, then join live stream
    if (uploadedBytes > 0) {
      const readStream = fs.createReadStream(filePath, {
        start: 0,
        end: uploadedBytes - 1
      });

      // Pipe to response, but don't end the response when stream ends
      // We'll continue with live chunks after this
      readStream.pipe(res, { end: false });

      // When we've caught up with what's on disk, join the live stream
      readStream.on('end', () => {
        // Add this response to the set of active downloaders
        // Future chunks from the upload will be written to this response
        session.downloadResponses.add(res);

        // Handle client disconnect - remove from active downloaders
        res.on('close', () => {
          session.downloadResponses.delete(res);
        });

        // Handle errors on the response
        res.on('error', (err: Error) => {
          console.error(`Download response error for ${fileId}:`, err);
          session.downloadResponses.delete(res);
        });
      });

      // Handle read stream errors
      readStream.on('error', (err: Error) => {
        console.error(`Download read error for ${fileId}:`, err);
        session.downloadResponses.delete(res);
        
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error reading partially uploaded file' });
        } else {
          res.end();
        }
      });

      return;
    }

    // Sub-case 1b: No data on disk yet - join live stream immediately
    session.downloadResponses.add(res);

    // Handle client disconnect
    res.on('close', () => {
      session.downloadResponses.delete(res);
    });

    // Handle response errors
    res.on('error', (err: Error) => {
      console.error(`Download response error for ${fileId}:`, err);
      session.downloadResponses.delete(res);
    });

    return;
  }

  // Case 2: Upload is finished (or file was uploaded in the past)
  // Just stream the complete file from disk
  if (fs.existsSync(filePath)) {
    const readStream = fs.createReadStream(filePath);

    readStream.pipe(res);

    readStream.on('error', (err: Error) => {
      console.error(`Download read error for ${fileId}:`, err);
      
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error reading file' });
      } else {
        res.end();
      }
    });

    // Handle client disconnect during download
    res.on('close', () => {
      readStream.destroy();
    });

    return;
  }

  // Case 3: File doesn't exist
  res.status(404).json({ error: 'File not found' });
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    activeUploads: activeUploads.size,
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Uploads directory: ${UPLOADS_DIR}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  
  // Close all active uploads
  for (const [fileId, session] of activeUploads) {
    session.writeStream.end();
    for (const downloadRes of session.downloadResponses) {
      downloadRes.end();
    }
  }
  
  process.exit(0);
});

