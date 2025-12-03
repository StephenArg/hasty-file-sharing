import React, { useState, useEffect } from 'react';

const StorageStats = ({ onStorageUpdate }) => {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const fetchStats = async () => {
    try {
      const response = await fetch('/api/storage');
      const data = await response.json();
      setStats(data);
      setLoading(false);
      if (onStorageUpdate) {
        onStorageUpdate(data);
      }
    } catch (err) {
      console.error('Error fetching storage stats:', err);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    // Refresh stats every 5 seconds
    const interval = setInterval(fetchStats, 5000);
    
    // Listen for manual refresh events
    const handleRefresh = () => fetchStats();
    window.addEventListener('storageRefresh', handleRefresh);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('storageRefresh', handleRefresh);
    };
  }, []);

  if (loading || !stats) {
    return (
      <div className="storage-stats">
        <div className="storage-loading">Loading storage info...</div>
      </div>
    );
  }

  const percentage = stats.percentage || 0;
  const isFull = stats.isFull || percentage >= 100;
  const isWarning = percentage >= 80;

  return (
    <div className="storage-stats">
      <div className="storage-header">
        <h3>💾 Storage Usage</h3>
        <span className={`storage-status ${isFull ? 'full' : isWarning ? 'warning' : 'ok'}`}>
          {isFull ? 'Full' : isWarning ? 'Warning' : 'OK'}
        </span>
      </div>
      <div className="storage-info">
        <div className="storage-details">
          <span className="storage-used">{formatBytes(stats.totalUsed)}</span>
          <span className="storage-separator">/</span>
          <span className="storage-total">{formatBytes(stats.totalLimit)}</span>
          <span className="storage-available">({formatBytes(stats.available)} available)</span>
        </div>
        <div className="storage-count">{stats.fileCount} file{stats.fileCount !== 1 ? 's' : ''}</div>
      </div>
      <div className="storage-progress-container">
        <div 
          className={`storage-progress ${isFull ? 'full' : isWarning ? 'warning' : ''}`}
          style={{ width: `${Math.min(100, percentage)}%` }}
        ></div>
      </div>
      <div className="storage-percentage">{percentage.toFixed(1)}% used</div>
    </div>
  );
};

export default StorageStats;

