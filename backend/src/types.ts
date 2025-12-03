import { ServerResponse } from 'http';
import { WriteStream } from 'fs';

/**
 * Represents an active file upload session.
 * Tracks the upload state and all active download connections.
 */
export interface UploadSession {
  /** Path to the file being written on disk */
  filePath: string;
  /** Write stream for the file */
  writeStream: WriteStream;
  /** Number of bytes uploaded so far */
  uploadedBytes: number;
  /** Whether the upload has completed */
  completed: boolean;
  /** Set of active download responses that should receive new chunks live */
  downloadResponses: Set<ServerResponse>;
}

/**
 * In-memory map of active upload sessions.
 * Key: fileId (string)
 * Value: UploadSession
 */
export type ActiveUploadsMap = Map<string, UploadSession>;

