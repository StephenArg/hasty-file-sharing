# Hasty File Send

A self-hosted file sharing application with torrent-like chunking. Upload files or entire directories, and share them instantly via URL links. Files are automatically chunked and hashed for efficient transfer and verification.

## Features

- 📁 **Multiple File Upload** - Upload multiple files at once
- 📂 **Directory Upload** - Upload entire directories (automatically zipped)
- 🔄 **Torrent-like Chunking** - Files are split into pieces with SHA-256 hashes
- ⚡ **Instant Sharing** - Get shareable links immediately after upload
- 💾 **Storage Management** - Track and limit total storage usage with visual indicators
- 🐳 **Docker Ready** - Easy deployment with Docker Compose
- 🔌 **Nginx Proxy Manager Compatible** - Single port for UI and API

## Piece Size Selection

The application automatically determines piece size based on file size:

| File Size | Piece Size | Reason |
|-----------|------------|--------|
| < 128 MB | 64 KB | Keeps piece count reasonable |
| 128 MB - 1 GB | 256 KB | Good balance of efficiency |
| 1 - 4 GB | 512 KB | Standard for medium files |
| 4 - 16 GB | 1 MB | Reduces piece count |
| 16 - 64 GB | 2 MB | Avoids high piece counts |
| 64 - 256 GB | 4 MB | Large pieces reduce overhead |
| > 256 GB | 8 MB | Prevents multi-million pieces |

## Quick Start

### Using Docker Compose

1. Clone or download this repository
2. Run the application:

```bash
docker-compose up -d
```

3. Access the application at `http://localhost:3000`

### Nginx Proxy Manager Setup

1. In Nginx Proxy Manager, create a new proxy host
2. Set the forward hostname/IP to your Docker host
3. Set the forward port to `3000`
4. Enable WebSocket support (if available)
5. The application serves both UI and API on the same port, so no additional configuration is needed

## API Endpoints

### Upload

- `POST /api/upload/files` - Upload multiple files
- `POST /api/upload/directory` - Upload a directory (as zip)
- `POST /api/upload/chunk/init` - Initialize chunked upload
- `POST /api/upload/chunk` - Upload a file piece

### Download

- `GET /api/download/:fileId` - Download entire file
- `GET /api/download/:fileId?piece=N` - Download specific piece
- `GET /api/download/:fileId/info` - Get file metadata

### Files

- `GET /api/files` - List all files
- `DELETE /api/files/:fileId` - Delete a file

### Storage

- `GET /api/storage` - Get storage usage statistics

## Development

### Prerequisites

- Node.js 20+
- npm

### Setup

1. Install dependencies:

```bash
npm install
cd frontend && npm install
```

2. Start development server:

```bash
npm run dev
```

3. Build for production:

```bash
cd frontend && npm run build
npm start
```

## Data Storage

- **Database**: SQLite database stored in `./data/files.db`
- **Uploads**: Files stored in `./uploads/`
- Both directories are mounted as volumes in Docker

## Environment Variables

- `PORT` - Server port (default: 3000)
- `DATA_DIR` - Database directory (default: `./data`)
- `UPLOADS_DIR` - Upload directory (default: `./uploads`)
- `NODE_ENV` - Environment (default: `production`)
- `STORAGE_LIMIT` - Maximum storage limit (default: `100GB`)
  - Supports formats: `100GB`, `500MB`, `1TB`, `50GB`, etc.
  - Can also be specified as bytes (number)

## Storage Management

The application includes built-in storage limit tracking and management:

- **Storage Limit**: Configurable via `STORAGE_LIMIT` environment variable (default: 100GB)
- **Real-time Tracking**: Storage usage is displayed on the frontend with visual indicators
- **Upload Protection**: Uploads are blocked if they would exceed the storage limit
- **Visual Feedback**: 
  - Green: < 80% used
  - Yellow: 80-100% used (warning)
  - Red: 100% used (full)

The storage display shows:
- Total used / Total limit
- Available space
- Number of files
- Usage percentage with progress bar

## License

MIT

