import React, { useState, useRef, useCallback } from 'react';
import JSZip from 'jszip';
import { uploadFileViaWebSocket } from '../utils/websocketUpload';

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

  const uploadFileWithProgress = async (file, index, totalFiles, fileId = null) => {
    // Store the filename to match progress updates
    const fileName = file.name;
    
    try {
      // Upload via WebSocket
      const result = await uploadFileViaWebSocket(
        file,
        (progress) => {
          // Update progress - match by filename to ensure correct file
          setUploadProgress(prev => {
            const updated = [...prev];
            // Find the correct index by matching filename
            const fileIndex = updated.findIndex(p => p.filename === fileName);
            if (fileIndex >= 0) {
              updated[fileIndex] = {
                filename: fileName,
                progress: progress.progress,
                loaded: progress.loaded,
                total: progress.total,
                bytesLoaded: progress.bytesLoaded || 0,
                bytesTotal: progress.bytesTotal || file.size,
                speed: progress.speed || '',
                timestamp: Date.now()
              };
            }
            if (onUploadProgress) {
              onUploadProgress(updated);
            }
            return updated;
          });
        },
        (fileData) => {
          // File started
          if (onFileStart) {
            onFileStart(fileData);
          }
        }
      );

      // Update progress to 100%
      setUploadProgress(prev => {
        const updated = [...prev];
        // Find the correct index by matching filename
        const fileIndex = updated.findIndex(p => p.filename === fileName);
        if (fileIndex >= 0) {
          updated[fileIndex] = {
            ...updated[fileIndex],
            progress: 100
          };
        }
        return updated;
      });

      return {
        success: true,
        files: [{
          id: result.fileId,
          filename: file.name,
          size: file.size
        }]
      };
    } catch (err) {
      throw err;
    }
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
      total: 0, // Will be set to total chunks
      bytesLoaded: 0,
      bytesTotal: file.size,
      speed: 'Initializing...'
    }));
    setUploadProgress(initialProgress);

    try {
      // Upload files via WebSocket (files are initialized during upload)
      // Upload files sequentially to avoid overwhelming the connection
      const uploadPromises = filesArray.map((file, i) => {
        return uploadFileWithProgress(file, i, filesArray.length)
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

      // Create file from blob
      const zipFile = new File([zipBlob], zipName, { type: 'application/zip' });

      // Upload via WebSocket
      const result = await uploadFileWithProgress(zipFile, 0);
      
      if (result.success) {
        onSuccess(result.files);
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
                <span>
                  {upload.loaded} / {upload.total} chunks
                  {upload.bytesLoaded !== undefined && upload.bytesTotal !== undefined && (
                    <span> • {formatFileSize(upload.bytesLoaded)} / {formatFileSize(upload.bytesTotal)}</span>
                  )}
                </span>
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

