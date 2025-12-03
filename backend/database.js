const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'files.db');

let db = null;

function getDB() {
  if (!db) {
    db = new sqlite3.Database(DB_PATH);
  }
  return db;
}

function initialize() {
  return new Promise((resolve, reject) => {
    const database = getDB();
    
    database.serialize(() => {
      // Files table
      database.run(`
        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          filename TEXT NOT NULL,
          original_filename TEXT,
          size INTEGER NOT NULL,
          piece_size INTEGER NOT NULL,
          total_pieces INTEGER NOT NULL,
          mime_type TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          file_path TEXT NOT NULL
        )
      `);
      
      // Pieces table
      database.run(`
        CREATE TABLE IF NOT EXISTS pieces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id TEXT NOT NULL,
          piece_index INTEGER NOT NULL,
          hash TEXT NOT NULL,
          size INTEGER NOT NULL,
          offset INTEGER NOT NULL,
          is_complete INTEGER DEFAULT 0,
          FOREIGN KEY (file_id) REFERENCES files(id),
          UNIQUE(file_id, piece_index)
        )
      `);
      
      // Create indexes
      database.run(`CREATE INDEX IF NOT EXISTS idx_pieces_file_id ON pieces(file_id)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_pieces_complete ON pieces(file_id, is_complete)`);
      
      resolve();
    });
  });
}

function createFile(fileData) {
  return new Promise((resolve, reject) => {
    const database = getDB();
    const { id, filename, originalFilename, size, pieceSize, totalPieces, mimeType, filePath } = fileData;
    
    database.run(
      `INSERT INTO files (id, filename, original_filename, size, piece_size, total_pieces, mime_type, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, filename, originalFilename, size, pieceSize, totalPieces, mimeType, filePath],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

function createPieces(pieces) {
  return new Promise((resolve, reject) => {
    const database = getDB();
    const stmt = database.prepare(`
      INSERT INTO pieces (file_id, piece_index, hash, size, offset, is_complete)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    database.serialize(() => {
      pieces.forEach(piece => {
        stmt.run([
          piece.fileId,
          piece.pieceIndex,
          piece.hash,
          piece.size,
          piece.offset,
          piece.isComplete || 0
        ]);
      });
      stmt.finalize((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

function getFileById(id) {
  return new Promise((resolve, reject) => {
    const database = getDB();
    database.get(
      `SELECT * FROM files WHERE id = ?`,
      [id],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

function getPiecesByFileId(fileId) {
  return new Promise((resolve, reject) => {
    const database = getDB();
    database.all(
      `SELECT * FROM pieces WHERE file_id = ? ORDER BY piece_index`,
      [fileId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function updatePieceComplete(fileId, pieceIndex, isComplete) {
  return new Promise((resolve, reject) => {
    const database = getDB();
    database.run(
      `UPDATE pieces SET is_complete = ? WHERE file_id = ? AND piece_index = ?`,
      [isComplete ? 1 : 0, fileId, pieceIndex],
      function(err) {
        if (err) {
          console.error(`Error updating piece ${pieceIndex} for ${fileId}:`, err);
          reject(err);
        } else {
          if (this.changes === 0) {
            console.warn(`No piece found to update: fileId=${fileId}, pieceIndex=${pieceIndex}`);
          }
          resolve(this.changes);
        }
      }
    );
  });
}

function updatePieceHash(fileId, pieceIndex, hash) {
  return new Promise((resolve, reject) => {
    const database = getDB();
    database.run(
      `UPDATE pieces SET hash = ? WHERE file_id = ? AND piece_index = ?`,
      [hash, fileId, pieceIndex],
      function(err) {
        if (err) {
          console.error(`Error updating hash for piece ${pieceIndex} of ${fileId}:`, err);
          reject(err);
        } else {
          if (this.changes === 0) {
            console.warn(`No piece found to update hash: fileId=${fileId}, pieceIndex=${pieceIndex}`);
          }
          resolve(this.changes);
        }
      }
    );
  });
}

function getAllFiles() {
  return new Promise((resolve, reject) => {
    const database = getDB();
    database.all(
      `SELECT id, filename, original_filename, size, piece_size, total_pieces, mime_type, created_at
       FROM files ORDER BY created_at DESC`,
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function deleteFile(id) {
  return new Promise((resolve, reject) => {
    const database = getDB();
    database.serialize(() => {
      database.run(`DELETE FROM pieces WHERE file_id = ?`, [id], (err) => {
        if (err) return reject(err);
        database.run(`DELETE FROM files WHERE id = ?`, [id], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  });
}

function getTotalStorageUsed() {
  return new Promise((resolve, reject) => {
    const database = getDB();
    database.get(
      `SELECT COALESCE(SUM(size), 0) as total FROM files`,
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.total : 0);
      }
    );
  });
}

function getFileCount() {
  return new Promise((resolve, reject) => {
    const database = getDB();
    database.get(
      `SELECT COUNT(*) as count FROM files`,
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.count : 0);
      }
    );
  });
}

module.exports = {
  initialize,
  createFile,
  createPieces,
  getFileById,
  getPiecesByFileId,
  updatePieceComplete,
  updatePieceHash,
  getAllFiles,
  deleteFile,
  getTotalStorageUsed,
  getFileCount
};

