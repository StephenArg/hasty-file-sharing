/**
 * Determine piece size based on file size
 */
export function getPieceSize(fileSize) {
  if (fileSize < 128 * 1024 * 1024) { // < 128 MB
    return 64 * 1024; // 64 KB
  } else if (fileSize < 1024 * 1024 * 1024) { // < 1 GB
    return 256 * 1024; // 256 KB
  } else if (fileSize < 4 * 1024 * 1024 * 1024) { // < 4 GB
    return 512 * 1024; // 512 KB
  } else if (fileSize < 16 * 1024 * 1024 * 1024) { // < 16 GB
    return 1024 * 1024; // 1 MB
  } else if (fileSize < 64 * 1024 * 1024 * 1024) { // < 64 GB
    return 2 * 1024 * 1024; // 2 MB
  } else if (fileSize < 256 * 1024 * 1024 * 1024) { // < 256 GB
    return 4 * 1024 * 1024; // 4 MB
  } else { // > 256 GB
    return 8 * 1024 * 1024; // 8 MB
  }
}

/**
 * Hash piece data (for client-side)
 */
export async function hashPiece(data) {
  if (data instanceof Uint8Array) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback for other types
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(JSON.stringify(data));
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

