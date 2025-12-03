import React, { useEffect } from 'react';
import { wsDownloadManager } from '../utils/websocketDownload';

const ProgressiveDownload = ({ fileId, filename, fileInfo, onComplete, downloadStatus, setDownloadStatus, isDownloading, setIsDownloading }) => {

  useEffect(() => {
    // Check if download is already in progress
    // WebSocket downloads are tracked in wsDownloadManager
    // For now, we'll start fresh each time
  }, [fileId]);

  const startDownload = async () => {
    setIsDownloading(true);
    setDownloadStatus({
      fileId,
      filename,
      status: 'starting',
      progress: 0,
      message: 'Starting download...'
    });

    try {
      // Start WebSocket download
      await wsDownloadManager.startDownload(
        fileId,
        filename,
        (status) => {
          setDownloadStatus({
            fileId,
            filename,
            status: 'downloading',
            progress: status.progress,
            message: `Downloaded ${status.receivedChunks}/${status.totalPieces} chunks`,
            receivedChunks: status.receivedChunks,
            totalPieces: status.totalPieces
          });
        },
        () => {
          // Download complete
          setDownloadStatus({
            fileId,
            filename,
            status: 'completed',
            progress: 100,
            message: 'Download complete'
          });
          setIsDownloading(false);
          if (onComplete) {
            onComplete(fileId);
          }
        }
      );
    } catch (err) {
      console.error('Download error:', err);
      setDownloadStatus({
        fileId,
        filename,
        status: 'error',
        error: err.message
      });
      setIsDownloading(false);
    }
  };

  const cancelDownload = async () => {
    await wsDownloadManager.cancelDownload(fileId);
    setDownloadStatus(null);
    setIsDownloading(false);
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  if (!downloadStatus && !isDownloading) {
    return (
      <button
        className="btn btn-small btn-success"
        onClick={startDownload}
        title="Start progressive download (downloads chunks as they become available)"
      >
        📥 Progressive Download
      </button>
    );
  }

  if (downloadStatus?.status === 'completed') {
    return (
      <span className="download-complete">✓ Download Complete</span>
    );
  }

  const progress = downloadStatus?.progress || 0;
  const downloadedPieces = downloadStatus?.receivedChunks || downloadStatus?.downloadedPieces?.length || 0;
  const totalPieces = downloadStatus?.totalPieces || fileInfo?.totalPieces || 0;

  return (
    <div className="progressive-download">
      <div className="progressive-download-header">
        <span className="progressive-download-status">
          {downloadStatus?.status === 'waiting' ? '⏳' : '⬇️'} {downloadStatus?.message || 'Downloading...'}
        </span>
        <button
          className="btn btn-small btn-danger"
          onClick={cancelDownload}
          style={{ marginLeft: '10px', padding: '4px 8px', fontSize: '0.8em' }}
        >
          Cancel
        </button>
      </div>
      <div className="progressive-download-progress">
        <div className="progressive-download-bar-container">
          <div
            className="progressive-download-bar"
            style={{ width: `${progress}%` }}
          ></div>
        </div>
        <div className="progressive-download-details">
          <span>{downloadedPieces}/{totalPieces} pieces ({progress.toFixed(1)}%)</span>
        </div>
      </div>
    </div>
  );
};

export default ProgressiveDownload;

