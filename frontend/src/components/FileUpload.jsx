import React, { useState, useRef, useCallback } from 'react';
import JSZip from 'jszip';

const FileUpload = ({ onSuccess, onError, onLoadingChange, onUploadProgress }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState([]);
  const fileInputRef = useRef(null);
  const directoryInputRef = useRef(null);

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const uploadFileWithProgress = (file, index, totalFiles) => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('files', file);

      const startTime = Date.now();

      // Track progress
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const progress = Math.round((e.loaded / e.total) * 100);
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? formatBytes(e.loaded / elapsed) + '/s' : '';
          
          setUploadProgress(prev => {
            const updated = [...prev];
            updated[index] = {
              filename: file.name,
              progress,
              loaded: e.loaded,
              total: e.total,
              speed
            };
            if (onUploadProgress) {
              onUploadProgress(updated);
            }
            return updated;
          });
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            // Update progress to 100%
            setUploadProgress(prev => {
              const updated = [...prev];
              updated[index] = {
                ...updated[index],
                progress: 100
              };
              return updated;
            });
            resolve(data);
          } catch (err) {
            reject(new Error('Failed to parse response'));
          }
        } else {
          try {
            const data = JSON.parse(xhr.responseText);
            const error = new Error(data.error || 'Upload failed');
            error.response = { json: () => Promise.resolve(data) };
            reject(error);
          } catch (err) {
            reject(new Error(`Upload failed: ${xhr.statusText}`));
          }
        }
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Upload failed'));
      });

      xhr.addEventListener('abort', () => {
        reject(new Error('Upload aborted'));
      });

      xhr.open('POST', '/api/upload/files');
      xhr.send(formData);
    });
  };

  const uploadFiles = async (filesToUpload) => {
    if (filesToUpload.length === 0) return;

    onLoadingChange(true);
    const filesArray = Array.from(filesToUpload);
    
    // Initialize progress tracking
    setUploadProgress(filesArray.map(file => ({
      filename: file.name,
      progress: 0,
      loaded: 0,
      total: file.size,
      speed: ''
    })));

    try {
      // Upload files one by one to track individual progress
      const results = [];
      for (let i = 0; i < filesArray.length; i++) {
        const file = filesArray[i];
        try {
          const result = await uploadFileWithProgress(file, i, filesArray.length);
          
          if (result.success && result.files && result.files.length > 0) {
            results.push(...result.files);
          }
        } catch (err) {
          // Continue with other files even if one fails
          console.error(`Failed to upload ${file.name}:`, err);
          if (i === 0 && filesArray.length === 1) {
            // If it's the only file, throw the error
            throw err;
          }
        }
      }

      if (results.length > 0) {
        onSuccess(results);
      }
      
      // Clear progress after a delay
      setTimeout(() => {
        setUploadProgress([]);
      }, 2000);
    } catch (err) {
      onError(err);
      setUploadProgress([]);
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

      // Generate zip blob with progress tracking
      const zipName = `${directory.name || 'directory'}.zip`;
      setUploadProgress([{
        filename: zipName,
        progress: 0,
        loaded: 0,
        total: 0,
        speed: ''
      }]);

      // Generate zip with progress
      const zipBlob = await zip.generateAsync(
        { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } },
        (metadata) => {
          if (metadata.percent) {
            setUploadProgress([{
              filename: zipName,
              progress: Math.round(metadata.percent),
              loaded: 0,
              total: 0,
              speed: 'Zipping...'
            }]);
          }
        }
      );
      
      // Update progress for upload
      setUploadProgress([{
        filename: zipName,
        progress: 50,
        loaded: 0,
        total: zipBlob.size,
        speed: 'Uploading...'
      }]);

      // Create form data
      const formData = new FormData();
      const zipFile = new File([zipBlob], zipName, { type: 'application/zip' });
      formData.append('directory', zipFile);
      formData.append('originalName', zipName);

      // Upload with progress
      const result = await uploadFileWithProgress(zipFile, 0);
      
      if (result.success) {
        onSuccess([result.file]);
      }
      
      setTimeout(() => {
        setUploadProgress([]);
      }, 2000);
    } catch (err) {
      onError(err);
      setUploadProgress([]);
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
      {uploadProgress.length > 0 && (
        <div className="upload-progress-wrapper">
          <h3>Uploading Files</h3>
          {uploadProgress.map((upload, index) => (
            <div key={index} className="upload-progress-item">
              <div className="upload-progress-header">
                <span className="upload-filename">{upload.filename}</span>
                <span className="upload-percentage">{upload.progress}%</span>
              </div>
              <div className="upload-progress-bar-container">
                <div 
                  className="upload-progress-bar"
                  style={{ width: `${upload.progress}%` }}
                ></div>
              </div>
              <div className="upload-progress-details">
                <span>{formatFileSize(upload.loaded)} / {formatFileSize(upload.total)}</span>
                {upload.speed && <span className="upload-speed">{upload.speed}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
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

