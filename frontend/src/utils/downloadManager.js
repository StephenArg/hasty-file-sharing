// Download Manager for progressive chunk downloading
class DownloadManager {
  constructor() {
    this.downloads = new Map();
    this.loadDownloadsFromStorage();
  }

  // Load saved downloads from IndexedDB
  async loadDownloadsFromStorage() {
    try {
      const db = await this.openDB();
      const tx = db.transaction(['downloads'], 'readonly');
      const store = tx.objectStore('downloads');
      
      // getAll() returns a promise, need to await it
      const request = store.getAll();
      const allDownloads = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      
      if (Array.isArray(allDownloads)) {
        allDownloads.forEach(download => {
          if (download && download.fileId) {
            this.downloads.set(download.fileId, download);
          }
        });
      }
    } catch (err) {
      console.error('Error loading downloads:', err);
    }
  }

  // Open IndexedDB
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

  // Save download info to IndexedDB
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

  // Save chunk to IndexedDB
  async saveChunk(fileId, pieceIndex, chunkData) {
    try {
      const db = await this.openDB();
      const tx = db.transaction(['chunks'], 'readwrite');
      const store = tx.objectStore('chunks');
      await store.put({
        fileId,
        pieceIndex,
        data: chunkData,
        downloadedAt: Date.now()
      });
    } catch (err) {
      console.error('Error saving chunk:', err);
    }
  }

  // Get downloaded chunks for a file
  async getDownloadedChunks(fileId) {
    try {
      const db = await this.openDB();
      const tx = db.transaction(['chunks'], 'readonly');
      const store = tx.objectStore('chunks');
      const index = store.index('fileId');
      
      // Use request pattern for getAll
      const request = index.getAll(fileId);
      const chunks = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      
      if (Array.isArray(chunks)) {
        return chunks.map(c => c.pieceIndex).sort((a, b) => a - b);
      }
      return [];
    } catch (err) {
      console.error('Error getting chunks:', err);
      return [];
    }
  }

  // Start or resume a download
  async startDownload(fileId, filename, fileInfo, onProgress) {
    // Check if download already exists
    let download = this.downloads.get(fileId);
    
    if (!download) {
      // Request file system access for .part file
      let fileHandle = null;
      let infoFileHandle = null;

      if (window.showSaveFilePicker) {
        try {
          // Create .part file - user selects location
          const partFilename = `${filename}.part`;
          fileHandle = await window.showSaveFilePicker({
            suggestedName: partFilename,
            types: [{
              description: 'Downloading File',
              accept: { 'application/octet-stream': ['.part'] }
            }]
          });

          // Try to create .dwnldinfo file in same directory
          try {
            const parent = await fileHandle.getParent();
            const infoFilename = `${filename}.dwnldinfo`;
            infoFileHandle = await parent.getFileHandle(infoFilename, { create: true });
          } catch (err) {
            console.warn('Could not create .dwnldinfo file, using IndexedDB:', err);
            // Will fall back to IndexedDB for download info
          }
        } catch (err) {
          if (err.name !== 'AbortError') {
            console.error('Error requesting file access:', err);
          }
          // Continue without file handles (will use IndexedDB fallback)
        }
      }

      download = {
        fileId,
        filename,
        totalPieces: fileInfo.totalPieces,
        pieceSize: fileInfo.pieceSize,
        fileSize: fileInfo.size,
        downloadedPieces: [],
        status: 'downloading',
        startedAt: Date.now(),
        fileHandle,
        infoFileHandle
      };
      this.downloads.set(fileId, download);
      await this.saveDownloadInfo(fileId, download);

      // Initialize .dwnldinfo file
      if (infoFileHandle) {
        await this.updateDownloadInfoFile(infoFileHandle, download);
      }
    }

    // Get already downloaded pieces
    const downloadedPieces = await this.getDownloadedChunks(fileId);
    download.downloadedPieces = downloadedPieces;

    // Download missing pieces
    await this.downloadPieces(fileId, fileInfo, download, onProgress);

    return download;
  }

