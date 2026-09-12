import { useCallback, useEffect, useMemo, useState } from "react";
import Sidebar from "./components/Sidebar";
import TopBar, { type Crumb } from "./components/TopBar";
import AIAssistant from "./components/AIAssistant";
import FilePreview from "./components/FilePreview";
import Home from "./components/views/Home";
import Files from "./components/views/Files";
import Recent from "./components/views/Recent";
import Starred from "./components/views/Starred";
import Trash from "./components/views/Trash";
import Search from "./components/views/Search";
import AIOrganization from "./components/views/AIOrganization";
import AIHistoryView from "./components/views/AIHistoryView";
import Duplicates from "./components/views/Duplicates";
import SmartFolders from "./components/views/SmartFolders";
import Storage from "./components/views/Storage";
import Settings from "./components/views/Settings";
import { getFilesystemProvider, type DirListing, type DiskUsage, type StorageBreakdown } from "./services/filesystem";
import { useStars } from "./services/stars";
import type { FileItem } from "./types";

/**
 * Single filesystem provider for the application layer. App code depends on
 * the FilesystemProvider abstraction only — never on Tauri/Rust directly.
 */
const filesystem = getFilesystemProvider();

type View =
  | "home" | "files" | "recent" | "starred" | "trash"
  | "search" | "ai-assistant" | "ai-organization" | "duplicates"
  | "smart-folders" | "storage" | "settings";

const staticCrumbs: Record<string, string[]> = {
  home: ["SmartFile"],
  recent: ["Recent"],
  starred: ["Starred"],
  trash: ["Trash"],
  search: ["Search"],
  "ai-assistant": ["AI", "Assistant"],
  "ai-organization": ["AI", "Organization"],
  duplicates: ["AI", "Duplicates"],
  "smart-folders": ["Smart Folders"],
  storage: ["Storage"],
  settings: ["Settings"],
};

/** Build clickable breadcrumbs from an absolute filesystem path. */
function buildPathCrumbs(path: string, onNavigate: (p: string) => void): Crumb[] {
  if (!path) return [];
  const segments = path.split(/[\\/]/).filter(Boolean);
  const crumbs: Crumb[] = [];
  let acc = "";
  for (const seg of segments) {
    acc = `${acc}${acc ? "/" : ""}${seg}`;
    const target = acc;
    crumbs.push({ label: seg, onClick: () => onNavigate(target) });
  }
  return crumbs;
}

/** Build a FileItem that reflects a successful leaf move into destDir. */
function movedItemPreview(item: FileItem, destDir: string): FileItem & { path: string } {
  const sep = destDir.includes("\\") && !destDir.includes("/") ? "\\" : "/";
  const newPath = destDir ? `${destDir}${sep}${item.name}` : item.name;
  return { ...item, id: newPath, path: newPath, location: destDir };
}

/** Build a FileItem that reflects a successful leaf rename. */
function renamedItemPreview(item: FileItem, newName: string): FileItem & { path: string } {
  const oldPath = item.path ?? item.id;
  const sepIdx = Math.max(oldPath.lastIndexOf("/"), oldPath.lastIndexOf("\\"));
  const parent = item.location || (sepIdx >= 0 ? oldPath.slice(0, sepIdx) : "");
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const newPath = parent ? `${parent}${sep}${newName}` : newName;
  const dot = newName.lastIndexOf(".");
  const type = item.isFolder ? "folder" : dot > 0 ? newName.slice(dot + 1).toLowerCase() : "file";
  return { ...item, id: newPath, path: newPath, name: newName, type, location: parent };
}

/** True when a listing error means the requested path itself no longer exists. */
function isDeadDirectoryError(msg: string): boolean {
  return (
    /no longer exists/i.test(msg) ||
    /no such file or directory/i.test(msg) ||
    /ENOENT/i.test(msg)
  );
}

/** Parent of an absolute path, or null at a filesystem root. */
function parentDirOf(p: string): string | null {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx < 1) return null;
  return p.slice(0, idx);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Whether `candidate` equals `home` or lives inside it. */
function isWithinHome(candidate: string, home: string): boolean {
  const c = normalizePath(candidate);
  const h = normalizePath(home);
  return c === h || c.startsWith(h.endsWith("/") ? h : `${h}/`);
}

function isHomePath(candidate: string, home: string): boolean {
  return normalizePath(candidate) === normalizePath(home);
}

/**
 * Climb from a dead directory path to the nearest still-listable directory,
 * never above the app home directory. Falls back to the home directory itself.
 * Returns null only when nothing in the chain can be listed — the caller then
 * keeps its normal error state.
 */
