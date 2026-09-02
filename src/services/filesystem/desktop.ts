import { invoke } from "@tauri-apps/api/core";
import type { FileItem } from "../../types";
import type { DirListing, DiskUsage, FilesystemProvider } from "./provider";

/**
 * DesktopFilesystemProvider — local filesystem access in the native desktop app.
 *
 * All access to the real filesystem goes through Tauri's `invoke` to the Rust
 * backend, which reads the OS filesystem. React never touches the filesystem
 * directly. The mapping between Rust's serialized responses and the shared
 * `FileItem` model lives here so it stays behind the provider boundary.
 */

/** Raw directory entry serialized by the Rust `list_directory` command. */
interface DirEntryResponse {
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

/** Raw `DirectoryListing` serialized by the Rust `list_directory` command. */
interface RawDirListing {
  path: string;
  parentPath: string | null;
  isHome: boolean;
  items: DirEntryResponse[];
}

/** Parent directory path of the given filesystem path. */
function parentPath(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx < 1) return p;
  return p.slice(0, idx);
}

/** Map a raw Rust entry into the shared FileItem model. */
function mapEntry(entry: DirEntryResponse): FileItem {
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

/**
 * Local filesystem provider backed by Tauri → Rust → the OS filesystem.
 * The desktop app works offline: no method involves the network.
 */
export class DesktopFilesystemProvider implements FilesystemProvider {
  homeDirectory(): Promise<string> {
    return invoke<string>("home_directory");
  }

  async listDirectory(path?: string): Promise<DirListing> {
    const raw = await invoke<RawDirListing>("list_directory", { path });
    return {
      path: raw.path,
      parentPath: raw.parentPath,
      isHome: raw.isHome,
      items: raw.items.map(mapEntry),
    };
  }

  createFolder(dir: string, name: string): Promise<void> {
    return invoke("create_folder", { dir, name });
  }

  renameItem(from: string, newName: string): Promise<void> {
    return invoke("rename_item", { from, newName });
  }

  moveItem(source: string, destDir: string): Promise<void> {
    return invoke("move_item", { source, destDir });
  }

  deleteItem(path: string): Promise<void> {
    return invoke("delete_item", { path });
  }

  openItem(path: string): Promise<void> {
    return invoke("open_item", { path });
  }

  diskUsage(path?: string): Promise<DiskUsage> {
    return invoke<DiskUsage>("disk_usage", { path });
  }
}