import { X, Edit2, Move, Star, Trash2, ExternalLink } from "./Icons";
import type { FileItem } from "../types";
import FileIcon from "./FileIcon";

interface FilePreviewProps {
  file: FileItem;
  onClose: () => void;
  onOpen?: () => void;
  onStar?: () => void;
  onDelete?: () => void;
  onRename?: (newName: string) => void;
  onMove?: (destDir: string) => void;
}

function PreviewArea({ file }: { file: FileItem }) {
  if (file.type === "png" || file.type === "jpg") {
    return (
      <div className="flex-1 bg-zinc-900 flex items-center justify-center rounded-xl overflow-hidden">
        <div className="text-center">
          <div className="w-48 h-36 bg-zinc-700 rounded-lg mx-auto mb-3 flex items-center justify-center">
            <FileIcon type={file.type} size="lg" />
          </div>
          <p className="text-zinc-400 text-sm">Image preview</p>
        </div>
      </div>
    );
  }

  if (file.type === "mp4") {
    return (
      <div className="flex-1 bg-zinc-950 flex items-center justify-center rounded-xl">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center mx-auto mb-3">
            <div className="w-0 h-0 border-t-8 border-b-8 border-l-14 border-t-transparent border-b-transparent border-l-white ml-1" style={{ borderLeftWidth: 20 }} />
          </div>
          <p className="text-zinc-400 text-sm">{file.name}</p>
          <p className="text-zinc-600 text-xs mt-1">Video player preview</p>
        </div>
      </div>
    );
  }

  if (file.type === "pdf" || file.type === "docx") {
    return (
      <div className="flex-1 bg-zinc-50 border border-border rounded-xl overflow-hidden flex flex-col">
        <div className="flex-1 px-12 py-10 space-y-4">
          <div className="h-5 bg-zinc-200 rounded w-3/4" />
          <div className="h-3 bg-zinc-100 rounded w-full" />
          <div className="h-3 bg-zinc-100 rounded w-5/6" />
          <div className="h-3 bg-zinc-100 rounded w-full" />
          <div className="h-3 bg-zinc-100 rounded w-4/5" />
          <div className="mt-6 h-4 bg-zinc-200 rounded w-1/2" />
          <div className="h-3 bg-zinc-100 rounded w-full" />
          <div className="h-3 bg-zinc-100 rounded w-11/12" />
          <div className="h-3 bg-zinc-100 rounded w-full" />
          <div className="h-3 bg-zinc-100 rounded w-3/4" />
          <div className="h-3 bg-zinc-100 rounded w-full" />
          <div className="h-3 bg-zinc-100 rounded w-5/6" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-secondary rounded-xl flex items-center justify-center">
      <div className="text-center">
        <FileIcon type={file.type} size="lg" />
        <p className="text-sm text-muted-foreground mt-3">{file.name}</p>
        <p className="text-xs text-muted-foreground mt-1">Preview not available</p>
      </div>
    </div>
  );
}

export default function FilePreview({ file, onClose, onOpen, onStar, onDelete, onRename, onMove }: FilePreviewProps) {
  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-8">
      <div className="bg-card rounded-2xl border border-border shadow-2xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <FileIcon type={file.type} size="sm" />
            <div>
              <div className="text-sm font-semibold font-mono">{file.name}</div>
              <div className="text-xs text-muted-foreground">{file.location}</div>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Preview */}
          <div className="flex-1 p-6 flex flex-col">
            <PreviewArea file={file} />
          </div>

          {/* Info panel */}
          <div className="w-64 border-l border-border px-5 py-6 flex flex-col gap-6 overflow-y-auto flex-shrink-0">
            {/* Actions */}
            <div className="space-y-2">
              <button
                onClick={() => onOpen && onOpen()}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-secondary transition-colors"
              >
                <ExternalLink size={14} className="text-muted-foreground" />
                <span>Open</span>
              </button>
              <button
                onClick={() => {
                  if (!onRename) return;
                  const name = window.prompt("New name", file.name);
                  if (name && name.trim()) onRename(name.trim());
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-secondary transition-colors"
              >
                <Edit2 size={14} className="text-muted-foreground" />
                <span>Rename</span>
              </button>
              <button
                onClick={() => {
                  if (!onMove) return;
                  const dest = window.prompt("Destination folder", "");
                  if (dest && dest.trim()) onMove(dest.trim());
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-secondary transition-colors"
              >
                <Move size={14} className="text-muted-foreground" />
                <span>Move</span>
              </button>
              <button
                onClick={() => onStar && onStar()}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-secondary transition-colors"
              >
                <Star size={14} className="text-muted-foreground" />
                <span>{file.starred ? "Unstar" : "Star"}</span>
              </button>
              <button
                onClick={() => {
                  if (onDelete && window.confirm(`Delete "${file.name}"? This cannot be undone.`)) onDelete();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-red-600 hover:bg-red-50 transition-colors"
              >
                <Trash2 size={14} />
                <span>Delete</span>
              </button>
            </div>

            <div className="border-t border-border pt-4 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Details</h3>
              {[
                { label: "Name", value: file.name },
                { label: "Type", value: file.type.toUpperCase() },
                { label: "Size", value: file.size },
                { label: "Location", value: file.location },
                { label: "Created", value: file.created },
                { label: "Modified", value: file.modified },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
                  <div className="text-xs font-mono mt-0.5 text-foreground break-all">{value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
