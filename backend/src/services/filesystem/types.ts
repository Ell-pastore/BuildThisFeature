/**
 * Filesystem DTOs — mirrors the Rust desktop fs_service shapes so both surfaces
 * expose the same information. These are the output contract of the backend
 * filesystem service, returned by tool handlers.
 */

/** A single entry in a directory listing. */
export interface FileEntry {
  /** Stable identifier — currently the absolute path. */
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  isFile: boolean;
  sizeBytes: number;
  /** Number of children (directories only). */
  itemCount?: number;
  /** Lowercased file extension without the dot, or "folder". */
  fileType: string;
  /** Human-readable size, e.g. "2.4 MB" (folders render as "—"). */
  size: string;
  created: string;
  modified: string;
  /** Raw epoch-seconds modification time for numeric sorting. */
  modifiedTs: number;
  createdTs: number;
}

/** Result of listing a directory. */
export interface DirectoryListing {
  path: string;
  /** Parent directory path, or null at a root. */
  parentPath: string | null;
  /** Whether this is the provider's default/home location. */
  isHome: boolean;
  items: FileEntry[];
}

/** Metadata for a single file or directory — contents are never read. */
export interface FileMetadata {
  name: string;
  path: string;
  isFile: boolean;
  isFolder: boolean;
  /** Size in bytes (0 for directories). */
  sizeBytes: number;
  /** Lowercased extension without the dot, or null for folders. */
  extension: string | null;
  /** Whether the name begins with a dot (hidden-file convention). */
  isHidden: boolean;
  modified: string;
  modifiedTs: number;
  created: string;
  createdTs: number;
  /** null when the platform does not expose atime. */
  accessed: string | null;
  accessedTs: number | null;
}

/** Result of a recursive filename search. */
export interface SearchResult {
  path: string;
  name: string;
  /** Lowercased extension or "folder". */
  fileType: string;
  modified: string;
  modifiedTs: number;
  size: string;
  sizeBytes: number;
}
