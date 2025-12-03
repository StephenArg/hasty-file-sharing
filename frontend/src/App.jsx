import React, { useState, useCallback, useEffect } from 'react';
import FileUpload from './components/FileUpload';
import FileList from './components/FileList';
import StorageStats from './components/StorageStats';
import Login from './components/Login';
import './App.css';

function App() {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [storageStats, setStorageStats] = useState(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const fetchFiles = useCallback(async (forceRefresh = false) => {
    try {
      const response = await fetch('/api/files', {
        credentials: 'include'
      });
      
      // Check if authentication is required
      if (response.status === 401) {
        const data = await response.json();
        if (data.requiresAuth) {
          setAuthenticated(false);
          return;
        }
      }
      
      const data = await response.json();
      console.log('Fetched files from API:', data.files);
      
      if (forceRefresh) {
        // Force refresh: use server data as source of truth (handles deletions)
        setFiles(data.files || []);
      } else {
        // Merge with existing files instead of replacing (to preserve any that were just added)
        setFiles(prev => {
          const serverFiles = data.files || [];
          const existingIds = new Set(prev.map(f => f.id));
          const newServerFiles = serverFiles.filter(f => !existingIds.has(f.id));
          // If we have new files from server, add them; otherwise keep existing
          if (newServerFiles.length > 0) {
            return [...newServerFiles, ...prev];
          }
          // If server has files we don't have, use server data (more authoritative)
          const serverIds = new Set(serverFiles.map(f => f.id));
          const missingFromServer = prev.filter(f => !serverIds.has(f.id));
          if (missingFromServer.length === 0 && serverFiles.length > 0) {
            return serverFiles;
          }
          return prev;
        });
      }
    } catch (err) {
      console.error('Error fetching files:', err);
    }
  }, []);

  // Check authentication status on mount
  useEffect(() => {
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      const response = await fetch('/api/auth/status', {
        credentials: 'include'
      });
      const data = await response.json();
      
      if (!data.requiresAuth) {
        // Password not required
        setAuthenticated(true);
        setCheckingAuth(false);
        fetchFiles();
        return;
      }
      
      if (data.authenticated) {
        setAuthenticated(true);
        fetchFiles();
      }
      setCheckingAuth(false);
    } catch (err) {
      console.error('Error checking auth status:', err);
      setCheckingAuth(false);
    }
  };

  const handleLogin = () => {
    setAuthenticated(true);
    fetchFiles();
  };

  useEffect(() => {
    // Only fetch files if authenticated
    if (authenticated) {
      fetchFiles();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]); // Fetch files when authenticated

  const handleUploadSuccess = (uploadedFiles) => {
    console.log('Upload success, files:', uploadedFiles);
    setSuccess(`Successfully uploaded ${uploadedFiles.length} file(s)!`);
    setError(null);
    // Immediately add files to list (they're being processed in background)
    setFiles(prev => {
      const newFiles = uploadedFiles.map(f => ({
        id: f.id,
        filename: f.filename,
        original_filename: f.filename,
        size: f.size,
        total_pieces: f.totalPieces || f.total_pieces || 0,
        piece_size: f.pieceSize || f.piece_size || 0,
        created_at: new Date().toISOString()
      }));
      console.log('Adding files to list:', newFiles);
      // Merge with existing, avoiding duplicates
      const existingIds = new Set(prev.map(f => f.id));
      const uniqueNew = newFiles.filter(f => !existingIds.has(f.id));
      const updated = [...uniqueNew, ...prev];
      console.log('Updated files list:', updated);
      return updated;
    });
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
        method: 'DELETE',
        credentials: 'include'
      });
      
      if (response.ok) {
        setSuccess('File deleted successfully');
        // Force refresh to ensure deleted file is removed from list
        fetchFiles(true);
        // Also remove from local state immediately for better UX
        setFiles(prev => prev.filter(f => f.id !== fileId));
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

  // Show login page if checking auth or not authenticated
  if (checkingAuth || !authenticated) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <div className="app">
      <h1>🚀 Hasty File Send</h1>
      <p className="subtitle">Self-hosted file sharing with torrent-like chunking. Works best with Chrome.</p>

      <StorageStats onStorageUpdate={handleStorageUpdate} />

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <FileUpload
        onSuccess={handleUploadSuccess}
        onError={handleUploadError}
        onLoadingChange={setLoading}
        storageStats={storageStats}
        onFileStart={(file) => {
          console.log('onFileStart called with:', file);
          // Add file to list - backend already created the entry, so file is ready
          setFiles(prev => {
            const existingIds = new Set(prev.map(f => f.id));
            if (!existingIds.has(file.id)) {
              const newFile = {
                id: file.id,
                filename: file.filename || file.original_filename,
                original_filename: file.filename || file.original_filename,
                size: file.size,
                total_pieces: file.totalPieces || file.total_pieces || 0,
                piece_size: file.pieceSize || file.piece_size || 0,
                created_at: new Date().toISOString()
              };
              console.log('Adding file via onFileStart:', newFile);
              return [newFile, ...prev];
            }
            console.log('File already exists:', file.id);
            return prev;
          });
          
          // Fetch file info immediately to start showing piece status
          if (file.id) {
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