  // Download pieces
  async downloadPieces(fileId, fileInfo, download, onProgress) {
    const pieces = fileInfo.pieces || [];
    const availablePieces = pieces.filter(p => p.isComplete);
    const missingPieces = availablePieces.filter(p => !download.downloadedPieces.includes(p.index));

    if (missingPieces.length === 0 && download.downloadedPieces.length < fileInfo.totalPieces) {
      // All available pieces downloaded, but file not complete - wait and retry
      if (onProgress) {
        onProgress({
          ...download,
          status: 'waiting',
          message: 'Waiting for more pieces...'
        });
      }
      return;
    }

    // Download missing pieces
    for (const piece of missingPieces) {
      try {
        const response = await fetch(`/api/download/${fileId}?piece=${piece.index}`);
        if (response.ok) {
          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();
          
          // Save to IndexedDB
          await this.saveChunk(fileId, piece.index, arrayBuffer);
          
          // Write to file system if file handle exists
          if (download.fileHandle && piece.offset !== undefined) {
            try {
              await this.writeChunkToFile(download.fileHandle, piece.index, piece.offset, new Uint8Array(arrayBuffer));
            } catch (err) {
              console.error(`Error writing chunk ${piece.index} to file:`, err);
            }
          }
          
          download.downloadedPieces.push(piece.index);
          download.downloadedPieces.sort((a, b) => a - b);
          
          await this.saveDownloadInfo(fileId, download);
          
          // Update .dwnldinfo file
          if (download.infoFileHandle) {
            await this.updateDownloadInfoFile(download.infoFileHandle, download);
          }

          if (onProgress) {
            const progress = fileInfo.totalPieces > 0 
              ? (download.downloadedPieces.length / fileInfo.totalPieces) * 100 
              : 0;
            onProgress({
              ...download,
              progress: Math.min(100, Math.max(0, progress)),
              status: 'downloading',
              message: `Downloaded ${download.downloadedPieces.length}/${fileInfo.totalPieces} pieces`
            });
          }
          
          // Save progress update
          await this.saveDownloadInfo(fileId, download);
        }
      } catch (err) {
        console.error(`Error downloading piece ${piece.index}:`, err);
      }
    }

    // Check if download is complete
    if (download.downloadedPieces.length === fileInfo.totalPieces && fileInfo.totalPieces > 0) {
      await this.assembleFile(fileId, download, fileInfo);
    } else {
      // Schedule next check for more pieces (even if file is still being processed)
      setTimeout(() => {
        this.checkForNewPieces(fileId, fileInfo, download, onProgress);
      }, 2000);
    }
  }

  // Check for new pieces
  async checkForNewPieces(fileId, fileInfo, download, onProgress) {
    try {
      const response = await fetch(`/api/download/${fileId}/info`);
      const updatedInfo = await response.json();
      
      // Update progress based on available pieces
      if (onProgress && updatedInfo.totalPieces > 0) {
        const currentProgress = (download.downloadedPieces.length / updatedInfo.totalPieces) * 100;
        onProgress({
          ...download,
          progress: Math.min(100, Math.max(0, currentProgress)),
          status: updatedInfo.completePieces > download.downloadedPieces.length ? 'downloading' : 'waiting',
          message: updatedInfo.completePieces > download.downloadedPieces.length 
            ? `Downloaded ${download.downloadedPieces.length}/${updatedInfo.totalPieces} pieces` 
            : `Waiting for more pieces... (${updatedInfo.completePieces}/${updatedInfo.totalPieces} available)`
        });
      }
      
      if (updatedInfo.completePieces > download.downloadedPieces.length) {
        await this.downloadPieces(fileId, updatedInfo, download, onProgress);
      }
    } catch (err) {
      console.error('Error checking for new pieces:', err);
      if (onProgress) {
        onProgress({
          ...download,
          status: 'error',
          message: `Error: ${err.message}`
        });
      }
    }
  }

