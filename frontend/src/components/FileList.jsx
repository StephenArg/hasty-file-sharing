import React, { useState } from 'react';

const FileList = ({ files, onDelete }) => {
  const [copiedId, setCopiedId] = useState(null);

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
      {files.map((file) => (
        <div key={file.id} className="file-item">
          <div className="file-info">
            <div className="file-name">{file.original_filename || file.filename}</div>
            <div className="file-meta">
              {formatFileSize(file.size)} • {file.total_pieces} pieces • {formatDate(file.created_at)}
            </div>
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
            </div>
          </div>
          <div className="file-actions">
            <button
              className="btn btn-small btn-success"
              onClick={() => handleDownload(file.id, file.original_filename || file.filename)}
            >
              ⬇️ Download
            </button>
            <button
              className="btn btn-small btn-danger"
              onClick={() => {
                if (window.confirm('Are you sure you want to delete this file?')) {
                  onDelete(file.id);
                }
              }}
            >
              🗑️ Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

export default FileList;

