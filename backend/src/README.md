# Live Streaming File Upload/Download Server

## Architecture Overview

This server implements a live streaming file upload/download mechanism where clients can start downloading files **while they are still being uploaded**.

### Key Concepts

1. **Upload Sessions**: Each active upload is tracked in memory with:
   - Write stream to disk
   - Counter of uploaded bytes
   - Set of active download responses

2. **Live Streaming**: As chunks arrive during upload:
   - Chunk is written to disk
   - Chunk is simultaneously written to all active download responses
   - This enables "live" downloads

3. **Catch-up Mechanism**: When a download starts mid-upload:
   - First, stream what's already on disk (0 to uploadedBytes-1)
   - Then, join the live stream for future chunks
   - This ensures downloaders get the complete file

## Flow Diagrams

### Upload Flow
```
Client → POST /upload/:fileId
  ↓
Create write stream to disk
  ↓
For each chunk:
  ├─ Write to disk
  ├─ Increment uploadedBytes
  └─ Fan-out to all downloadResponses
  ↓
On completion:
  ├─ Close write stream
  ├─ End all download responses
  └─ Remove from activeUploads
```

### Download Flow (Active Upload)
```
Client → GET /download/:fileId
  ↓
Check if session exists
  ↓
If uploadedBytes > 0:
  ├─ Read stream from disk (0 to uploadedBytes-1)
  ├─ Pipe to response (end: false)
  └─ On read stream end: Add response to downloadResponses
  ↓
If uploadedBytes == 0:
  └─ Immediately add response to downloadResponses
  ↓
Response now receives future chunks live from upload handler
```

### Download Flow (Completed Upload)
```
Client → GET /download/:fileId
  ↓
Check if file exists on disk
  ↓
Stream full file with fs.createReadStream().pipe(res)
```

## Gotchas & Considerations

### 1. Backpressure Handling

**Issue**: If download responses can't keep up with upload speed, memory can fill up.

**Solution**: 
- Use `writeStream.write()` return value to detect when buffer is full
- Pause the request stream when write stream is backed up
- Resume when write stream drains
- Similar logic for download responses

**Note**: The current implementation pauses the entire upload if any download response is backed up. In production, you might want to:
- Buffer chunks per downloader
- Drop slow downloaders
- Implement per-downloader backpressure

### 2. Memory Usage

**Issue**: Keeping all chunks in memory for fan-out can be problematic for large files.

**Current Approach**: 
- Chunks are written to disk immediately
- Chunks are written to download responses immediately
- No buffering in memory (except Node.js stream buffers)

**Considerations**:
- For many simultaneous downloaders, memory usage scales with number of downloaders
- Each downloader has its own response buffer
- Monitor memory usage in production

### 3. Multiple Uploaders per fileId

**Current Behavior**: Only one active upload per fileId (409 Conflict).

**Why**: 
- Prevents race conditions
- Simplifies state management
- Ensures data integrity

**Alternative**: Could implement upload resumption or chunked uploads with versioning.

### 4. Client Disconnects

**Handled**:
- Upload disconnect: Clean up write stream, remove session, delete partial file
- Download disconnect: Remove from downloadResponses set

**Edge Cases**:
- What if upload completes while a downloader is catching up from disk?
  - The upload handler will call `res.end()` when upload completes
  - If downloader is still reading from disk, the `end()` call will close the response after the read stream finishes
  - This is handled by the `end: false` option in `pipe()`

### 5. File System Errors

**Handled**:
- Write stream errors: Clean up session, notify downloaders
- Read stream errors: Remove from downloadResponses, send error response
- Disk full: Write stream will error, handled by error handler

### 6. Race Conditions

**Potential Issue**: Download starts right as upload completes.

**Current Behavior**:
- If download checks `activeUploads.get(fileId)` and finds nothing, it falls back to reading from disk
- This is safe because the upload handler removes the session AFTER ending all download responses
- Small window where a new download might miss the session, but will get the complete file from disk

### 7. Production Considerations

**Missing Features** (for production):
- Authentication/authorization
- File size limits
- Rate limiting
- File metadata (name, size, mime type)
- Cleanup of old files
- Persistence of upload state (survives server restart)
- Monitoring and logging
- CORS configuration
- HTTPS/TLS

**Performance Optimizations**:
- Use `fs.promises` for async file operations
- Consider using streams with backpressure for very large files
- Implement connection pooling for many concurrent downloads
- Add compression for text files
- Consider CDN integration for completed files

## Testing

### Test Upload While Downloading

```bash
# Terminal 1: Start upload (simulate slow upload)
curl -X POST http://localhost:3000/upload/test123 --data-binary @largefile.bin

# Terminal 2: Start download immediately (while upload is in progress)
curl http://localhost:3000/download/test123 -o downloaded.bin

# Both should complete successfully
```

### Test Completed File Download

```bash
# Wait for upload to complete, then download
curl http://localhost:3000/download/test123 -o downloaded.bin
```

## TypeScript Types

All types are defined in `src/types.ts`:
- `UploadSession`: Interface for upload session state
- `ActiveUploadsMap`: Type alias for the in-memory map

