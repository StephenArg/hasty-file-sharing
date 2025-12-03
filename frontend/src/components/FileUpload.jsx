import React, { useState, useRef, useCallback } from 'react';
import JSZip from 'jszip';

const FileUpload = ({ onSuccess, onError, onLoadingChange, onUploadProgress, onFileStart }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState([]);
  const fileInputRef = useRef(null);
  const directoryInputRef = useRef(null);

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  // Alias for consistency with other components
  const formatBytes = formatFileSize;

  const uploadFileWithProgress = (file, index, totalFiles, fileId = null) => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('files', file);
      if (fileId) {
        formData.append('fileId', fileId);
      }

      const startTime = Date.now();
      let lastUpdateTime = startTime;
      let lastLoaded = 0;

      // Track progress - use requestAnimationFrame for smoother updates
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && e.total > 0) {
          const now = Date.now();
          const progress = Math.min(100, Math.round((e.loaded / e.total) * 100));
          const elapsed = (now - startTime) / 1000;
          
          // Calculate speed based on recent progress
          const timeDelta = (now - lastUpdateTime) / 1000;
          const loadedDelta = e.loaded - lastLoaded;
          const speed = timeDelta > 0 && loadedDelta > 0 
            ? formatFileSize(loadedDelta / timeDelta) + '/s' 
            : elapsed > 0 
              ? formatFileSize(e.loaded / elapsed) + '/s' 
              : '';
          
          lastUpdateTime = now;
          lastLoaded = e.loaded;
          
          // Force state update - always update to ensure React re-renders
          setUploadProgress(prev => {
            const updated = [...prev];
            updated[index] = {
              filename: file.name,
              progress,
              loaded: e.loaded,
              total: e.total,
              speed,
              timestamp: Date.now() // Add timestamp to force re-render
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
            // Notify that file upload completed and is available (even if still processing)
            // Backend creates file entry immediately, so file is ready for download
            if (data.success && data.files && data.files.length > 0) {
              // Call onFileStart for each file in the response
              data.files.forEach(fileData => {
                if (onFileStart) {
                  onFileStart({
                    id: fileData.id,
                    filename: fileData.filename,
                    size: fileData.size,
                    totalPieces: fileData.totalPieces,
                    pieceSize: fileData.pieceSize,
                    uploadComplete: true
                  });
                }
              });
            }
            resolve(data);
          } catch (err) {
            console.error('Error parsing upload response:', err, xhr.responseText);
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
    
    // Initialize progress tracking - set up progress state for all files
    const initialProgress = filesArray.map(file => ({
      filename: file.name,
      progress: 0,
      loaded: 0,
      total: file.size,
      speed: 'Initializing...'
    }));
    setUploadProgress(initialProgress);

    try {
      // First, initialize all file entries in the backend (creates file entries immediately)
      // This is fast, so we do it sequentially to avoid race conditions
      const fileIdMap = new Map();
      for (let i = 0; i < filesArray.length; i++) {
        const file = filesArray[i];
        try {
          // Update progress to show initialization
          setUploadProgress(prev => {
            const updated = [...prev];
            if (updated[i]) {
              updated[i] = {
                ...updated[i],
                speed: 'Initializing...'
              };
            }
            return updated;
          });
          
          const mimeType = file.type || 'application/octet-stream';
          const response = await fetch('/api/upload/chunk/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: file.name,
              size: file.size,
              mimeType
            })
          });
          
          if (response.ok) {
            const data = await response.json();
            fileIdMap.set(file.name, data.fileId);
            // Notify that file entry was created - file is now available for download
            if (onFileStart && data.success) {
              onFileStart({
                id: data.fileId,
                filename: file.name,
                size: file.size,
                totalPieces: data.totalPieces,
                pieceSize: data.pieceSize,
                uploadComplete: false // Still uploading
              });
            }
            
            // Update progress to show ready for upload
            setUploadProgress(prev => {
              const updated = [...prev];
              if (updated[i]) {
                updated[i] = {
                  ...updated[i],
                  speed: 'Starting upload...'
                };
              }
              return updated;
            });
          } else {
            console.error(`Failed to initialize ${file.name}`);
          }
        } catch (err) {
          console.error(`Failed to initialize ${file.name}:`, err);
        }
      }
      
      // Now upload files using the regular endpoint (which will update the existing entries)
      // Upload files in parallel to see progress for all files simultaneously
      const uploadPromises = filesArray.map((file, i) => {
        const fileId = fileIdMap.get(file.name);
        return uploadFileWithProgress(file, i, filesArray.length, fileId)
          .then(result => ({ success: true, result, index: i }))
          .catch(err => ({ success: false, error: err, index: i, filename: file.name }))
      });

      const uploadResults = await Promise.all(uploadPromises);
      const results = [];

      for (const uploadResult of uploadResults) {
        if (uploadResult.success && uploadResult.result) {
          if (uploadResult.result.success && uploadResult.result.files) {
            results.push(...uploadResult.result.files);
            // Update file status to complete
            uploadResult.result.files.forEach(fileData => {
              if (onFileStart) {
                onFileStart({
                  id: fileData.id,
                  filename: fileData.filename,
                  size: fileData.size,
                  totalPieces: fileData.totalPieces,
                  pieceSize: fileData.pieceSize,
                  uploadComplete: true
                });
              }
            });
          } else {
            console.warn('Upload result missing files:', uploadResult.result);
          }
        } else if (!uploadResult.success) {
          console.error(`Failed to upload ${uploadResult.filename}:`, uploadResult.error);
          if (uploadResults.length === 1) {
            // If it's the only file, throw the error
            throw uploadResult.error;
          }
        }
      }

      console.log('Upload results:', results);
      // Call onSuccess with all results (files should already be in list via onFileStart)
      if (results.length > 0) {
        onSuccess(results);
      } else {
        console.warn('No files in upload results!');
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
            <div key={`${upload.filename}-${index}`} className="upload-progress-item">
              <div className="upload-progress-header">
                <span className="upload-filename">{upload.filename}</span>
                <span className="upload-percentage">{upload.progress}%</span>
              </div>
              <div className="upload-progress-bar-container">
                <div 
                  className="upload-progress-bar"
                  style={{ width: `${Math.max(0, Math.min(100, upload.progress))}%` }}
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

