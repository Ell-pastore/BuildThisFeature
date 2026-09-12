import { invoke } from "@tauri-apps/api/core";
import type { FileItem, TrashItem } from "../../types";
import type {
  DirListing,
  DiskUsage,
  DuplicateGroup,
  DuplicateGroupsResult,
  FileMetadata,
  FilesystemProvider,
  SearchFilesResult,
  StarredResolution,
  StorageBreakdown,
  StorageCategory,
} from "./provider";

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

/** Raw trash entry serialized by the Rust `list_trash` command. */
interface RawTrashEntry {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  sizeBytes: number;
  fileType: string;
  size: string;
  created: string;
  modified: string;
  modifiedTs: number;
  createdTs: number;
  originalPath: string | null;
}

/** Raw `StarredResolution` serialized by the Rust `resolve_starred_paths` command. */
interface RawStarredResolution {
  items: DirEntryResponse[];
  missing: string[];
}

/** Raw storage category serialized by the Rust `storage_by_category` command. */
interface RawStorageCategory {
  category: string;
  bytes: number;
}

/** Raw `StorageBreakdown` serialized by the Rust `storage_by_category` command. */
interface RawStorageBreakdown {
  categories: RawStorageCategory[];
  totalBytes: number;
  scannedFileCount: number;
  scanCapped: boolean;
}

/** Raw `SearchFilesResult` serialized by the Rust `search_files` command. */
interface RawSearchFilesResult {
  entries: DirEntryResponse[];
  truncated: boolean;
}

/** Raw `DuplicateGroup` serialized by the Rust `duplicate_groups` command. */
interface RawDuplicateGroup {
  id: string;
  sizeBytes: number;
  size: string;
  items: DirEntryResponse[];
}

/** Raw `DuplicateGroupsResult` serialized by the Rust `duplicate_groups` command. */
interface RawDuplicateGroupsResult {
  groups: RawDuplicateGroup[];
  truncated: boolean;
}

/** Map a raw Rust storage category into the shared StorageCategory model. */
function mapStorageCategory(category: RawStorageCategory): StorageCategory {
  return { category: category.category as StorageCategory["category"], bytes: category.bytes };
}

/** Map a raw Rust trash entry into the shared TrashItem model. */
function mapTrashEntry(entry: RawTrashEntry): TrashItem {
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    isFolder: entry.isFolder,
    sizeBytes: entry.sizeBytes,
    fileType: entry.fileType,
    size: entry.size,
    created: entry.created,
    modified: entry.modified,
    createdTs: entry.createdTs,
    modifiedTs: entry.modifiedTs,
    originalPath: entry.originalPath,
  };
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

/** Map a raw Rust duplicate group into the shared DuplicateGroup model. The
 * group-level `id`/`sizeBytes`/`size` and the member order pass through
 * unchanged; only members are mapped into the shared FileItem shape. */
function mapDuplicateGroup(group: RawDuplicateGroup): DuplicateGroup {
  return {
    id: group.id,
    sizeBytes: group.sizeBytes,
    size: group.size,
    items: group.items.map(mapEntry),
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

  createFile(path: string): Promise<string> {
    return invoke<string>("create_file", { path });
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

  getFileMetadata(path: string): Promise<FileMetadata> {
    return invoke<FileMetadata>("get_file_metadata", { path });
  }

  readFile(path: string): Promise<Uint8Array> {
    return invoke<Uint8Array>("read_file", { path });
  }

  writeFile(path: string, content: Uint8Array): Promise<void> {
    return invoke<void>("write_file", { path, content });
  }

  copyItem(source: string, destDir: string): Promise<void> {
    return invoke("copy_item", { source, destDir });
  }

  moveFile(sourcePath: string, destinationPath: string): Promise<void> {
    return invoke("move_file", { source: sourcePath, destination: destinationPath });
  }

  diskUsage(path?: string): Promise<DiskUsage> {
    return invoke<DiskUsage>("disk_usage", { path });
  }

  searchFiles(query: string): Promise<SearchFilesResult> {
    return invoke<RawSearchFilesResult>("search_files", { query }).then((raw) => ({
      entries: raw.entries.map(mapEntry),
      truncated: raw.truncated,
    }));
  }

  recentFiles(limit?: number): Promise<FileItem[]> {
    return invoke<DirEntryResponse[]>("recent_files", { limit }).then((entries) =>
      entries.map(mapEntry),
    );
  }

  async storageByCategory(): Promise<StorageBreakdown> {
    const raw = await invoke<RawStorageBreakdown>("storage_by_category");
    return {
      categories: raw.categories.map(mapStorageCategory),
      totalBytes: raw.totalBytes,
      scannedFileCount: raw.scannedFileCount,
      scanCapped: raw.scanCapped,
    };
  }

  trashItem(path: string): Promise<void> {
    return invoke<void>("trash_item", { path });
  }

  restoreItem(trashedPath: string): Promise<string> {
    return invoke<string>("restore_item", { trashedPath });
  }

  listTrash(): Promise<TrashItem[]> {
    return invoke<RawTrashEntry[]>("list_trash").then((entries) => entries.map(mapTrashEntry));
  }

  permanentlyDeleteTrashItem(trashedPath: string): Promise<string> {
    return invoke<string>("permanently_delete_trash_item", { trashedPath });
  }

  loadStarredPaths(): Promise<string[]> {
    return invoke<string[]>("load_starred_paths");
  }

  saveStarredPaths(paths: string[]): Promise<void> {
    return invoke<void>("save_starred_paths", { paths });
  }

  resolveStarredPaths(paths: string[]): Promise<StarredResolution> {
    return invoke<RawStarredResolution>("resolve_starred_paths", { paths }).then((res) => ({
      items: res.items.map(mapEntry),
      missing: res.missing,
    }));
  }

  duplicateItem(path: string): Promise<string> {
    return invoke<string>("duplicate_item", { path });
  }

  duplicateGroups(): Promise<DuplicateGroupsResult> {
    return invoke<RawDuplicateGroupsResult>("duplicate_groups").then((raw) => ({
      groups: raw.groups.map(mapDuplicateGroup),
      truncated: raw.truncated,
    }));
  }
}