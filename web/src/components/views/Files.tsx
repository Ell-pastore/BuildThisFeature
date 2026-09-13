import { useEffect, useMemo, useState } from "react";
import {
  LayoutGrid,
  List,
  Plus,
  RefreshCw,
  Upload,
  ArrowUpDown,
  Filter,
  MoreHorizontal,
  ExternalLink,
  Share2,
  Copy,
  Edit2,
  Move,
  Star,
  Trash2,
  ChevronRight,
  ChevronLeft,
} from "../../components/Icons";
import FileIcon from "../FileIcon";
import MoveFolderDialog from "../MoveFolderDialog";
import FileUpload from "../FileUpload";
import type { FileItem } from "../../types";

interface FilesProps {
  items: FileItem[];
  loading: boolean;
  error: string | null;
  path: string;
  isHome: boolean;
  onUp: () => void;
  onOpenFolder: (item: FileItem) => void;
  onOpenPreview: (item: FileItem) => void;
  onOpenDisk: (item: FileItem) => void;
  onNewFolder: (name: string) => void;
  onNewFile: (name: string) => void;
  onRename: (item: FileItem, newName: string) => Promise<string | null> | string | null | void;
  onDelete: (item: FileItem) => void;
  onMove: (item: FileItem, destDir: string) => void;
  onCopy: (item: FileItem, destDir: string) => void;
  onDuplicate: (item: FileItem) => void;
  onToggleStar: (item: FileItem) => void;
  onRefresh: () => void;
  onUploaded: () => void;
  /** Persisted "Default view" setting; falls back to list. */
  defaultViewMode?: "list" | "grid";
  /** Persisted "Sort files by" setting; falls back to modified. */
  defaultSort?: SortKey;
  /** Persisted "Confirm before deleting" setting; defaults to asking. */
  confirmDelete?: boolean;
  /** Bump to reopen the New folder/file modal (the ⌘N shortcut). */
  newFolderSignal?: number;
  /** Reports the currently selected items so App shortcuts can act on them. */
  onSelectionChange?: (items: FileItem[]) => void;
}

type SortKey = "name" | "modified" | "size";

const LARGE_FILE_BYTES = 100 * 1024 * 1024;
const DAY_SECONDS = 24 * 60 * 60;

// Same type categories as the Search "More Filters" panel, so the two filters
// agree on what a PDF / Document / Image / Video is.
const TYPE_FILTERS: Record<string, Set<string>> = {
  PDF: new Set(["pdf"]),
  Documents: new Set([
    "txt", "rtf", "doc", "docx", "odt", "xls", "xlsx", "csv", "ods", "ppt",
    "pptx", "odp", "pages", "numbers", "keynote", "md", "tex", "epub", "mobi",
    "log",
  ]),
  Images: new Set([
    "jpg", "jpeg", "png", "gif", "bmp", "tiff", "tif", "webp", "svg", "ico",
    "heic", "heif", "raw", "psd", "ai", "eps",
  ]),
  Videos: new Set([
    "mp4", "mov", "mkv", "avi", "webm", "flv", "wmv", "m4v", "m2ts", "3gp",
    "mpg", "mpeg",
  ]),
};

function chipClass(active: boolean) {
  return `px-3 py-1 rounded-full text-xs font-medium transition-colors ${
    active
      ? "bg-foreground text-primary-foreground"
      : "bg-secondary text-muted-foreground hover:bg-border"
  }`;
}

