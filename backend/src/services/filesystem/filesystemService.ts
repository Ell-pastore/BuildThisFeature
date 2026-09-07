/**
 * Filesystem service — the backend application layer for read-only
 * filesystem operations.
 *
 * This is the SEAM between tool handlers and the actual filesystem. The
 * model intentionally mirrors the desktop's Phase 8 service so the same
 * security semantics apply on both sides:
 *
 *   1. canonicalize the target (resolve `..`, resolve symlinks);
 *   2. gate the canonical path through the AllowList;
 *   3. only then perform the filesystem call.
 *
 * No tool handler may bypass this service to access `fs` directly.
 */
import { promises as fs, type Stats } from "node:fs";
import * as path from "node:path";

import { AllowList } from "./allowList.js";
import type {
  DirectoryListing,
  FileEntry,
  FileMetadata,
  SearchResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable, machine-readable error codes for filesystem operations. */
export const FilesystemErrorCode = {
  NotFound: "filesystem/not-found",
  PermissionDenied: "filesystem/permission-denied",
  NotADirectory: "filesystem/not-a-directory",
  NotAFile: "filesystem/not-a-file",
  InvalidPath: "filesystem/invalid-path",
  NotAllowed: "filesystem/not-allowed",
  IoError: "filesystem/io-error",
} as const;
export type FilesystemErrorCode =
  (typeof FilesystemErrorCode)[keyof typeof FilesystemErrorCode];

export class FilesystemError extends Error {
  constructor(
    readonly code: FilesystemErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FilesystemError";
  }
}

export function isFilesystemError(error: unknown): error is FilesystemError {
  return error instanceof FilesystemError;
}

function mapIoError(err: NodeJS.ErrnoException): FilesystemError {
  switch (err.code) {
    case "ENOENT":
      return new FilesystemError(
        FilesystemErrorCode.NotFound,
        "The file or folder does not exist.",
      );
    case "EACCES":
    case "EPERM":
      return new FilesystemError(
        FilesystemErrorCode.PermissionDenied,
        "Permission denied.",
      );
    case "ENOTDIR":
      return new FilesystemError(
        FilesystemErrorCode.NotADirectory,
        "The selected path is not a folder.",
      );
    case "EISDIR":
      return new FilesystemError(
        FilesystemErrorCode.NotAFile,
        "The selected path is a folder, not a file.",
      );
    default:
      return new FilesystemError(
        FilesystemErrorCode.IoError,
        "An I/O error occurred while accessing the filesystem.",
      );
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a numeric size into a compact human-readable string. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} ${units[unit]}`;
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Format a Date as e.g. "Aug 24, 2026". */
function formatDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) return "—";
  const month = MONTHS[value.getMonth()] ?? "—";
  return `${month} ${value.getDate()}, ${value.getFullYear()}`;
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx + 1).toLowerCase();
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface FilesystemServiceOptions {
  allowList: AllowList;
  /**
   * Path considered the user's "home" root. When the listed directory is
   * this path, `isHome` is true in the response. Optional.
   */
  homePath?: string | null;
}

export class FilesystemService {
  private readonly allowList: AllowList;
  private readonly homeCanonical: string | null;

  constructor(options: FilesystemServiceOptions) {
    this.allowList = options.allowList;
    this.homeCanonical = options.homePath
      ? AllowList.tryCanonicalize(options.homePath)
      : null;
  }

  /** Expose the AllowList for callers that need to inspect configuration. */
  getAllowList(): AllowList {
    return this.allowList;
  }

  /**
   * Resolve a path string to its canonical form, verify the AllowList
   * admits it, and return the canonical path. Centralizes the
   * "canonicalize-then-authorize" pattern used by every operation.
   */
  private resolveAndAuthorize(rawPath: string): string {
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      throw new FilesystemError(
        FilesystemErrorCode.InvalidPath,
        "A path is required.",
      );
    }
    const canonical = AllowList.tryCanonicalize(rawPath);
    if (canonical === null) {
      throw new FilesystemError(
        FilesystemErrorCode.NotFound,
        "The file or folder does not exist.",
      );
    }
    if (!this.allowList.isAllowed(canonical)) {
      throw new FilesystemError(
        FilesystemErrorCode.NotAllowed,
        "Access to this path is not permitted.",
      );
    }
    return canonical;
  }

  /**
   * List the immediate children of a directory. The directory is gated by
   * the AllowList. Hidden entries are NOT filtered out — the caller can
   * decide what to show.
   */
  async listDirectory(rawPath: string): Promise<DirectoryListing> {
    const canonical = this.resolveAndAuthorize(rawPath);
    let stats: Stats;
    try {
      stats = await fs.stat(canonical);
    } catch (err) {
      throw mapIoError(err as NodeJS.ErrnoException);
    }
    if (!stats.isDirectory()) {
      throw new FilesystemError(
        FilesystemErrorCode.NotADirectory,
        "The selected path is not a folder.",
      );
    }
    const dirents = await fs.readdir(canonical, { withFileTypes: true });
    const items: FileEntry[] = [];
    for (const dirent of dirents) {
      try {
        const entry = await this.entryFromDirent(canonical, dirent);
        items.push(entry);
      } catch {
        // Skip entries we cannot stat (broken symlinks, race conditions).
        continue;
      }
    }
    const parent = path.dirname(canonical);
    const parentPath =
      parent === canonical ? null : this.parentOrNull(parent);
    return {
      path: canonical,
      parentPath,
      isHome: this.homeCanonical !== null && this.homeCanonical === canonical,
      items,
    };
  }

  private parentOrNull(parentCanonical: string): string | null {
    if (this.allowList.isAllowed(parentCanonical)) return parentCanonical;
    return null;
  }

  private async entryFromDirent(
    parentCanonical: string,
    dirent: import("node:fs").Dirent,
  ): Promise<FileEntry> {
    const full = path.join(parentCanonical, dirent.name);
    const stat = await fs.stat(full);
    const isFolder = stat.isDirectory();
    const isFile = stat.isFile();
    const sizeBytes = isFile ? stat.size : 0;
    const ext = isFolder ? "" : extensionOf(dirent.name);
    const fileType = isFolder ? "folder" : ext;
    const modified = stat.mtime;
    const created = stat.birthtime.getTime() > 0 ? stat.birthtime : modified;
    const itemCount = isFolder
      ? await this.safeChildCount(full)
      : undefined;
    return {
      id: full,
      name: dirent.name,
      path: full,
      isFolder,
      isFile,
      sizeBytes,
      itemCount,
      fileType,
      size: isFolder ? "—" : formatSize(sizeBytes),
      created: formatDate(created),
      modified: formatDate(modified),
      modifiedTs: Math.floor(modified.getTime() / 1000),
      createdTs: Math.floor(created.getTime() / 1000),
    };
  }

  private async safeChildCount(dir: string): Promise<number | undefined> {
    try {
      const childDirents = await fs.readdir(dir, { withFileTypes: true });
      let count = 0;
      for (const child of childDirents) {
        if (child.isDirectory() || child.isFile() || child.isSymbolicLink()) {
          count += 1;
        }
      }
      return count;
    } catch {
      return undefined;
    }
  }

  /**
   * Read the metadata of a single file or directory WITHOUT reading its
   * contents. The target is canonicalized and gated.
   */
  async getFileMetadata(rawPath: string): Promise<FileMetadata> {
    const canonical = this.resolveAndAuthorize(rawPath);
    let stat: Stats;
    try {
      stat = await fs.stat(canonical);
    } catch (err) {
      throw mapIoError(err as NodeJS.ErrnoException);
    }
    const isFile = stat.isFile();
    const isFolder = stat.isDirectory();
    const name = path.basename(canonical);
    const extension = isFolder ? null : extensionOf(name) || null;
    const modified = stat.mtime;
    const created = stat.birthtime.getTime() > 0 ? stat.birthtime : modified;
    const accessed = stat.atime;
    return {
      name,
      path: canonical,
      isFile,
      isFolder,
      sizeBytes: isFile ? stat.size : 0,
      extension,
      isHidden: isHidden(name),
      modified: formatDate(modified),
      modifiedTs: Math.floor(modified.getTime() / 1000),
      created: formatDate(created),
      createdTs: Math.floor(created.getTime() / 1000),
      accessed: formatDate(accessed),
      accessedTs: Math.floor(accessed.getTime() / 1000),
    };
  }

  /**
   * Read the raw bytes of a file. The path is canonicalized and gated.
   * The result is a `Buffer`; callers can decode with `Buffer.toString("utf8")`.
   * Size is bounded by `maxBytes` (default 64 MiB) so large files cannot
   * exhaust server memory.
   */
  async readFile(
    rawPath: string,
    options: { maxBytes?: number } = {},
  ): Promise<Buffer> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;
    const canonical = this.resolveAndAuthorize(rawPath);
    let stat: Stats;
    try {
      stat = await fs.stat(canonical);
    } catch (err) {
      throw mapIoError(err as NodeJS.ErrnoException);
    }
    if (stat.isDirectory()) {
      throw new FilesystemError(
        FilesystemErrorCode.NotAFile,
        "The selected path is a folder, not a file.",
      );
    }
    if (stat.size > maxBytes) {
      throw new FilesystemError(
        FilesystemErrorCode.IoError,
        `File is too large to read (limit: ${maxBytes} bytes).`,
      );
    }
    try {
      return await fs.readFile(canonical);
    } catch (err) {
      throw mapIoError(err as NodeJS.ErrnoException);
    }
  }

  /**
   * Recursively search for files whose name (case-insensitive) contains
   * the given substring. Walks only inside the allowed roots. Any path
   * that fails the AllowList gate is pruned, so a symlink escape cannot
   * leak the result.
   */
  async searchFiles(query: string): Promise<SearchResult[]> {
    const trimmed = (query ?? "").trim();
    if (trimmed.length === 0) return [];
    const needle = trimmed.toLowerCase();
    const results: SearchResult[] = [];
    const visited = new Set<string>();
    for (const root of this.allowList.getRoots()) {
      await this.walk(root, needle, results, visited);
    }
    results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return results;
  }

  private async walk(
    current: string,
    needle: string,
    results: SearchResult[],
    visited: Set<string>,
  ): Promise<void> {
    if (visited.has(current)) return;
    visited.add(current);
    if (!this.allowList.isAllowed(current)) return;

    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const child = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        if (this.allowList.isAllowed(child)) {
          await this.walk(child, needle, results, visited);
        }
        continue;
      }
      if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
      if (!dirent.name.toLowerCase().includes(needle)) continue;

      // Only emit results for files that pass canonicalization + gate.
      const canonical = AllowList.tryCanonicalize(child);
      if (canonical === null) continue;
      if (!this.allowList.isAllowed(canonical)) continue;
      let stat: Stats;
      try {
        stat = await fs.stat(canonical);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const modified = stat.mtime;
      results.push({
        path: canonical,
        name: dirent.name,
        fileType: extensionOf(dirent.name) || "",
        modified: formatDate(modified),
        modifiedTs: Math.floor(modified.getTime() / 1000),
        size: formatSize(stat.size),
        sizeBytes: stat.size,
      });
    }
  }
}

/** Default upper bound on `readFile` — 64 MiB. */
const DEFAULT_MAX_READ_BYTES = 64 * 1024 * 1024;



