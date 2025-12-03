import React, { useState, useCallback, useEffect } from 'react';
import FileUpload from './components/FileUpload';
import FileList from './components/FileList';
import StorageStats from './components/StorageStats';
import './App.css';

function App() {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [storageStats, setStorageStats] = useState(null);

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const fetchFiles = useCallback(async () => {
    try {
      const response = await fetch('/api/files');
      const data = await response.json();
      setFiles(data.files || []);
    } catch (err) {
      console.error('Error fetching files:', err);
    }
  }, []);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const handleUploadSuccess = (uploadedFiles) => {
    setSuccess(`Successfully uploaded ${uploadedFiles.length} file(s)!`);
    setError(null);
    // Immediately add files to list (they're being processed in background)
    setFiles(prev => {
      const newFiles = uploadedFiles.map(f => ({
        id: f.id,
        filename: f.filename,
        original_filename: f.filename,
        size: f.size,
        total_pieces: f.totalPieces,
        piece_size: f.pieceSize,
        created_at: new Date().toISOString()
      }));
      // Merge with existing, avoiding duplicates
      const existingIds = new Set(prev.map(f => f.id));
      const uniqueNew = newFiles.filter(f => !existingIds.has(f.id));
      return [...uniqueNew, ...prev];
    });
    // Also fetch to get any updates
    fetchFiles();
    // Refresh storage stats after upload
    setTimeout(() => {
      window.dispatchEvent(new Event('storageRefresh'));
    }, 500);
    setTimeout(() => setSuccess(null), 5000);
  };

  const handleUploadError = async (err) => {
    // Check if it's a storage limit error
    if (err.response) {
      try {
        const data = await err.response.json();
        if (data.error === 'Storage limit exceeded') {
          setError(`Storage limit exceeded! Available: ${formatBytes(data.available)}, Required: ${formatBytes(data.required)}`);
        } else {
          setError(data.error || err.message || 'Upload failed');
        }
      } catch (parseErr) {
        setError(err.message || 'Upload failed');
      }
    } else {
      setError(err.message || 'Upload failed');
    }
    setSuccess(null);
    setTimeout(() => setError(null), 5000);
  };

  const handleStorageUpdate = (stats) => {
    setStorageStats(stats);
  };

  const handleDelete = async (fileId) => {
    try {
      const response = await fetch(`/api/files/${fileId}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        setSuccess('File deleted successfully');
        fetchFiles();
        // Refresh storage stats after deletion
        setTimeout(() => {
          window.dispatchEvent(new Event('storageRefresh'));
        }, 500);
        setTimeout(() => setSuccess(null), 3000);
      } else {
        const data = await response.json();
        setError(data.error || 'Failed to delete file');
        setTimeout(() => setError(null), 5000);
      }
    } catch (err) {
      setError('Failed to delete file');
      setTimeout(() => setError(null), 5000);
    }
  };

  return (
    <div className="app">
      <h1>🚀 Hasty File Send</h1>
      <p className="subtitle">Self-hosted file sharing with torrent-like chunking</p>

      <StorageStats onStorageUpdate={handleStorageUpdate} />

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <FileUpload
        onSuccess={handleUploadSuccess}
        onError={handleUploadError}
        onLoadingChange={setLoading}
        storageStats={storageStats}
        onFileStart={(file) => {
          // Add or update file in list
          setFiles(prev => {
            // If it's a temp file (uploading), check if we need to replace a temp entry
            if (file.isUploading && file.tempFile) {
              // Check if there's already a temp entry for this filename
              const existingTempIndex = prev.findIndex(f => 
                f.filename === file.filename && f.id && f.id.startsWith('temp-')
              );
              
              if (existingTempIndex >= 0) {
                // Update existing temp entry
                const updated = [...prev];
                updated[existingTempIndex] = {
                  ...updated[existingTempIndex],
                  size: file.size,
                  isUploading: true
                };
                return updated;
              } else {
                // Add new temp entry
                return [{
                  id: file.id,
                  filename: file.filename,
                  original_filename: file.filename,
                  size: file.size,
                  total_pieces: 0,
                  piece_size: 0,
                  created_at: new Date().toISOString(),
                  isUploading: true
                }, ...prev];
              }
            } else if (file.uploadComplete) {
              // Upload completed, update the temp entry or add new one
              const existingIndex = prev.findIndex(f => 
                (f.id === file.id) || 
                (f.id && f.id.startsWith('temp-') && f.filename === file.filename)
              );
              
              if (existingIndex >= 0) {
                // Replace temp entry with real file data
                const updated = [...prev];
                updated[existingIndex] = {
                  id: file.id,
                  filename: file.filename,
                  original_filename: file.filename,
                  size: file.size,
                  total_pieces: file.totalPieces || file.total_pieces || 0,
                  piece_size: file.pieceSize || file.piece_size || 0,
                  created_at: new Date().toISOString(),
                  isUploading: false
                };
                return updated;
              } else {
                // Add new entry
                return [{
                  id: file.id,
                  filename: file.filename,
                  original_filename: file.filename,
                  size: file.size,
                  total_pieces: file.totalPieces || file.total_pieces || 0,
                  piece_size: file.pieceSize || file.piece_size || 0,
                  created_at: new Date().toISOString(),
                  isUploading: false
                }, ...prev];
              }
            } else {
              // Regular file entry
              const existingIds = new Set(prev.map(f => f.id));
              if (!existingIds.has(file.id)) {
                return [{
                  id: file.id,
                  filename: file.filename || file.original_filename,
                  original_filename: file.filename || file.original_filename,
                  size: file.size,
                  total_pieces: file.totalPieces || file.total_pieces || 0,
                  piece_size: file.pieceSize || file.piece_size || 0,
                  created_at: new Date().toISOString()
                }, ...prev];
              }
            }
            return prev;
          });
          
          // If upload is complete, fetch file info to start polling
          if (file.uploadComplete && file.id && !file.id.startsWith('temp-')) {
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('fileAdded', { detail: { fileId: file.id } }));
            }, 100);
          }
        }}
      />

      <FileList files={files} onDelete={handleDelete} />
    </div>
  );
}

export default App;

