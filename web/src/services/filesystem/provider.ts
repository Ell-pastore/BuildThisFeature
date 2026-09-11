import type { FileItem, TrashItem } from "../../types";

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

/** Outcome of resolving a batch of persisted starred paths against the real filesystem. */
export interface StarredResolution {
  /** Starred paths that exist on disk, as normal real file items. */
  items: FileItem[];
  /** The original starred paths that could NOT be resolved (missing, deleted,
   * moved, invalid, or outside the allowed roots). Never fabricated. */
  missing: string[];
}

/** The seven extension-derived storage categories, in canonical display order. */
export const STORAGE_CATEGORY_NAMES = [
  "Documents",
  "Images",
  "Videos",
  "Audio",
  "Archives",
  "Code",
  "Other",
] as const;

export type StorageCategoryName = (typeof STORAGE_CATEGORY_NAMES)[number];

/** Real aggregated byte total for a single storage category. */
export interface StorageCategory {
  category: StorageCategoryName;
  bytes: number;
}

/** Real file sizes aggregated by extension-derived category from a single scan. */
export interface StorageBreakdown {
  /** Every category in canonical order, each with its real aggregated bytes. */
  categories: StorageCategory[];
  /** Sum of all category bytes (files classified during the scan). */
  totalBytes: number;
  /** Number of regular files scanned and classified. */
  scannedFileCount: number;
  /** True when the scan hit the provider's safety cap before finishing the
   * tree — totals then describe the scanned prefix, honestly. */
  scanCapped: boolean;
}

export interface FilesystemProvider {
  /** The provider's default directory (user's home locally, account root in the cloud). */
  homeDirectory(): Promise<string>;

  /** List a directory; defaults to the provider's home when `path` is omitted. */
  listDirectory(path?: string): Promise<DirListing>;

  /** Create a new folder inside `dir`. */
  createFolder(dir: string, name: string): Promise<void>;

  /** Create an empty file at the given path (full path including name). */
  createFile(path: string): Promise<string>;

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

  /** Recursively search filenames across all allowed roots. Returns both files and directories
   * whose names contain the (case-insensitive) query. Empty query returns an empty array. */
  searchFiles(query: string): Promise<FileItem[]>;

  /** Return up to `limit` (default 20) most recently modified files and folders across all
   * allowed roots, newest first. The result is hard-capped at `limit` by the provider. */
  recentFiles(limit?: number): Promise<FileItem[]>;

  /** Scan the allowed roots once and aggregate REAL file sizes by extension-derived category.
   * The provider bounds the scan (hard cap on files scanned) and reports `scanCapped` honestly. */
  storageByCategory(): Promise<StorageBreakdown>;

  /** Move an authorized file or folder into the application-managed trash. */
  trashItem(path: string): Promise<void>;

  /** Restore a genuine trash entry to its recorded original location. Resolves to the restored path. */
  restoreItem(trashedPath: string): Promise<string>;

  /** List the current contents of the application-managed trash. */
  listTrash(): Promise<TrashItem[]>;

  /** Load the user's starred absolute paths (application metadata, provider-persisted). */
  loadStarredPaths(): Promise<string[]>;

  /** Persist the user's starred absolute paths (application metadata). */
  saveStarredPaths(paths: string[]): Promise<void>;

  /** Resolve persisted starred absolute paths into real file items; unresolvable paths are reported in `missing`. */
  resolveStarredPaths(paths: string[]): Promise<StarredResolution>;

  /** Duplicate an item into the same parent with a collision-safe name: `name (copy).ext`, then `name (copy 2).ext`, etc. */
  duplicateItem(path: string): Promise<string>;
}