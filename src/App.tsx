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
import Duplicates from "./components/views/Duplicates";
import SmartFolders from "./components/views/SmartFolders";
import Storage from "./components/views/Storage";
import Settings from "./components/views/Settings";
import { list_directory, create_folder, rename_item, delete_item, move_item, open_item, disk_usage, mapEntry, type DirListing, type DiskUsage } from "./services/filesystem";
import { useStars } from "./services/stars";
import type { FileItem } from "./types";

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
export default function App() {
  const [view, setView] = useState<View>("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);

  // Real filesystem state driven by Tauri/Rust.
  const [dirPath, setDirPath] = useState<string>("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [isHome, setIsHome] = useState(true);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { isStarred, toggleStar } = useStars();

  // Real volume capacity reported by Rust (disk_usage). Null while loading or
  // when unavailable — never fabricated.
  const [diskUsage, setDiskUsage] = useState<DiskUsage | null>(null);

  useEffect(() => {
    disk_usage()
      .then(setDiskUsage)
      .catch(() => setDiskUsage(null));
  }, []);

  /** Load the given directory (defaults to the user's home directory). */
  const loadDir = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const listing: DirListing = await list_directory(path);
      setDirPath(listing.path);
      setParentPath(listing.parentPath);
      setIsHome(listing.isHome);
      // Map backend entries into the shared FileItem model.
      setFiles(listing.items.map(mapEntry));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Friendly hint when running in a plain browser rather than Tauri.
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

  function handleSearch(q: string) {
    setSearchQuery(q);
    setView("search");
  }

  /** Open the in-app preview overlay (existing Figma behavior). */
  function openPreview(file: FileItem) {
    setPreviewFile(file);
  }

  /** Ask the operating system to open the file with its default app. */
  async function openOnDisk(file: FileItem) {
    if (!file.path) return;
    try {
      await open_item(file.path);
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
      await create_folder(dirPath, name);
      await loadDir(dirPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doRename(item: FileItem, newName: string) {
    try {
      if (item.path) await rename_item(item.path, newName);
      await loadDir(dirPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doMove(item: FileItem, destDir: string) {
    try {
      if (item.path) await move_item(item.path, destDir);
      await loadDir(dirPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doDelete(item: FileItem) {
    try {
      if (item.path) await delete_item(item.path);
      if (previewFile?.path === item.path) setPreviewFile(null);
      await loadDir(dirPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function doToggleStar(item: FileItem) {
    toggleStar(item.path ?? item.id);
  }

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return seenFiles.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.type.toLowerCase().includes(q) ||
        (f.location && f.location.toLowerCase().includes(q)),
    );
  }, [seenFiles, searchQuery]);

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
            {view === "home" && <Home onOpenFile={openPreview} onNavigate={navigate} recentFiles={seenFiles} diskUsage={diskUsage} />}
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
                onRename={doRename}
                onDelete={doDelete}
                onMove={doMove}
                onToggleStar={doToggleStar}
              />
            )}
            {view === "recent" && <Recent onOpenFile={openPreview} recentFiles={seenFiles} />}
            {view === "starred" && (
              <Starred onOpenFile={openPreview} starredItems={seenFiles.filter((f) => f.starred)} />
            )}
            {view === "trash" && <Trash />}
            {view === "search" && <Search query={searchQuery} onOpenFile={openPreview} results={searchResults} />}
            {view === "ai-organization" && <AIOrganization />}
            {view === "duplicates" && <Duplicates />}
            {view === "smart-folders" && <SmartFolders />}
            {view === "storage" && <Storage diskUsage={diskUsage} />}
            {view === "settings" && <Settings />}
            {view === "ai-assistant" && (
              <div className="flex-1 flex items-center justify-center bg-background text-muted-foreground">
                <p className="text-sm">AI Assistant is open in the side panel →</p>
              </div>
            )}
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
          onRename={(name) => void doRename(previewFile, name)}
          onMove={(dest) => void doMove(previewFile, dest)}
        />
      )}
    </div>
  );
}