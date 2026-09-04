/**
 * Frontend file type labels used for icon/label rendering.
 *
 * Real filesystem items expose their lowercase file extension (without the
 * dot) as `type`; `FileType` is the set used by the UI for styling/filtering.
 */
export type FileType =
  | "pdf" | "docx" | "png" | "jpg" | "pptx" | "zip"
  | "mp4" | "txt" | "xlsx" | "csv" | "html" | "folder" | string;

/**
 * Single shared file/folder model used across the whole application.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for file items. Actual entries come from
 * Tauri/Rust (list_directory) and are mapped into this shape in
 * `src/services/filesystem.ts`. The frontend never hardcodes real file data —
 * the operating system filesystem is the source of truth.
 */
export interface FileItem {
  /** Stable identifier for the item (currently the absolute path). */
  id: string;
  name: string;
  /** File extension without the dot ("pdf", "docx", ...) or "folder". */
  type: string;
  /** Human readable size, e.g. "2.4 MB". */
  size: string;
  sizeBytes: number;
  /** Human readable modification date, e.g. "Aug 24, 2026". */
  modified: string;
  /** Human readable creation date. */
  created: string;
  createdTs?: number;
  /** Raw epoch-seconds modification time, used for numeric sorting. */
  modifiedTs?: number;
  /** Parent directory path, shown in previews/locations. */
  location: string;
  /** Absolute filesystem path. */
  path?: string;
  /** Whether the item is starred (application metadata, kept separately). */
  starred: boolean;
  isFolder?: boolean;
  itemCount?: number;
  deleted?: boolean;
  deletedOn?: string;
}