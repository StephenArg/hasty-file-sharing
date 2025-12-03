import React, { useState, useEffect } from 'react';
import ProgressiveDownload from './ProgressiveDownload';

const FileList = ({ files, onDelete }) => {
  const [copiedId, setCopiedId] = useState(null);
  const [fileInfo, setFileInfo] = useState({});
  const [downloadStatus, setDownloadStatus] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const getDownloadUrl = (fileId) => {
    const baseUrl = window.location.origin;
    return `${baseUrl}/api/download/${fileId}`;
  };

  const getPieceUrl = (fileId, pieceIndex) => {
    const baseUrl = window.location.origin;
    return `${baseUrl}/api/download/${fileId}?piece=${pieceIndex}`;
  };

  const fetchFileInfo = async (fileId) => {
    try {
      const response = await fetch(`/api/download/${fileId}/info`);
      const data = await response.json();
      setFileInfo(prev => ({
        ...prev,
        [fileId]: data
      }));
    } catch (err) {
      console.error('Error fetching file info:', err);
    }
  };

  useEffect(() => {
    // Fetch info for all files
    files.forEach(file => {
      if (!fileInfo[file.id]) {
        fetchFileInfo(file.id);
      }
    });
  }, [files]);

  // Listen for new files being added
  useEffect(() => {
    const handleFileAdded = (event) => {
      const { fileId } = event.detail;
      // Immediately fetch info for the new file
      fetchFileInfo(fileId);
    };

    window.addEventListener('fileAdded', handleFileAdded);
    return () => {
      window.removeEventListener('fileAdded', handleFileAdded);
    };
  }, []);

  useEffect(() => {
    // Set up polling for incomplete files
    const interval = setInterval(() => {
      files.forEach(file => {
        const info = fileInfo[file.id];
        // Always poll if no info, or if file is incomplete
        if (!info || (info.totalPieces > 0 && info.completePieces < info.totalPieces)) {
          fetchFileInfo(file.id);
        }
      });
    }, 2000); // Poll every 2 seconds

    return () => clearInterval(interval);
  }, [files, fileInfo]);

  const copyToClipboard = async (fileId) => {
    const url = getDownloadUrl(fileId);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(fileId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleDownload = (fileId, filename) => {
    const url = getDownloadUrl(fileId);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (files.length === 0) {
    return (
      <div className="files-list">
        <h2>Uploaded Files</h2>
        <div className="empty-state">
          <div className="empty-state-icon">📭</div>
          <p>No files uploaded yet. Upload some files to get started!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="files-list">
      <h2>Uploaded Files ({files.length})</h2>
      {files.map((file) => {
        const info = fileInfo[file.id];
        // File is complete if all pieces are processed (not just uploaded)
        const isComplete = info && info.totalPieces > 0 && info.completePieces === info.totalPieces;
        const completionPercent = info && info.totalPieces > 0 
          ? Math.round((info.completePieces / info.totalPieces) * 100) 
          : 0;

        return (
          <div key={file.id} className="file-item">
            <div className="file-info">
              <div className="file-name">
                {file.original_filename || file.filename}
                {!isComplete && info && <span className="file-status-badge uploading">Processing...</span>}
              </div>
              <div className="file-meta">
                {formatFileSize(file.size)} • {info ? info.totalPieces : file.total_pieces || '?'} pieces • {formatDate(file.created_at)}
                {info && (
                  <span className="file-completion">
                    {' • '}{info.completePieces}/{info.totalPieces} pieces ready ({completionPercent}%)
                  </span>
                )}
                {!info && (
                  <span className="file-completion">
                    {' • '}Processing pieces...
                  </span>
                )}
              </div>
              {!isComplete && info && info.completePieces > 0 && (
                <div className="file-upload-progress">
                  <div className="file-upload-progress-bar">
                    <div 
                      className="file-upload-progress-fill"
                      style={{ width: `${completionPercent}%` }}
                    ></div>
                  </div>
                </div>
              )}
              <div className="copy-link">
                <input
                  type="text"
                  className="link-input"
                  value={getDownloadUrl(file.id)}
                  readOnly
                />
                <button
                  className={`btn btn-small ${copiedId === file.id ? 'btn-success' : 'btn-primary'}`}
                  onClick={() => copyToClipboard(file.id)}
                >
                  {copiedId === file.id ? '✓ Copied' : '📋 Copy Link'}
                </button>
                <div className="file-actions">
                  {(isDownloading || (!isComplete && file.id && !file.id.startsWith('temp-'))) && (
                    <ProgressiveDownload
                      downloadStatus={downloadStatus}
                      setDownloadStatus={setDownloadStatus}
                      isDownloading={isDownloading}
                      setIsDownloading={setIsDownloading}
                      fileId={file.id}
                      filename={file.original_filename || file.filename}
                      fileInfo={info}
                      onComplete={() => {
                        // Refresh file info after download completes
                        fetchFileInfo(file.id);
                      }}
                    />
                  )}
                  {isComplete && file.id && !file.id.startsWith('temp-') && !isDownloading && (
                    <button
                      className="btn btn-small btn-success"
                      onClick={() => handleDownload(file.id, file.original_filename || file.filename)}
                      style={{ marginLeft: '5px' }}
                    >
                      ⬇️ Direct Download
                    </button>
                  )}
                  {file.id && !file.id.startsWith('temp-') && !isDownloading && (
                    <button
                      className="btn btn-small btn-danger"
                      onClick={() => {
                        if (window.confirm('Are you sure you want to delete this file?')) {
                          onDelete(file.id);
                        }
                      }}
                      style={{ marginLeft: '5px' }}
                    >
                      🗑️ Delete
                    </button>
                  )}
                </div>
              </div>
              {!isComplete && info && info.completePieces > 0 && (
                <div className="piece-downloads">
                  <details>
                    <summary>Download Available Pieces ({info.completePieces}/{info.totalPieces})</summary>
                    <div className="pieces-list">
                      {info.pieces.filter(p => p.isComplete).map(piece => (
                        <a
                          key={piece.index}
                          href={getPieceUrl(file.id, piece.index)}
                          className="piece-link"
                          download={`${file.original_filename || file.filename}.piece${piece.index}`}
                        >
                          Piece {piece.index} ({formatFileSize(piece.size)})
                        </a>
                      ))}
                    </div>
                  </details>
                </div>
              )}
            </div>
            
          </div>
        );
      })}
    </div>
  );
};

export default FileList;

