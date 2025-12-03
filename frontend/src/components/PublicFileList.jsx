import React, { useState, useEffect } from 'react';
import FileList from './FileList';

const PublicFileList = () => {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchFiles = async () => {
    try {
      const response = await fetch('/api/files');
      const data = await response.json();
      setFiles(data.files || []);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching files:', err);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles();
    // Refresh every 5 seconds
    const interval = setInterval(fetchFiles, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="app">
        <h1>🚀 Hasty File Send</h1>
        <p className="subtitle">Loading files...</p>
      </div>
    );
  }

  return (
    <div className="app">
      <h1>🚀 Hasty File Send</h1>
      <p className="subtitle">Public File List - No password required to download</p>
      <FileList files={files} onDelete={() => {}} showDelete={false} />
    </div>
  );
};

export default PublicFileList;

