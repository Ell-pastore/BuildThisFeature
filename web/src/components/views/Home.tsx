import { useState } from "react";
import { LayoutGrid, List, Clock, HardDrive, Sparkles, Copy, Folder, Upload, FolderPlus, Star } from "../../components/Icons";
import FileIcon from "../FileIcon";
import type { FileItem } from "../../types";
import type { DiskUsage } from "../../services/filesystem";
import { formatBytes } from "../../services/format";

interface HomeProps {
  /** Real files provided by the app (the loaded directory contents). */
  recentFiles?: FileItem[];
  onOpenFile: (file: FileItem) => void;
  onNavigate: (view: string) => void;
  /** Real volume capacity from the Rust backend (null while loading/unsupported). */
  diskUsage?: DiskUsage | null;
}

/**
 * Home dashboard. Presentational only: `recentFiles` and `diskUsage` come from
 * the real filesystem via App/Rust. No hardcoded file entries live here.
 */
export default function Home({ recentFiles = [], onOpenFile, onNavigate, diskUsage }: HomeProps) {
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const recent = recentFiles.slice(0, 5);
  const totalBytes = diskUsage?.totalBytes ?? 0;
  const usedBytes =
    diskUsage && diskUsage.totalBytes >= diskUsage.freeBytes
      ? diskUsage.totalBytes - diskUsage.freeBytes
      : 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-8 space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>
            Good morning
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Here's what's happening with your files.</p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-4">
          {[
            {
              icon: Clock, label: "Recent Files", value: String(recentFiles.length), sub: "in the current folder",
              color: "text-blue-500", bg: "bg-blue-50",
            },
            {
              icon: HardDrive, label: "Storage Used",
              value: diskUsage ? formatBytes(usedBytes) : "—",
              sub: diskUsage ? `of ${formatBytes(totalBytes)} on this volume` : "not measured yet",
              color: "text-emerald-500", bg: "bg-emerald-50",
            },
            {
              icon: Sparkles, label: "AI Suggestions", value: "—", sub: "AI not enabled",
              color: "text-ai-text", bg: "bg-ai-bg",
            },
            {
              icon: Folder, label: "Folders", value: String(recentFiles.filter((f) => f.isFolder).length), sub: "in the current folder",
              color: "text-purple-500", bg: "bg-purple-50",
            },
          ].map(({ icon: Icon, label, value, sub, color, bg }) => (
            <div key={label} className="bg-card border border-border rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
                <div className={`w-7 h-7 rounded-lg ${bg} flex items-center justify-center`}>
                  <Icon size={14} className={color} />
                </div>
              </div>
              <div>
                <div className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>{value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
              </div>
            </div>
          ))}
        </div>

        {/* AI Recommendations (AI not wired yet — placeholder) */}
        <div className="bg-ai-bg border border-indigo-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={14} className="text-ai-text" />
            <span className="text-sm font-semibold text-ai-text" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Smart suggestions</span>
          </div>
          <p className="text-sm text-ai-text leading-relaxed">
            AI-powered organization and suggestions aren't available yet. You can browse, open and search your
            files, and star, rename, move, and delete them from the Files view.
          </p>
        </div>

        {/* Quick Actions */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Quick Actions</h2>
          <div className="grid grid-cols-4 gap-3">
            {[
              { icon: Upload, label: "Upload Files", color: "text-blue-500", bg: "bg-blue-50 hover:bg-blue-100" },
              { icon: FolderPlus, label: "New Folder", color: "text-emerald-500", bg: "bg-emerald-50 hover:bg-emerald-100" },
              { icon: Sparkles, label: "Organize with AI", color: "text-ai-text", bg: "bg-ai-bg hover:bg-indigo-100", view: "ai-organization" },
              { icon: Copy, label: "Find Duplicates", color: "text-purple-500", bg: "bg-purple-50 hover:bg-purple-100", view: "duplicates" },
            ].map(({ icon: Icon, label, color, bg, view }) => (
              <button
                key={label}
                onClick={() => view && onNavigate(view)}
                className={`flex flex-col items-center gap-2 py-4 rounded-xl border border-border ${bg} transition-colors`}
              >
                <Icon size={18} className={color} />
                <span className="text-xs font-medium text-foreground">{label}</span>
              </button>
            ))}
          </div>
        </div>
        {/* Recent files */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Recent Files</h2>
            <div className="flex gap-1">
              {([["list", List], ["grid", LayoutGrid]] as const).map(([mode, Icon]) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors
                    ${viewMode === mode ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary"}`}
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
          </div>

          {recent.length === 0 ? (
            <div className="bg-card border border-border rounded-xl px-5 py-10 text-center">
              <p className="text-sm font-medium text-foreground">Nothing to show yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Items from your real filesystem will appear here.
              </p>
            </div>
          ) : viewMode === "list" ? (
            <div className="bg-card border border-border rounded-xl divide-y divide-border overflow-hidden">
              <div className="grid grid-cols-[auto_1fr_80px_100px_90px] gap-4 px-4 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                <div />
                <div>Name</div>
                <div>Size</div>
                <div>Location</div>
                <div>Modified</div>
              </div>
              {recent.map((file) => (
                <button
                  key={file.id}
                  onClick={() => onOpenFile(file)}
                  className="grid grid-cols-[auto_1fr_80px_100px_90px] gap-4 items-center px-4 py-3 w-full hover:bg-secondary transition-colors text-left"
                >
                  <FileIcon type={file.type} size="sm" />
                  <div className="min-w-0">
                    <div className="text-sm font-mono font-medium text-foreground truncate">{file.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 uppercase">{file.isFolder ? "Folder" : file.type}</div>
                  </div>
                  <div className="text-xs font-mono text-muted-foreground">{file.isFolder ? "—" : file.size}</div>
                  <div className="text-xs text-muted-foreground truncate">{file.location}</div>
                  <div className="text-xs font-mono text-muted-foreground">{file.modified}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {recent.map((file) => (
                <button
                  key={file.id}
                  onClick={() => onOpenFile(file)}
                  className="bg-card border border-border rounded-xl p-4 hover:border-accent/40 hover:shadow-sm transition-all text-left group"
                >
                  <div className="flex items-start gap-3">
                    <FileIcon type={file.type} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-mono font-medium text-foreground truncate">{file.name}</div>
                      <div className="text-xs text-muted-foreground mt-1">{file.isFolder ? "Folder" : file.size} · {file.modified}</div>
                    </div>
                    {file.starred && <Star size={13} className="text-amber-400 fill-amber-400 flex-shrink-0 mt-0.5" />}
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground truncate">{file.location}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}