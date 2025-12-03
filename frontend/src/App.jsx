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
      />

      <FileList files={files} onDelete={handleDelete} />
    </div>
  );
}

export default App;