export default function Files({
  items,
  loading,
  error,
  path,
  isHome,
  onUp,
  onOpenFolder,
  onOpenPreview,
  onOpenDisk,
  onNewFolder,
  onNewFile,
  onRename,
  onDelete,
  onMove,
  onCopy,
  onDuplicate,
  onToggleStar,
  onRefresh,
  onUploaded,
  defaultViewMode = "list",
  defaultSort = "modified",
  confirmDelete = true,
  newFolderSignal = 0,
  onSelectionChange,
}: FilesProps) {
  const [viewMode, setViewMode] = useState<"list" | "grid">(defaultViewMode);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<SortKey>(defaultSort);

  // Follow the persisted settings when they change (e.g. after editing them in
  // Settings). In-app toggles still work until a setting is edited.
  useEffect(() => {
    setViewMode(defaultViewMode);
  }, [defaultViewMode]);
  useEffect(() => {
    setSortBy(defaultSort);
  }, [defaultSort]);

  // Reopen the New modal on a ⌘N signal from the app-level shortcut handler.
  useEffect(() => {
    if (newFolderSignal > 0) {
      setNewOpen(true);
      setNewKind("folder");
      setNewName("");
    }
  }, [newFolderSignal]);

  // Client-side filtering over the already-loaded directory entries. No
  // filesystem re-query happens when these change.
  const [filterOpen, setFilterOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState("All");
  const [sizeFilter, setSizeFilter] = useState<"Any" | "Large">("Any");
  const [modifiedFilter, setModifiedFilter] = useState<
    "Any" | "Past 7 days" | "Past 30 days"
  >("Any");

  // Local modal/flow state.
  const [newOpen, setNewOpen] = useState(false);
  const [newKind, setNewKind] = useState<"folder" | "file">("folder");
  const [newName, setNewName] = useState("");
  const [renameItem, setRenameItem] = useState<FileItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [moveItem, setMoveItem] = useState<FileItem | null>(null);
  const [copyItems, setCopyItems] = useState<FileItem[]>([]);
  const [deleteItem, setDeleteItem] = useState<FileItem | null>(null);

  async function submitRename() {
    const name = renameValue.trim();
    if (!renameItem || !name || renaming) return;
    setRenaming(true);
    setRenameError(null);
    const result = await onRename(renameItem, name);
    setRenaming(false);
    if (result) {
      setRenameError(result);
      return;
    }
    setRenameItem(null);
  }

  function toggleSelect(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Filters compose with AND semantics; folders always survive type/size
  // filtering so browsing directories is never blocked.
  const filtered = items.filter((item) => {
    const matchesType =
      typeFilter === "All" ||
      item.isFolder ||
      (TYPE_FILTERS[typeFilter]?.has(item.type.toLowerCase()) ?? false);
    const matchesSize =
      sizeFilter === "Any" || item.isFolder || item.sizeBytes >= LARGE_FILE_BYTES;
    const matchesModified =
      modifiedFilter === "Any" ||
      !item.modifiedTs ||
      item.modifiedTs >=
        Date.now() / 1000 - (modifiedFilter === "Past 7 days" ? 7 : 30) * DAY_SECONDS;
    return matchesType && matchesSize && matchesModified;
  });

  const anyFilterActive =
    typeFilter !== "All" || sizeFilter !== "Any" || modifiedFilter !== "Any";

  const resetFilters = () => {
    setTypeFilter("All");
    setSizeFilter("Any");
    setModifiedFilter("Any");
  };

  // Delete honors the "Confirm before deleting" setting: when disabled the
  // item goes straight to Trash; otherwise the in-app confirmation shows.
  function startDelete(item: FileItem | null) {
    if (!item) return;
    if (confirmDelete) {
      setDeleteItem(item);
      return;
    }
    onDelete(item);
    setSelected(new Set());
  }

  // Sorting uses the raw numeric values, never the formatted size/date strings.
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "name") return a.name.localeCompare(b.name);
    if (sortBy === "size") return b.sizeBytes - a.sizeBytes;
    return (b.modifiedTs ?? 0) - (a.modifiedTs ?? 0);
  });

  const selectedItems = useMemo(
    () => items.filter((i) => selected.has(i.id)),
    [items, selected],
  );

  // Keep the app's shortcut layer informed of the current selection so Space
  // can preview the actively selected item.
  useEffect(() => {
    onSelectionChange?.(selectedItems);
  }, [selectedItems, onSelectionChange]);

  // Breadcrumb built from the real filesystem path.
  const crumbs = path
    .split(/[\\/]/)
    .filter(Boolean)
    .map((seg, i, arr) => ({ seg, isLast: i === arr.length - 1 }));

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-8 py-6 space-y-5">

        {/* Breadcrumb + toolbar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 text-sm">
            {crumbs.length === 0 ? (
              <span className="text-muted-foreground">Home</span>
            ) : (
              crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight size={13} className="text-muted-foreground" />}
                  <span
                    className={
                      c.isLast ? "text-foreground font-medium" : "text-muted-foreground"
                    }
                  >
                    {c.seg}
                  </span>
                </span>
              ))
            )}
            {!isHome && (
              <button
                onClick={onUp}
                title="Go up one folder"
                className="ml-3 flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              >
                Up
              </button>
            )}
          </div>
<div className="flex items-center gap-2">

            <button
              onClick={onRefresh}
              title="Refresh folder"
              aria-label="Refresh folder"
              className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-xs font-medium text-muted-foreground hover:bg-secondary transition-colors"
            >
              <RefreshCw size={13} />
              <span>Refresh</span>
            </button>

            <button
              onClick={() => { setNewOpen(true); setNewKind("folder"); setNewName(""); }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-foreground text-primary-foreground rounded-lg text-xs font-medium hover:opacity-90 transition-opacity"
            >
              <Plus size={13} />
              <span>New</span>
            </button>

            <FileUpload
              destDir={path}
              onUploaded={onUploaded}
              renderTrigger={(openPicker) => (
                <button
                  type="button"
                  onClick={openPicker}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-xs font-medium text-muted-foreground hover:bg-secondary transition-colors"
                >
                  <Upload size={13} />
                  <span>Upload</span>
                </button>
              )}
            />

            <button
              onClick={() =>
                setSortBy((s) =>
                  s === "name" ? "modified" : s === "modified" ? "size" : "name",
                )
              }
              className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-xs font-medium text-muted-foreground hover:bg-secondary transition-colors"
            >
              <ArrowUpDown size={13} />
              <span className="capitalize">Sort: {sortBy}</span>
            </button>

            <button
              onClick={() => setFilterOpen((open) => !open)}
              aria-expanded={filterOpen}
              className={
                "flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-xs font-medium transition-colors " +
                (filterOpen
                  ? "bg-secondary text-foreground border-border"
                  : "text-muted-foreground border-border hover:bg-secondary")
              }
            >
              <Filter size={13} />
              <span>Filter</span>
            </button>

            <div className="flex border border-border rounded-lg overflow-hidden">
              {(
                [
                  ["list", List],
                  ["grid", LayoutGrid],
                ] as const
              ).map(([mode, Icon]) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`w-8 h-8 flex items-center justify-center transition-colors
                    ${
                      viewMode === mode
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary"
                    }`}
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
          </div>
          </div>

          {/* Client-side filter panel */}
          {filterOpen && (
            <div className="bg-card border border-border rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Filters
                </span>
                {anyFilterActive && (
                  <button
                    onClick={resetFilters}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Reset filters
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-x-8 gap-y-4">
                <div role="group" aria-label="Type" className="space-y-2">
                  <div className="text-xs text-muted-foreground">Type</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(["All", "PDF", "Documents", "Images", "Videos"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTypeFilter(t)}
                        className={chipClass(typeFilter === t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                <div role="group" aria-label="Size" className="space-y-2">
                  <div className="text-xs text-muted-foreground">Size</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(["Any", "Large"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setSizeFilter(s)}
                        className={chipClass(sizeFilter === s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Large ≥ 100 MB
                  </div>
                </div>

                <div role="group" aria-label="Modified" className="space-y-2">
                  <div className="text-xs text-muted-foreground">Modified</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(["Any", "Past 7 days", "Past 30 days"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setModifiedFilter(m)}
                        className={chipClass(modifiedFilter === m)}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Selection toolbar */}
        {selected.size > 0 && (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-foreground text-primary-foreground rounded-xl text-sm">

            <span className="font-medium">
              {selected.size} selected
            </span>

            <div className="w-px h-4 bg-white/20" />

            <button
              onClick={() => selectedItems.filter((i) => !i.isFolder).forEach((i) => onOpenDisk(i))}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs hover:bg-white/10 transition-colors"
            >
              <ExternalLink size={12} />
              <span>Open</span>
            </button>

            <button
              disabled
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs hover:bg-white/10 transition-colors opacity-60"
            >
              <Share2 size={12} />
              <span>Share</span>
            </button>

            <button
              onClick={() => {
                const item = selectedItems[0];
                if (item) { setRenameItem(item); setRenameValue(item.name); setRenameError(null); }
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs hover:bg-white/10 transition-colors"
            >
              <Edit2 size={12} />
              <span>Rename</span>
            </button>

            <button
              onClick={() => {
                const item = selectedItems[0];
                if (item) { setMoveItem(item); }
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs hover:bg-white/10 transition-colors"
            >
              <Move size={12} />
              <span>Move</span>
            </button>

            <button
              onClick={() => selectedItems.forEach((i) => onDuplicate(i))}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs hover:bg-white/10 transition-colors"
            >
              <Copy size={12} />
              <span>Duplicate</span>
            </button>

            <button
              onClick={() => {
                if (selectedItems.length > 0) setCopyItems(selectedItems);
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs hover:bg-white/10 transition-colors"
            >
              <Copy size={12} />
              <span>Copy to…</span>
            </button>

            <button
              onClick={() => selectedItems.forEach((i) => onToggleStar(i))}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs hover:bg-white/10 transition-colors"
            >
              <Star size={12} />
              <span>Star</span>
            </button>

            <button
              onClick={() => startDelete(selectedItems[0] ?? null)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-red-300 hover:bg-red-500/20 transition-colors ml-auto"
            >
              <Trash2 size={12} />
              <span>Delete</span>
            </button>

            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-white/60 hover:text-white transition-colors"
            >
              ✕
            </button>
          </div>
        )}

        {/* Loading / error / empty states */}
        {loading ? (
          <div className="bg-card border border-border rounded-xl min-h-[400px] flex flex-col items-center justify-center text-center">
            <div className="w-8 h-8 rounded-full border-2 border-border border-t-accent animate-spin mb-4" />
            <h2 className="text-base font-semibold text-foreground">Loading folder…</h2>
            <p className="text-sm text-muted-foreground mt-1">Reading directory contents.</p>
          </div>
        ) : error ? (
          <div className="bg-card border border-border rounded-xl min-h-[400px] flex flex-col items-center justify-center text-center px-6">
            <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center mb-4">
              <AlertIcon />
            </div>
            <h2 className="text-base font-semibold text-foreground">Couldn't load this folder</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">{error}</p>
            <div className="flex gap-2 mt-4">
              <button
                onClick={onUp}
                className="px-3 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-secondary transition-colors"
              >
                Go back
              </button>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="bg-card border border-border rounded-xl min-h-[400px] flex flex-col items-center justify-center text-center">

            <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mb-4">
              <FolderIcon />
            </div>

            <h2 className="text-base font-semibold text-foreground">
              This folder is empty
            </h2>

            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              Create a new folder or file, or navigate to another directory.
            </p>

          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-card border border-border rounded-xl min-h-[400px] flex flex-col items-center justify-center text-center">

            <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mb-4">
              <Filter size={16} className="text-muted-foreground" />
            </div>

            <h2 className="text-base font-semibold text-foreground">
              No matching results
            </h2>

            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              Nothing in this folder matches the current filters. If any filters are active, you can reset them.
            </p>

          </div>
        ) : viewMode === "list" ? (
          <div className="bg-card border border-border rounded-xl overflow-hidden">

            <div className="grid grid-cols-[20px_auto_1fr_100px_120px_100px] gap-4 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground border-b border-border">
              <div />
              <div />
              <div>Name</div>
              <div>Type</div>
              <div>Size</div>
              <div>Modified</div>
            </div>
{sorted.map((item) => (
              <div
                key={item.id}
                className={`grid grid-cols-[20px_auto_1fr_100px_120px_100px] gap-4 items-center px-5 py-3 cursor-pointer transition-colors border-b border-border last:border-none
                  ${
                    selected.has(item.id)
                      ? "bg-indigo-50"
                      : "hover:bg-secondary"
                  }`}
                onClick={() =>
                  item.isFolder ? onOpenFolder(item) : onOpenPreview(item)
                }
              >
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => {}}
                  onClick={(e) => toggleSelect(item.id, e)}
                  className="accent-accent w-3.5 h-3.5 cursor-pointer"
                />

                <FileIcon
                  type={item.isFolder ? "folder" : item.type}
                  size="sm"
                />

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-mono font-medium text-foreground truncate">
                      {item.name}
                    </div>
                    {item.starred && (
                      <Star size={12} className="text-amber-400 fill-amber-400 flex-shrink-0" />
                    )}
                  </div>

                  {item.isFolder && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {item.itemCount} items
                    </div>
                  )}
                </div>

                <div className="text-xs uppercase font-mono text-muted-foreground">
                  {item.isFolder ? "Folder" : item.type}
                </div>

                <div className="text-xs font-mono text-muted-foreground">
                  {item.isFolder ? "—" : item.size}
                </div>

                <div className="text-xs font-mono text-muted-foreground">
                  {item.modified}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-3">

            {sorted.map((item) => (
              <div
                key={item.id}
                className={`bg-card border rounded-xl p-4 cursor-pointer transition-all group
                  ${
                    selected.has(item.id)
                      ? "border-accent ring-2 ring-accent/20"
                      : "border-border hover:border-accent/40 hover:shadow-sm"
                  }`}
                onClick={() =>
                  item.isFolder ? onOpenFolder(item) : onOpenPreview(item)
                }
              >
                <div className="flex items-start justify-between mb-3">

                  <FileIcon
                    type={item.isFolder ? "folder" : item.type}
                    size="md"
                  />

                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => {}}
                    onClick={(e) => toggleSelect(item.id, e)}
                    className="accent-accent w-3.5 h-3.5 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                </div>

                <div className="flex items-center gap-1.5 text-sm font-mono font-medium text-foreground truncate">
                  <span className="truncate">{item.name}</span>
                  {item.starred && (
                    <Star size={12} className="text-amber-400 fill-amber-400 flex-shrink-0" />
                  )}
                </div>

                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                  <span>
                    {item.isFolder ? `${item.itemCount} items` : item.size}
                  </span>

                  <span>·</span>

                  <span>{item.modified}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* More options */}
        <div className="flex justify-end">
          <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
            <MoreHorizontal size={14} />
            <span>More options</span>
          </button>
        </div>

      </div>

      {/* New folder / file modal */}
      {newOpen && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-8">
          <div className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <div className="text-base font-semibold text-foreground">New {newKind}</div>
            <div className="mt-4 grid grid-cols-2 gap-2 p-1 bg-secondary rounded-lg">
              {(["folder", "file"] as const).map((kind) => (
                <button
                  key={kind}
                  onClick={() => setNewKind(kind)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                    newKind === kind
                      ? "bg-card text-foreground shadow-sm border border-border"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {kind}
                </button>
              ))}
            </div>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) {
                  if (newKind === "folder") { onNewFolder(newName.trim()); setNewOpen(false); }
                  else { onNewFile(newName.trim()); setNewOpen(false); }
                }
              }}
              placeholder={newKind === "folder" ? "Folder name" : "File name"}
              className="mt-4 w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:border-accent bg-card text-foreground placeholder:text-muted-foreground"
            />
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setNewOpen(false)}
                className="flex-1 px-4 py-2 text-sm border border-border rounded-lg hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (newName.trim()) {
                    if (newKind === "folder") { onNewFolder(newName.trim()); setNewOpen(false); }
                    else { onNewFile(newName.trim()); setNewOpen(false); }
                  }
                }}
                className="flex-1 px-4 py-2 text-sm bg-foreground text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename modal */}
      {renameItem && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-8">
          <div className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <div className="text-base font-semibold text-foreground">Rename</div>
            {renameError && (
              <p className="text-xs text-red-500 mt-2">{renameError}</p>
            )}
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitRename();
              }}
              className="mt-4 w-full px-4 py-2 text-sm border border-border rounded-lg outline-none focus:border-accent bg-transparent text-foreground"
            />
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setRenameItem(null)}
                className="flex-1 px-4 py-2 text-sm border border-border rounded-lg hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void submitRename()}
                disabled={renaming}
                className="flex-1 px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-indigo-600 transition-colors"
              >
                {renaming ? "Renaming…" : "Rename"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move dialog — real folder picker */}
      {moveItem && (
        <MoveFolderDialog
          itemName={moveItem.name}
          initialPath={moveItem.location}
          onConfirm={(dest) => {
            onMove(moveItem, dest);
            setMoveItem(null);
          }}
          onClose={() => setMoveItem(null)}
        />
      )}

      {/* Copy dialog — reuses the picker with a clearly-labelled Copy action */}
      {copyItems.length > 0 && (
        <MoveFolderDialog
          itemName={copyItems.length === 1 ? copyItems[0].name : `${copyItems.length} items`}
          initialPath={copyItems[0].location}
          titleVerb="Copy"
          actionLabel="Copy here"
          onConfirm={(dest) => {
            copyItems.forEach((item) => onCopy(item, dest));
            setCopyItems([]);
          }}
          onClose={() => setCopyItems([])}
        />
      )}

      {/* Delete confirmation */}
      {deleteItem && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-8">
          <div className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center mb-4">
              <Trash2 size={18} className="text-red-500" />
            </div>
            <h2 className="text-base font-semibold text-foreground">Move {deleteItem.name} to Trash?</h2>
            <p className="text-sm text-muted-foreground mt-2">
              The item will be moved to the app-managed trash. You can restore it from the Trash view.
            </p>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setDeleteItem(null)}
                className="flex-1 px-4 py-2 text-sm border border-border rounded-lg hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { onDelete(deleteItem); setDeleteItem(null); setSelected(new Set()); }}
                className="flex-1 px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
              >
                Move to Trash
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-muted-foreground"
    >
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" />
      <path d="M3 10h18" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-red-500"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}