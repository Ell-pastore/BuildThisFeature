import { invoke } from "@tauri-apps/api/core";
import type { FileItem } from "../types";

/**
 * Filesystem service.
 *
 * All access to the real filesystem goes through Tauri's `invoke` to the Rust
 * backend. React never touches the filesystem directly — it requests data and
 * Rust reads the OS filesystem. The mapping between Rust's serialized response
 * and the shared frontend `FileItem` type lives here so it is in one place.
 */

/** Raw directory entry serialized by the Rust `list_directory` command. */
export interface DirEntryResponse {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  sizeBytes: number;
  itemCount: number | null;
  fileType: string;
  size: string;
  created: string;
  modified: string;
  modifiedTs: number;
  createdTs: number;
}

/** Result of listing a directory. */
export interface DirListing {
  path: string;
  parentPath: string | null;
  isHome: boolean;
  items: DirEntryResponse[];
}

/** Parent directory path of the given filesystem path. */
export function parentPath(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx < 1) return p;
  return p.slice(0, idx);
}

/** Map a raw Rust entry into the shared FileItem model. */
export function mapEntry(entry: DirEntryResponse): FileItem {
  const isFolder = entry.isFolder;
  return {
    id: entry.path,
    name: entry.name,
    type: isFolder ? "folder" : entry.fileType || "file",
    size: entry.size,
    sizeBytes: entry.sizeBytes,
    modified: entry.modified,
    created: entry.created,
    modifiedTs: entry.modifiedTs,
    createdTs: entry.createdTs,
    location: parentPath(entry.path),
    path: entry.path,
    starred: false,
    isFolder,
    itemCount: entry.itemCount ?? 0,
  };
}

export function list_directory(path?: string): Promise<DirListing> {
  return invoke<DirListing>("list_directory", { path });
}

export function home_directory(): Promise<string> {
  return invoke<string>("home_directory");
}

export function create_folder(dir: string, name: string): Promise<void> {
  return invoke("create_folder", { dir, name });
}

export function rename_item(from: string, newName: string): Promise<void> {
  return invoke("rename_item", { from, newName });
}

export function delete_item(path: string): Promise<void> {
  return invoke("delete_item", { path });
}

export function move_item(source: string, destDir: string): Promise<void> {
  return invoke("move_item", { source, destDir });
}

export function open_item(path: string): Promise<void> {
  return invoke("open_item", { path });
}

/** Real free/total space of the volume containing `path` (defaults to home). */
export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

export function disk_usage(path?: string): Promise<DiskUsage> {
  return invoke<DiskUsage>("disk_usage", { path });
}