import type { FileItem } from "../../types";

/**
 * Filesystem provider abstraction — the storage-agnostic contract between the
 * application/UI layer and whatever actually stores files.
 *
 * The UI depends ONLY on this interface. It never imports Tauri, Rust, HTTP
 * clients, or backend-specific modules. Implementations:
 *
 *   DesktopFilesystemProvider → Tauri → Rust → local OS filesystem
 *   CloudFilesystemProvider   → HTTP API → backend → cloud storage (future)
 *
 * Every provider speaks the same shared `FileItem` model, so views work
 * unchanged against either source of files.
 */

/** Free/total space of a storage volume. */
export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

/** Result of listing a directory; entries are already shared-model items. */
export interface DirListing {
  /** Provider-defined identifier of the listed directory (absolute local path on desktop). */
  path: string;
  /** Parent of the listed directory, or null at a root. */
  parentPath: string | null;
  /** Whether the listed directory is the provider's default location. */
  isHome: boolean;
  /** Directory entries mapped into the shared file model. */
  items: FileItem[];
}

/** Metadata of a single file or directory (no content is ever read). */
export interface FileMetadata {
  /** Last path component of the resolved (canonical) target. */
  name: string;
  /** Canonical absolute path of the resolved target. */
  path: string;
  isFile: boolean;
  isFolder: boolean;
  /** Size in bytes (0 for directories). */
  sizeBytes: number;
  /** Lowercased extension without the dot, or null for folders/extension-less files. */
  extension: string | null;
  /** Whether the name begins with a dot (the app's hidden-file convention). */
  isHidden: boolean;
  /** Human readable modified date, e.g. "Aug 24, 2026". */
  modified: string;
  /** Raw modification time in epoch seconds. */
  modifiedTs: number;
  /** Human readable creation date. */
  created: string;
  /** Raw creation time in epoch seconds. */
  createdTs: number;
  /** Human readable accessed date, when the platform provides one. */
  accessed: string | null;
  /** Raw accessed time in epoch seconds, when the platform provides one. */
  accessedTs: number | null;
}

export interface FilesystemProvider {
  /** The provider's default directory (user's home locally, account root in the cloud). */
  homeDirectory(): Promise<string>;

  /** List a directory; defaults to the provider's home when `path` is omitted. */
  listDirectory(path?: string): Promise<DirListing>;

  /** Create a new folder inside `dir`. */
  createFolder(dir: string, name: string): Promise<void>;

  /** Rename an item in place (name only — location is unchanged). */
  renameItem(from: string, newName: string): Promise<void>;

  /** Move an item into `destDir`, keeping its current name. */
  moveItem(source: string, destDir: string): Promise<void>;

  /** Permanently delete an item. The UI must confirm before calling this. */
  deleteItem(path: string): Promise<void>;

  /** Open an item with its default application/handler. */
  openItem(path: string): Promise<void>;

  /** Read metadata for a file or directory without touching its contents. */
  getFileMetadata(path: string): Promise<FileMetadata>;

  /** Read the raw bytes of a file (text, image, binary). */
  readFile(path: string): Promise<Uint8Array>;

  /** Write raw bytes to a file, creating it or overwriting an existing file. */
  writeFile(path: string, content: Uint8Array): Promise<void>;

  /** Copy an item (file, or folder recursively) into destDir, keeping its name. */
  copyItem(source: string, destDir: string): Promise<void>;

  /** Free/total space of the volume containing `path` (defaults to home). */
  diskUsage(path?: string): Promise<DiskUsage>;
}