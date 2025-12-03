import React from 'react';

const UploadProgress = ({ uploads }) => {
  if (!uploads || uploads.length === 0) return null;

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  return (
    <div className="upload-progress-container">
      <h3>Uploading Files</h3>
      {uploads.map((upload, index) => (
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
            <span>{formatBytes(upload.loaded)} / {formatBytes(upload.total)}</span>
            {upload.speed && <span className="upload-speed">{upload.speed}</span>}
          </div>
        </div>
      ))}
    </div>
  );
};

export default UploadProgress;

