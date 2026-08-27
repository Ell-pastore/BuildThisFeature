import { useState } from "react";
import {
  LayoutGrid, List, Plus, Upload, ArrowUpDown, Filter, MoreHorizontal,
  ExternalLink, Share2, Edit2, Move, Star, Trash2, ChevronRight
} from "../../components/Icons";
import { sampleFiles, sampleFolders } from "../../data/files";
import FileIcon from "../FileIcon";
import type { FileItem } from "../../data/files";

interface FilesProps {
  onOpenFile: (file: FileItem) => void;
}

export default function Files({ onOpenFile }: FilesProps) {
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"name" | "modified" | "size">("modified");
  const allItems = [...sampleFolders, ...sampleFiles];

  function toggleSelect(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const sorted = [...allItems].sort((a, b) => {
    if (sortBy === "name") return a.name.localeCompare(b.name);
    if (sortBy === "size") return b.sizeBytes - a.sizeBytes;
    return b.modified.localeCompare(a.modified);
  });

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-8 py-6 space-y-5">
        {/* Breadcrumb + toolbar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 text-sm">
            {["Home", "Documents"].map((crumb, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={13} className="text-muted-foreground" />}
                <button className="text-muted-foreground hover:text-foreground transition-colors">{crumb}</button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-1.5 px-3 py-1.5 bg-foreground text-primary-foreground rounded-lg text-xs font-medium hover:opacity-90 transition-opacity">
              <Plus size={13} />
              <span>New</span>
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-xs font-medium text-muted-foreground hover:bg-secondary transition-colors">
              <Upload size={13} />
              <span>Upload</span>
            </button>
            <button
              onClick={() => setSortBy((s) => s === "name" ? "modified" : s === "modified" ? "size" : "name")}
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
              {([["list", List], ["grid", LayoutGrid]] as const).map(([mode, Icon]) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`w-8 h-8 flex items-center justify-center transition-colors
                    ${viewMode === mode ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary"}`}
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
            <span className="font-medium">{selected.size} selected</span>
            <div className="w-px h-4 bg-white/20" />
            {[
              { icon: ExternalLink, label: "Open" },
              { icon: Share2, label: "Share" },
              { icon: Edit2, label: "Rename" },
              { icon: Move, label: "Move" },
              { icon: Star, label: "Star" },
            ].map(({ icon: Icon, label }) => (
              <button key={label} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs hover:bg-white/10 transition-colors">
                <Icon size={12} />
                <span>{label}</span>
              </button>
            ))}
            <button className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-red-300 hover:bg-red-500/20 transition-colors ml-auto">
              <Trash2 size={12} />
              <span>Delete</span>
            </button>
            <button onClick={() => setSelected(new Set())} className="text-xs text-white/60 hover:text-white transition-colors">
              ✕
            </button>
          </div>
        )}

        {viewMode === "list" ? (
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
                  ${selected.has(item.id) ? "bg-indigo-50" : "hover:bg-secondary"}`}
                onClick={() => !item.isFolder && onOpenFile(item as FileItem)}
              >
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => {}}
                  onClick={(e) => toggleSelect(item.id, e)}
                  className="accent-accent w-3.5 h-3.5 cursor-pointer"
                />
                <FileIcon type={item.isFolder ? "folder" : item.type} size="sm" />
                <div className="min-w-0">
                  <div className="text-sm font-mono font-medium text-foreground truncate">{item.name}</div>
                  {item.isFolder && <div className="text-xs text-muted-foreground mt-0.5">{item.itemCount} items</div>}
                </div>
                <div className="text-xs uppercase font-mono text-muted-foreground">{item.isFolder ? "Folder" : item.type}</div>
                <div className="text-xs font-mono text-muted-foreground">{item.size}</div>
                <div className="text-xs font-mono text-muted-foreground">{item.modified}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-3">
            {sorted.map((item) => (
              <div
                key={item.id}
                className={`bg-card border rounded-xl p-4 cursor-pointer transition-all group
                  ${selected.has(item.id) ? "border-accent ring-2 ring-accent/20" : "border-border hover:border-accent/40 hover:shadow-sm"}`}
                onClick={() => !item.isFolder && onOpenFile(item as FileItem)}
              >
                <div className="flex items-start justify-between mb-3">
                  <FileIcon type={item.isFolder ? "folder" : item.type} size="md" />
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => {}}
                    onClick={(e) => toggleSelect(item.id, e)}
                    className="accent-accent w-3.5 h-3.5 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                </div>
                <div className="text-sm font-mono font-medium text-foreground truncate">{item.name}</div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                  <span>{item.isFolder ? `${item.itemCount} items` : item.size}</span>
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
    </div>
  );
}