async function recoverFromDeadPath(path: string): Promise<DirListing | null> {
  let home: string | undefined;
  try {
    home = (await filesystem.homeDirectory()).trim() || undefined;
  } catch {
    home = undefined;
  }
  const candidates: string[] = [];
  let candidate = parentDirOf(path);
  while (candidate) {
    if (home === undefined || isWithinHome(candidate, home)) candidates.push(candidate);
    if (home !== undefined && isHomePath(candidate, home)) break;
    candidate = parentDirOf(candidate);
  }
  if (home !== undefined && !candidates.some((c) => isHomePath(c, home))) candidates.push(home);
  for (const c of candidates) {
    try {
      return await filesystem.listDirectory(c);
    } catch {
      // That ancestor is gone too; keep climbing toward the nearest valid one.
    }
  }
  return null;
}

export default function App() {
  const [view, setView] = useState<View>("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);

  // Real recursive desktop search state (search_files via the provider).
  const [searchResults, setSearchResults] = useState<FileItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Real filesystem state driven by Tauri/Rust.
  const [dirPath, setDirPath] = useState<string>("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [isHome, setIsHome] = useState(true);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { stars, isStarred, toggleStar, updateStarPath, removeStarPath } = useStars();

  // Starred view state: ALL persisted starred paths resolved against the real
  // filesystem (source of truth = the persisted star store), so stars outside
  // the currently loaded directory are shown too. `missing` is every persisted
  // path the filesystem could not resolve (deleted/moved/outside-allowlist).
  const [starredItems, setStarredItems] = useState<FileItem[]>([]);
  const [starredMissing, setStarredMissing] = useState<string[]>([]);
  const [starredLoading, setStarredLoading] = useState(false);
  const [starredError, setStarredError] = useState<string | null>(null);
  const [starredReloadKey, setStarredReloadKey] = useState(0);

  // Recent files state: the bounded, most-recently-modified items across ALL
  // allowed roots, served by the real recent_files scan (not the loaded dir).
  // Reloaded on demand via recentReloadKey (e.g. retry after an error).
  const [recentItems, setRecentItems] = useState<FileItem[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recentReloadKey, setRecentReloadKey] = useState(0);
  const [trashReloadKey, setTrashReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRecentLoading(true);
    setRecentError(null);
    filesystem
      .recentFiles()
      .then((items) => {
        if (cancelled) return;
        setRecentItems(items);
      })
      .catch((err) => {
        if (cancelled) return;
        setRecentError(err instanceof Error ? err.message : String(err));
        setRecentItems([]);
      })
      .finally(() => {
        if (!cancelled) setRecentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [recentReloadKey]);

  useEffect(() => {
    let cancelled = false;
    setStarredLoading(true);
    setStarredError(null);
    filesystem
      .resolveStarredPaths(stars)
      .then((res) => {
        if (cancelled) return;
        setStarredItems(res.items.map((f) => ({ ...f, starred: true })));
        setStarredMissing(res.missing);
      })
      .catch((err) => {
        if (cancelled) return;
        setStarredError(err instanceof Error ? err.message : String(err));
        setStarredItems([]);
        setStarredMissing([]);
      })
      .finally(() => {
        if (!cancelled) setStarredLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stars, starredReloadKey]);

  // Real volume capacity reported by Rust (disk_usage). Null while loading or
  // when unavailable — never fabricated.
  const [diskUsage, setDiskUsage] = useState<DiskUsage | null>(null);

  useEffect(() => {
    filesystem
      .diskUsage()
      .then(setDiskUsage)
      .catch(() => setDiskUsage(null));
  }, []);

  // Storage "By Category" state: REAL file sizes aggregated by extension by the
  // bounded `storage_by_category` scan. Scanned lazily when the Storage view
  // first opens (a full-tree scan shouldn't run at app startup), then reloaded
  // on demand via storageReloadKey (e.g. retry after a transient error).
  const [storageBreakdown, setStorageBreakdown] = useState<StorageBreakdown | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageReloadKey, setStorageReloadKey] = useState(0);

  useEffect(() => {
    if (view !== "storage") return;
    let cancelled = false;
    setStorageLoading(true);
    setStorageError(null);
    filesystem
      .storageByCategory()
      .then((breakdown) => {
        if (cancelled) return;
        setStorageBreakdown(breakdown);
      })
      .catch((err) => {
        if (cancelled) return;
        setStorageError(err instanceof Error ? err.message : String(err));
        setStorageBreakdown(null);
      })
      .finally(() => {
        if (!cancelled) setStorageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, storageReloadKey]);

  /** Load the given directory (defaults to the user's home directory). */
  const loadDir = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const listing = await filesystem.listDirectory(path);
      setDirPath(listing.path);
      setParentPath(listing.parentPath);
      setIsHome(listing.isHome);
      // Entries arrive already mapped into the shared FileItem model.
      setFiles(listing.items);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A previously valid directory can disappear when its folder is renamed,
      // moved, or deleted elsewhere. Recover to the nearest valid parent/home
      // directory instead of parking the Files view on a dead path error with
      // stale breadcrumbs. Genuine failures (permissions, not-a-folder, unavailable
      // home, path outside the allowlist) keep their normal error state.
      if (path && isDeadDirectoryError(msg)) {
        const recovered = await recoverFromDeadPath(path);
        if (recovered) {
          setDirPath(recovered.path);
          setParentPath(recovered.parentPath);
          setIsHome(recovered.isHome);
          setFiles(recovered.items);
          return;
        }
      }
      setError(msg.includes("__TAURI") || /no tauri/i.test(msg)
        ? "Run this app inside the Tauri desktop shell to browse your files."
        : msg);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load the home directory on startup.
  useEffect(() => {
    void loadDir();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Directory items annotated with the current star state.
  const seenFiles = useMemo(
    () => files.map((f) => ({ ...f, starred: isStarred(f.path ?? f.id) })),
    [files, isStarred],
  );

  function navigate(v: string) {
    setView(v as View);
    if (v === "ai-assistant") setAiOpen(true);
  }

  function navigateToPath(p: string) {
    setView("files");
    void loadDir(p);
  }

  // Only the Files view shows a real filesystem breadcrumb; other views use a
  // static page title.
  const breadcrumbs: Crumb[] =
    view === "files"
      ? buildPathCrumbs(dirPath, navigateToPath)
      : (staticCrumbs[view] ?? ["SmartFile"]).map((label) => ({ label }));

  const handleSearch = (q: string) => {
    setSearchQuery(q);
    setView("search");
    void runSearch(q);
  };

  /**
   * Real desktop search: the recursive `search_files` Rust command via the
   * filesystem provider, across ALL allowed roots — not the loaded directory.
   * Empty/whitespace queries never touch the filesystem and clear results.
   */
  async function runSearch(query: string) {
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const found = await filesystem.searchFiles(q);
      // Search entries are real provider FileItems; stars are the same
      // localStorage annotation the rest of the app applies.
      setSearchResults(found.map((f) => ({ ...f, starred: isStarred(f.path ?? f.id) })));
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  /** Open the in-app preview overlay (existing Figma behavior). */
  function openPreview(file: FileItem) {
    setPreviewFile(file);
  }

  /** Ask the operating system to open the file with its default app. */
  async function openOnDisk(file: FileItem) {
    if (!file.path) return;
    try {
      await filesystem.openItem(file.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function openFolder(file: FileItem) {
    if (file.isFolder && file.path) {
      setView("files");
      void loadDir(file.path);
    }
  }
  async function createNewFolder(name: string) {
    try {
      await filesystem.createFolder(dirPath, name);
      await loadDir(dirPath);
      refreshDerivedState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createNewFile(name: string) {
    try {
      const sep = dirPath.endsWith("/") ? "" : "/";
      await filesystem.createFile(`${dirPath}${sep}${name}`);
      await loadDir(dirPath);
      refreshDerivedState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * After a successful filesystem mutation, re-read the derived filesystem
   * views (Recent, Storage) and re-run an already-open Search so none of them
   * show stale results. Storage's effect guards on `view`, so bumping its key
   * costs nothing until the Storage view is actually open.
   */
  function refreshDerivedState() {
    setRecentReloadKey((k) => k + 1);
    setStorageReloadKey((k) => k + 1);
    if (view === "search" && searchQuery.trim()) void runSearch(searchQuery);
  }

  async function doRename(item: FileItem, newName: string): Promise<string | null> {
    const name = newName.trim();
    if (!name) return "Name cannot be empty";
    try {
      if (item.path) await filesystem.renameItem(item.path, name);
      await loadDir(dirPath);
      if (previewFile?.path === item.path) {
        setPreviewFile(renamedItemPreview(item, name));
      }
      const oldPath = item.path;
      if (oldPath) {
        // Keep a star pointing at the renamed item, not its stale old path.
        updateStarPath(oldPath, renamedItemPreview(item, name).path);
      }
      // Re-read Recent/Storage and re-run an open Search after the change.
      refreshDerivedState();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async function doMove(item: FileItem, destDir: string) {
    try {
      if (item.path) await filesystem.moveItem(item.path, destDir);
      await loadDir(dirPath);
      if (previewFile?.path === item.path) {
        // Keep the open preview pointing at the moved item so later actions
        // (Open/Rename/Star/Delete) target the new location, not the old path.
        setPreviewFile(movedItemPreview(item, destDir));
      }
      const oldPath = item.path;
      if (oldPath) {
        // Keep a star pointing at the moved item, not its stale old path.
        updateStarPath(oldPath, movedItemPreview(item, destDir).path);
      }
      // Re-read Recent/Storage and re-run an open Search after the change.
      refreshDerivedState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doCopy(items: FileItem[], destDir: string) {
    try {
      for (const item of items) {
        if (item.path) await filesystem.copyItem(item.path, destDir);
      }
      await loadDir(dirPath);
      refreshDerivedState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doDuplicate(item: FileItem) {
    try {
      if (item.path) await filesystem.duplicateItem(item.path);
      await loadDir(dirPath);
      refreshDerivedState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doDelete(item: FileItem) {
    try {
      // The normal Delete action moves an item to the app-managed trash —
      // never a permanent delete.
      if (item.path) await filesystem.trashItem(item.path);
      if (item.path) {
        // The item no longer exists at its path, so release any stale star.
        removeStarPath(item.path);
      }
      if (previewFile?.path === item.path) setPreviewFile(null);
      await loadDir(dirPath);
      // Re-read Recent/Storage and re-run an open Search after the change.
      refreshDerivedState();
      // Refresh an open Trash view: its mount-load re-reads the real trash.
      setTrashReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function doToggleStar(item: FileItem) {
    toggleStar(item.path ?? item.id);
  }

  return (
    <div className="h-full flex bg-background overflow-hidden" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <Sidebar
        currentView={view}
        onNavigate={navigate}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar
          breadcrumb={breadcrumbs}
          onSearch={handleSearch}
          onOpenAI={() => setAiOpen((v) => !v)}
        />

        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 flex overflow-hidden">
            {view === "home" && <Home onOpenFile={openPreview} onOpenFolder={openFolder} onNavigate={navigate} recentFiles={seenFiles} diskUsage={diskUsage} />}
            {view === "files" && (
              <Files
                items={seenFiles}
                loading={loading}
                error={error}
                path={dirPath}
                isHome={isHome}
                onUp={() => parentPath && void loadDir(parentPath)}
                onOpenFolder={openFolder}
                onOpenPreview={openPreview}
                onOpenDisk={openOnDisk}
                onNewFolder={createNewFolder}
                onNewFile={createNewFile}
                onRename={doRename}
                onDelete={doDelete}
                onMove={doMove}
                onCopy={(item, dest) => void doCopy([item], dest)}
                onDuplicate={doDuplicate}
                onToggleStar={doToggleStar}
                onRefresh={() => void loadDir(dirPath)}
              />
            )}
            {view === "recent" && (
              <Recent
                onOpenFile={openPreview}
                onOpenFolder={openFolder}
                items={recentItems}
                loading={recentLoading}
                error={recentError}
                onRetry={() => setRecentReloadKey((k) => k + 1)}
              />
            )}
            {view === "starred" && (
              <Starred
                onOpenFile={openPreview}
                onOpenFolder={openFolder}
                items={starredItems}
                missingPaths={starredMissing}
                loading={starredLoading}
                error={starredError}
                onRetry={() => setStarredReloadKey((k) => k + 1)}
              />
            )}
            {view === "trash" && <Trash key={trashReloadKey} />}
            {view === "search" && (
              <Search
                query={searchQuery}
                searching={searching}
                error={searchError}
                onOpenFile={openPreview}
                onOpenFolder={openFolder}
                results={searchResults}
              />
            )}
            {view === "ai-organization" && <AIOrganization />}
            {view === "duplicates" && <Duplicates />}
            {view === "smart-folders" && <SmartFolders />}
            {view === "storage" && (
              <Storage
                diskUsage={diskUsage}
                breakdown={storageBreakdown}
                loading={storageLoading}
                error={storageError}
                onRetry={() => setStorageReloadKey((k) => k + 1)}
              />
            )}
            {view === "settings" && <Settings />}
            {view === "ai-assistant" && <AIHistoryView />}
          </div>

          {aiOpen && (
            <AIAssistant
              onClose={() => {
                setAiOpen(false);
                if (view === "ai-assistant") setView("home");
              }}
            />
          )}
        </div>
      </div>

      {previewFile && (
        <FilePreview
          file={previewFile}
          onClose={() => setPreviewFile(null)}
          onOpen={() => void openOnDisk(previewFile)}
          onStar={() => doToggleStar(previewFile)}
          onDelete={() => void doDelete(previewFile)}
          onRename={(name) => doRename(previewFile, name)}
          onMove={(dest) => void doMove(previewFile, dest)}
          onCopy={(dest) => void doCopy([previewFile], dest)}
          onDuplicate={() => void doDuplicate(previewFile)}
        />
      )}
    </div>
  );
}