const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

/**
 * Zip a directory
 */
function zipDirectory(sourceDir, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 1 } // Fast compression
    });
    
    output.on('close', () => {
      resolve({
        size: archive.pointer(),
        path: outputPath
      });
    });
    
    archive.on('error', reject);
    archive.pipe(output);
    
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

/**
 * Zip multiple files
 */
function zipFiles(files, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 1 } // Fast compression
    });
    
    output.on('close', () => {
      resolve({
        size: archive.pointer(),
        path: outputPath
      });
    });
    
    archive.on('error', reject);
    archive.pipe(output);
    
    files.forEach(file => {
      if (fs.statSync(file).isFile()) {
        archive.file(file, { name: path.basename(file) });
      } else if (fs.statSync(file).isDirectory()) {
        archive.directory(file, path.basename(file));
      }
    });
    
    archive.finalize();
  });
}

module.exports = {
  zipDirectory,
  zipFiles
};

