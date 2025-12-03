import React, { useState, useRef, useCallback } from 'react';
import JSZip from 'jszip';

const FileUpload = ({ onSuccess, onError, onLoadingChange }) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);
  const directoryInputRef = useRef(null);

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const uploadFiles = async (filesToUpload) => {
    if (filesToUpload.length === 0) return;

    onLoadingChange(true);
    try {
      const formData = new FormData();
      Array.from(filesToUpload).forEach(file => {
        formData.append('files', file);
      });

      const response = await fetch('/api/upload/files', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();
      
      if (response.ok && data.success) {
        onSuccess(data.files);
      } else {
        const error = new Error(data.error || 'Upload failed');
        error.response = response;
        throw error;
      }
    } catch (err) {
      onError(err);
    } finally {
      onLoadingChange(false);
    }
  };

  const uploadDirectory = async (directory) => {
    onLoadingChange(true);
    try {
      const zip = new JSZip();
      const files = Array.from(directory.files);
      
      // Add all files to zip
      for (const file of files) {
        if (file.webkitRelativePath) {
          zip.file(file.webkitRelativePath, file);
        }
      }

      // Generate zip blob
      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
      
      // Create form data
      const formData = new FormData();
      const zipFile = new File([zipBlob], `${directory.name || 'directory'}.zip`, { type: 'application/zip' });
      formData.append('directory', zipFile);
      formData.append('originalName', `${directory.name || 'directory'}.zip`);

      const response = await fetch('/api/upload/directory', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();
      
      if (response.ok && data.success) {
        onSuccess([data.file]);
      } else {
        const error = new Error(data.error || 'Upload failed');
        error.response = response;
        throw error;
      }
    } catch (err) {
      onError(err);
    } finally {
      onLoadingChange(false);
    }
  };

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      // Check if it's a directory (webkitdirectory)
      const hasDirectory = droppedFiles.some(f => f.webkitRelativePath);
      if (hasDirectory) {
        // It's a directory
        const directory = { files: droppedFiles, name: droppedFiles[0].webkitRelativePath.split('/')[0] };
        uploadDirectory(directory);
      } else {
        // Regular files
        uploadFiles(droppedFiles);
      }
    }
  }, []);

  const handleFileSelect = (e) => {
    const selectedFiles = Array.from(e.target.files);
    if (selectedFiles.length > 0) {
      uploadFiles(selectedFiles);
    }
  };

  const handleDirectorySelect = (e) => {
    const selectedFiles = Array.from(e.target.files);
    if (selectedFiles.length > 0) {
      const directory = { files: selectedFiles, name: selectedFiles[0].webkitRelativePath?.split('/')[0] || 'directory' };
      uploadDirectory(directory);
    }
  };

  const handleUploadZoneClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="upload-section">
      <div
        className={`upload-zone ${isDragging ? 'dragover' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleUploadZoneClick}
      >
        <div className="upload-icon">📁</div>
        <div className="upload-text">Drop files here or click to upload</div>
        <div className="upload-hint">Supports multiple files or entire directories</div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="file-input"
        multiple
        onChange={handleFileSelect}
      />

      <input
        ref={directoryInputRef}
        type="file"
        className="file-input"
        webkitdirectory=""
        directory=""
        multiple
        onChange={handleDirectorySelect}
      />

      <div className="button-group">
        <button
          className="btn btn-primary"
          onClick={() => fileInputRef.current?.click()}
        >
          📄 Upload Files
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => directoryInputRef.current?.click()}
        >
          📂 Upload Directory
        </button>
      </div>
    </div>
  );
};

export default FileUpload;

