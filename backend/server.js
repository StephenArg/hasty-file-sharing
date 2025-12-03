const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const db = require('./database');
const uploadRoutes = require('./routes/upload');
const downloadRoutes = require('./routes/download');
const fileRoutes = require('./routes/files');
const { initializeWebSocket } = require('./websocket');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../uploads');

// Parse storage limit from environment variable
function parseStorageLimit(limit) {
  if (typeof limit === 'number') return limit;
  if (typeof limit !== 'string') return 100 * 1024 * 1024 * 1024; // 100GB default
  
  const match = limit.match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)?$/i);
  if (!match) return 100 * 1024 * 1024 * 1024; // 100GB default
  
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  
  const multipliers = {
    'B': 1,
    'KB': 1024,
    'MB': 1024 * 1024,
    'GB': 1024 * 1024 * 1024,
    'TB': 1024 * 1024 * 1024 * 1024
  };
  
  return Math.floor(value * (multipliers[unit] || 1));
}

// Storage limit in bytes (default: 100GB, can be set via STORAGE_LIMIT env var)
// Supports: number (bytes), or string with suffix (e.g., "10GB", "500MB", "1TB")
const STORAGE_LIMIT = parseStorageLimit(process.env.STORAGE_LIMIT || '100GB');

// Ensure directories exist
async function ensureDirectories() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files (frontend)
app.use(express.static(path.join(__dirname, '../public')));

// API routes
app.use('/api/upload', uploadRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/files', fileRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Storage stats endpoint
app.get('/api/storage', async (req, res) => {
  try {
    const totalUsed = await db.getTotalStorageUsed();
    const fileCount = await db.getFileCount();
    const available = Math.max(0, STORAGE_LIMIT - totalUsed);
    const percentage = STORAGE_LIMIT > 0 ? (totalUsed / STORAGE_LIMIT) * 100 : 0;
    
    res.json({
      totalUsed,
      totalLimit: STORAGE_LIMIT,
      available,
      percentage: Math.min(100, Math.round(percentage * 100) / 100),
      fileCount,
      isFull: totalUsed >= STORAGE_LIMIT
    });
  } catch (error) {
    console.error('Storage stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Catch all handler for SPA (only for non-API routes)
app.get('*', (req, res) => {
  // Don't serve index.html for API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Initialize and start server
async function start() {
  await ensureDirectories();
  await db.initialize();
  
  // Initialize WebSocket server
  initializeWebSocket(server);
  
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server initialized`);
    console.log(`Data directory: ${DATA_DIR}`);
    console.log(`Uploads directory: ${UPLOADS_DIR}`);
  });
}

start().catch(console.error);

