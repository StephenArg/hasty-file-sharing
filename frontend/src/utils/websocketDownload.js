import wsClient from './websocketClient';

/**
 * Download file via WebSocket with .part file management
 */
export class WebSocketDownloadManager {
  constructor() {
    this.activeDownloads = new Map(); // fileId -> { fileHandle, partFileHandle, receivedChunks: Set, totalPieces, filename }
  }

  /**
   * Start or resume download
   */
  async startDownload(fileId, filename, onProgress, onComplete) {
    try {
      // Connect to WebSocket
      await wsClient.connect();

      // Check if download already in progress
      if (this.activeDownloads.has(fileId)) {
        console.log(`[${fileId}] Download already in progress`);
        return;
      }

      // Initialize download
      wsClient.send('DOWNLOAD_INIT', { fileId });

      // Set up message handlers
      const initHandler = async (payload) => {
        const { fileId: id, filename: fn, totalPieces, chunks, size } = payload;

        // Create .part file
        let partFileHandle = null;

        if (window.showSaveFilePicker) {
          try {
            // Try to get existing file handle from IndexedDB
            const db = await this.openDB();
            const tx = db.transaction(['downloads'], 'readonly');
            const store = tx.objectStore('downloads');
            const existing = await store.get(id);

            if (existing && existing.partFileHandle) {
              // Resume existing download - restore file handle from IndexedDB
              // Note: File handles can't be serialized, so we need to prompt again
              // but we can check if file exists and resume
              partFileHandle = await window.showSaveFilePicker({
                suggestedName: `${fn}.part`,
                types: [{
                  description: 'Partially Downloaded File',
                  accept: { 'application/octet-stream': ['.part'] }
                }]
              });
            } else {
              // Create new .part file
              partFileHandle = await window.showSaveFilePicker({
                suggestedName: `${fn}.part`,
                types: [{
                  description: 'Partially Downloaded File',
                  accept: { 'application/octet-stream': ['.part'] }
                }]
              });
            }
          } catch (err) {
            console.error('Error creating part file:', err);
            // User cancelled or error - fallback to IndexedDB
          }
        }

        // Track download
        const receivedChunks = new Set();
        const downloadInfo = {
          partFileHandle,
          receivedChunks,
          totalPieces,
          filename: fn,
          size,
          onProgress,
          onComplete
        };
        this.activeDownloads.set(id, downloadInfo);

        // Request all available chunks
        for (const chunk of chunks) {
          wsClient.send('DOWNLOAD_REQUEST', {
            fileId: id,
            chunkIndex: chunk.index
          });
        }

        // Save download info (without file handle - can't serialize)
        await this.saveDownloadInfo(id, {
          filename: fn,
          totalPieces,
          receivedChunks: Array.from(receivedChunks),
          size
        });
      };

      const chunkHandler = async (payload) => {
        const { fileId: id, chunkIndex, data, hash, size, offset } = payload;
        const download = this.activeDownloads.get(id);
        
        if (!download) {
          return;
        }

        // Check if chunk already received
        if (download.receivedChunks.has(chunkIndex)) {
          return;
        }

        // Decode base64 data - use more efficient method
        // Convert base64 to binary string, then to Uint8Array
        const binaryString = atob(data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Verify hash if provided (critical for data integrity)
        if (hash) {
          const { hashPiece } = await import('../utils/chunking');
          const actualHash = await hashPiece(bytes);
          if (actualHash !== hash) {
            console.error(`[${id}] Hash mismatch for chunk ${chunkIndex}. Expected: ${hash}, Got: ${actualHash}`);
            // Request chunk again - don't write corrupted chunk
            wsClient.send('DOWNLOAD_REQUEST', {
              fileId: id,
              chunkIndex: chunkIndex
            });
            return;
          }
        }

        // Write chunk to .part file at correct offset
        if (download.partFileHandle) {
          try {
            // Use File System Access API to write at specific offset
            const writable = await download.partFileHandle.createWritable({ keepExistingData: true });
            
            // Seek to offset and write using the correct API
            await writable.seek(offset);
            // Write the bytes directly (FileSystemWritableFileStream.write accepts Blob, BufferSource, or string)
            await writable.write(bytes);
            await writable.close();
            
            // Verify the write by reading back (optional, but helps catch issues)
            // Note: This adds overhead, so we'll rely on hash verification instead
          } catch (err) {
            console.error(`Error writing chunk ${chunkIndex} to file:`, err);
            // Fallback: store in IndexedDB
            await this.saveChunk(id, chunkIndex, bytes, offset);
          }
        } else {
          // Fallback: store in IndexedDB
          await this.saveChunk(id, chunkIndex, bytes, offset);
        }

        // Mark chunk as received
        download.receivedChunks.add(chunkIndex);

        // Update progress
        const progress = (download.receivedChunks.size / download.totalPieces) * 100;
        if (download.onProgress) {
          download.onProgress({
            fileId: id,
            progress: Math.round(progress),
            receivedChunks: download.receivedChunks.size,
            totalPieces: download.totalPieces
          });
        }

        // Save download info (without file handle - can't serialize)
        await this.saveDownloadInfo(id, {
          filename: download.filename,
          totalPieces: download.totalPieces,
          receivedChunks: Array.from(download.receivedChunks),
          size: download.size
        });

        // Check if download is complete
        if (download.receivedChunks.size === download.totalPieces) {
          await this.completeDownload(id, download);
        }
      };

      wsClient.on('DOWNLOAD_INIT_SUCCESS', initHandler);
      wsClient.on('DOWNLOAD_CHUNK', chunkHandler);

      // Store handlers for cleanup
      const download = this.activeDownloads.get(fileId);
      if (download) {
        download.handlers = { initHandler, chunkHandler };
      }
    } catch (err) {
      console.error('Download error:', err);
      throw err;
    }
  }

  /**
   * Complete download - rename .part to final filename
   */
  async completeDownload(fileId, download) {
    try {
      if (download.partFileHandle) {
        // Get directory handle
        const directoryHandle = await download.partFileHandle.getParent();
        
        // Read the complete .part file
        const partFile = await download.partFileHandle.getFile();
        const fileData = await partFile.arrayBuffer();
        
        // Create final file
        const finalFileHandle = await directoryHandle.getFileHandle(download.filename, { create: true });
        const writable = await finalFileHandle.createWritable();
        await writable.write(fileData);
        await writable.close();
        
        // Delete .part file
        try {
          await directoryHandle.removeEntry(download.partFileHandle.name);
        } catch (err) {
          console.warn(`Could not delete .part file:`, err);
        }

        // Clean up
        this.activeDownloads.delete(fileId);
        await this.deleteDownloadInfo(fileId);

        if (download.onComplete) {
          download.onComplete(fileId);
        }

        console.log(`[${fileId}] Download complete: ${download.filename}`);
      } else {
        // IndexedDB fallback - assemble file from chunks
        await this.assembleFileFromChunks(fileId, download);
      }
    } catch (err) {
      console.error(`[${fileId}] Error completing download:`, err);
    }
  }

  /**
   * Assemble file from IndexedDB chunks
   */
  async assembleFileFromChunks(fileId, download) {
    try {
      const db = await this.openDB();
      const tx = db.transaction(['chunks'], 'readonly');
      const store = tx.objectStore('chunks');
      const index = store.index('fileId');
      
      const request = index.getAll(fileId);
      const chunks = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });

      // Sort chunks by index
      chunks.sort((a, b) => a.pieceIndex - b.pieceIndex);

      // Create blob from chunks
      const blobParts = chunks.map(c => c.data);
      const blob = new Blob(blobParts, { type: 'application/octet-stream' });

      // Download blob
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = download.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Clean up
      this.activeDownloads.delete(fileId);
      await this.deleteDownloadInfo(fileId);
      await this.deleteChunks(fileId);

      if (download.onComplete) {
        download.onComplete(fileId);
      }
    } catch (err) {
      console.error(`[${fileId}] Error assembling file:`, err);
    }
  }

  /**
   * Open IndexedDB
   */
  openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('HastyFileSend', 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('downloads')) {
          db.createObjectStore('downloads', { keyPath: 'fileId' });
        }
        if (!db.objectStoreNames.contains('chunks')) {
          const chunkStore = db.createObjectStore('chunks', { keyPath: ['fileId', 'pieceIndex'] });
          chunkStore.createIndex('fileId', 'fileId', { unique: false });
        }
      };
    });
  }

  /**
   * Save download info
   */
  async saveDownloadInfo(fileId, info) {
    try {
      const db = await this.openDB();
      const tx = db.transaction(['downloads'], 'readwrite');
      const store = tx.objectStore('downloads');
      await store.put({ fileId, ...info });
    } catch (err) {
      console.error('Error saving download info:', err);
    }
  }

  /**
   * Save chunk to IndexedDB
   */
  async saveChunk(fileId, pieceIndex, data, offset) {
    try {
      const db = await this.openDB();
      const tx = db.transaction(['chunks'], 'readwrite');
      const store = tx.objectStore('chunks');
      await store.put({
        fileId,
        pieceIndex,
        data,
        offset,
        downloadedAt: Date.now()
      });
    } catch (err) {
      console.error('Error saving chunk:', err);
    }
  }

  /**
   * Delete download info
   */
  async deleteDownloadInfo(fileId) {
    try {
      const db = await this.openDB();
      const tx = db.transaction(['downloads'], 'readwrite');
      const store = tx.objectStore('downloads');
      await store.delete(fileId);
    } catch (err) {
      console.error('Error deleting download info:', err);
    }
  }

  /**
   * Delete chunks
   */
  async deleteChunks(fileId) {
    try {
      const db = await this.openDB();
      const tx = db.transaction(['chunks'], 'readwrite');
      const store = tx.objectStore('chunks');
      const index = store.index('fileId');
      
      const request = index.openKeyCursor(IDBKeyRange.only(fileId));
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
    } catch (err) {
      console.error('Error deleting chunks:', err);
    }
  }

  /**
   * Cancel download
   */
  async cancelDownload(fileId) {
    if (this.activeDownloads.has(fileId)) {
      const download = this.activeDownloads.get(fileId);
      
      // Remove handlers
      if (download.handlers) {
        wsClient.off('DOWNLOAD_INIT_SUCCESS', download.handlers.initHandler);
        wsClient.off('DOWNLOAD_CHUNK', download.handlers.chunkHandler);
      }

      // Send cancel message
      wsClient.send('DOWNLOAD_CANCEL', { fileId });

      this.activeDownloads.delete(fileId);
    }
  }
}

// Singleton instance
export const wsDownloadManager = new WebSocketDownloadManager();