  // Save download info to file system (using File System Access API if available)
  async saveDownloadInfoToFile(fileId, filename, info) {
    if (!window.showSaveFilePicker) {
      // Fallback: save to IndexedDB only
      return null;
    }

    try {
      // Try to get existing file handle from IndexedDB
      const db = await this.openDB();
      const tx = db.transaction(['downloads'], 'readonly');
      const store = tx.objectStore('downloads');
      const existing = await store.get(fileId);
      
      if (existing && existing.infoFileHandle) {
        return existing.infoFileHandle;
      }

      // Create new file handle for .dwnldinfo file
      const infoFilename = `${filename}.dwnldinfo`;
      const fileHandle = await window.showSaveFilePicker({
        suggestedName: infoFilename,
        types: [{
          description: 'Download Info',
          accept: { 'application/json': ['.dwnldinfo'] }
        }]
      });

      // Save file handle reference
      const downloadData = await store.get(fileId) || { fileId };
      downloadData.infoFileHandle = fileHandle;
      const writeTx = db.transaction(['downloads'], 'readwrite');
      const writeStore = writeTx.objectStore('downloads');
      await writeStore.put(downloadData);

      return fileHandle;
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Error saving download info file:', err);
      }
      return null;
    }
  }

  // Write chunk to file system
  async writeChunkToFile(fileHandle, pieceIndex, offset, chunkData) {
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    await writable.seek(offset);
    await writable.write(chunkData);
    await writable.close();
  }

  // Update download info file
  async updateDownloadInfoFile(infoFileHandle, download) {
    if (!infoFileHandle) return;
    
    const infoData = {
      fileId: download.fileId,
      filename: download.filename,
      downloadedPieces: download.downloadedPieces,
      totalPieces: download.totalPieces,
      status: download.status,
      updatedAt: Date.now()
    };

    const writable = await infoFileHandle.createWritable();
    await writable.write(JSON.stringify(infoData, null, 2));
    await writable.close();
  }

  // Assemble file from chunks
  async assembleFile(fileId, download, fileInfo) {
    try {
      const db = await this.openDB();
      const tx = db.transaction(['chunks'], 'readonly');
      const store = tx.objectStore('chunks');
      const index = store.index('fileId');
      
      // Use request pattern for getAll
      const request = index.getAll(fileId);
      let chunks = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      
      // Sort chunks by piece index
      if (!Array.isArray(chunks)) {
        chunks = [];
      }
      chunks.sort((a, b) => a.pieceIndex - b.pieceIndex);
      
      // Check if we have file handles (File System Access API)
      const downloadData = await db.transaction(['downloads'], 'readonly')
        .objectStore('downloads')
        .get(fileId);
      
      const fileHandle = downloadData?.fileHandle;
      const infoFileHandle = downloadData?.infoFileHandle;

      if (fileHandle && window.FileSystemWritableFileStream) {
        // Use File System Access API - write directly to file
        const writable = await fileHandle.createWritable();
        
        // Write chunks in order
        for (const chunk of chunks) {
          const pieceInfo = fileInfo.pieces.find(p => p.index === chunk.pieceIndex);
          if (pieceInfo) {
            await writable.seek(pieceInfo.offset);
            await writable.write(new Uint8Array(chunk.data));
          }
        }
        
        await writable.close();

        // Delete .dwnldinfo file
        if (infoFileHandle) {
          try {
            await infoFileHandle.remove();
          } catch (err) {
            console.error('Error removing info file:', err);
          }
        }

        // Note: File System Access API doesn't support direct rename
        // The file will remain as .part - user can rename it manually
        // Or we can prompt to save with final name
        try {
          // Read the complete file
          const partFile = await fileHandle.getFile();
          const partContent = await partFile.arrayBuffer();
          
          // Prompt user to save with final name
          const finalHandle = await window.showSaveFilePicker({
            suggestedName: download.filename,
            types: [{
              description: 'Downloaded File',
              accept: { 'application/octet-stream': [download.filename.split('.').pop()] }
            }]
          });
          
          const finalWritable = await finalHandle.createWritable();
          await finalWritable.write(partContent);
          await finalWritable.close();
          
          // Remove .part file
          await fileHandle.remove();
        } catch (err) {
          if (err.name !== 'AbortError') {
            console.error('Error saving final file:', err);
          }
          // File remains as .part - user can rename manually
        }
      } else {
        // Fallback: Use Blob download
        const blobParts = chunks.map(c => c.data);
        const completeBlob = new Blob(blobParts, { type: fileInfo.mimeType || 'application/octet-stream' });
        
        const url = URL.createObjectURL(completeBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = download.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      // Clean up
      download.status = 'completed';
      await this.saveDownloadInfo(fileId, download);
      
      // Delete chunks from IndexedDB
      const deleteTx = db.transaction(['chunks'], 'readwrite');
      const deleteStore = deleteTx.objectStore('chunks');
      for (const chunk of chunks) {
        await deleteStore.delete([fileId, chunk.pieceIndex]);
      }
      
      // Delete download info
      const infoTx = db.transaction(['downloads'], 'readwrite');
      const infoStore = infoTx.objectStore('downloads');
      await infoStore.delete(fileId);
      
      this.downloads.delete(fileId);
      
      return true;
    } catch (err) {
      console.error('Error assembling file:', err);
      download.status = 'error';
      download.error = err.message;
      await this.saveDownloadInfo(fileId, download);
      return false;
    }
  }

  // Get download status
  getDownloadStatus(fileId) {
    return this.downloads.get(fileId);
  }

  // Cancel download
  async cancelDownload(fileId) {
    const download = this.downloads.get(fileId);
    if (download) {
      download.status = 'cancelled';
      await this.saveDownloadInfo(fileId, download);
      
      // Optionally delete chunks
      try {
        const db = await this.openDB();
        const tx = db.transaction(['chunks'], 'readwrite');
        const store = tx.objectStore('chunks');
        const index = store.index('fileId');
        
        const request = index.getAll(fileId);
        const chunks = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
        });
        
        if (Array.isArray(chunks)) {
          for (const chunk of chunks) {
            await store.delete([fileId, chunk.pieceIndex]);
          }
        }
      } catch (err) {
        console.error('Error deleting chunks:', err);
      }
      
      this.downloads.delete(fileId);
    }
  }
}

// Singleton instance
const downloadManager = new DownloadManager();

export default downloadManager;

