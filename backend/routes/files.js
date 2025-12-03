const express = require('express');
const db = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * Get all files
 */
router.get('/', async (req, res) => {
  try {
    const files = await db.getAllFiles();
    res.json({ files });
  } catch (error) {
    console.error('Get files error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a file (protected - requires auth)
 */
router.delete('/:fileId', requireAuth, async (req, res) => {
  try {
    const { fileId } = req.params;
    
    const file = await db.getFileById(fileId);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Delete file from filesystem
    const fs = require('fs').promises;
    try {
      await fs.unlink(file.file_path);
    } catch (err) {
      console.error('Error deleting file from filesystem:', err);
    }
    
    // Delete from database
    await db.deleteFile(fileId);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

