import { useState } from "react";
import {
  LayoutGrid,
  List,
  Plus,
  Upload,
  ArrowUpDown,
  Filter,
  MoreHorizontal,
  ExternalLink,
  Share2,
  Edit2,
  Move,
  Star,
  Trash2,
  ChevronRight,
  ChevronLeft,
} from "../../components/Icons";
import FileIcon from "../FileIcon";
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
  onRename: (item: FileItem, newName: string) => void;
  onDelete: (item: FileItem) => void;
  onMove: (item: FileItem, destDir: string) => void;
  onToggleStar: (item: FileItem) => void;
}

type SortKey = "name" | "modified" | "size";

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
  onRename,
  onDelete,
  onMove,
  onToggleStar,
}: FilesProps) {
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<SortKey>("modified");

  // Local modal/flow state.
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [renameItem, setRenameItem] = useState<FileItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [moveItem, setMoveItem] = useState<FileItem | null>(null);
  const [moveDest, setMoveDest] = useState("");
  const [deleteItem, setDeleteItem] = useState<FileItem | null>(null);

  function toggleSelect(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Sorting uses the raw numeric values, never the formatted size/date strings.
  const sorted = [...items].sort((a, b) => {
    if (sortBy === "name") return a.name.localeCompare(b.name);
    if (sortBy === "size") return b.sizeBytes - a.sizeBytes;
    return (b.modifiedTs ?? 0) - (a.modifiedTs ?? 0);
  });

  const selectedItems = items.filter((i) => selected.has(i.id));

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
              onClick={() => { setNewOpen(true); setNewName(""); }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-foreground text-primary-foreground rounded-lg text-xs font-medium hover:opacity-90 transition-opacity"
            >
              <Plus size={13} />
              <span>New</span>
            </button>

            <button className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-xs font-medium text-muted-foreground hover:bg-secondary transition-colors">
              <Upload size={13} />
              <span>Upload</span>
            </button>

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

            <button className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-xs font-medium text-muted-foreground hover:bg-secondary transition-colors">
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
                if (item) { setRenameItem(item); setRenameValue(item.name); }
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs hover:bg-white/10 transition-colors"
            >
              <Edit2 size={12} />
              <span>Rename</span>
            </button>

            <button
              onClick={() => {
                const item = selectedItems[0];
                if (item) { setMoveItem(item); setMoveDest(""); }
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs hover:bg-white/10 transition-colors"
            >
              <Move size={12} />
              <span>Move</span>
            </button>

            <button
              onClick={() => selectedItems.forEach((i) => onToggleStar(i))}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs hover:bg-white/10 transition-colors"
            >
              <Star size={12} />
              <span>Star</span>
            </button>

            <button
              onClick={() => setDeleteItem(selectedItems[0] ?? null)}
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
        ) : sorted.length === 0 ? (
          <div className="bg-card border border-border rounded-xl min-h-[400px] flex flex-col items-center justify-center text-center">

            <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mb-4">
              <FolderIcon />
            </div>

            <h2 className="text-base font-semibold text-foreground">
              This folder is empty
            </h2>

            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              Create a new folder or navigate to another directory.
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

      {/* New folder modal */}
      {newOpen && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-8">
          <div className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <div className="text-base font-semibold text-foreground">New folder</div>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) { onNewFolder(newName.trim()); setNewOpen(false); }
              }}
              placeholder="Folder name"
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
                onClick={() => { if (newName.trim()) { onNewFolder(newName.trim()); setNewOpen(false); } }}
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
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && renameValue.trim()) { onRename(renameItem, renameValue.trim()); setRenameItem(null); }
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
                onClick={() => { if (renameValue.trim()) { onRename(renameItem, renameValue.trim()); setRenameItem(null); } }}
                className="flex-1 px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-indigo-600 transition-colors"
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move modal */}
      {moveItem && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-8">
          <div className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <div className="text-base font-semibold text-foreground">Move to folder</div>
            <p className="text-xs text-muted-foreground mt-1">Enter the destination directory path.</p>
            <input
              autoFocus
              value={moveDest}
              onChange={(e) => setMoveDest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && moveDest.trim()) { onMove(moveItem, moveDest.trim()); setMoveItem(null); }
              }}
              placeholder="/Users/you/Documents"
              className="mt-4 w-full px-4 py-2 text-sm border border-border rounded-lg outline-none focus:border-accent bg-transparent text-foreground placeholder:text-muted-foreground"
            />
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setMoveItem(null)}
                className="flex-1 px-4 py-2 text-sm border border-border rounded-lg hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { if (moveDest.trim()) { onMove(moveItem, moveDest.trim()); setMoveItem(null); } }}
                className="flex-1 px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-indigo-600 transition-colors"
              >
                Move
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteItem && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-8">
          <div className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center mb-4">
              <Trash2 size={18} className="text-red-500" />
            </div>
            <h2 className="text-base font-semibold text-foreground">Delete {deleteItem.name}?</h2>
            <p className="text-sm text-muted-foreground mt-2">
              This action cannot be undone. The file will be permanently removed from your storage.
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
                Delete
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