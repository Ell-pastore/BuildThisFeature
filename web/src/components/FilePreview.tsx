import { useEffect, useState } from "react";
import { X, Copy, Edit2, Move, Star, Trash2, ExternalLink } from "./Icons";
import { getFilesystemProvider } from "../services/filesystem";
import type { FileItem } from "../types";
import FileIcon from "./FileIcon";
import MoveFolderDialog from "./MoveFolderDialog";

interface FilePreviewProps {
  file: FileItem;
  onClose: () => void;
  onOpen?: () => void;
  onStar?: () => void;
  onDelete?: () => void;
  onRename?: (newName: string) => Promise<string | null> | string | null | void;
  onMove?: (destDir: string) => void;
  onDuplicate?: () => void;
  onCopy?: (destDir: string) => void;
  /** Persisted "Confirm before deleting" setting; defaults to asking. */
  confirmDelete?: boolean;
}

/** MIME type for a previewable extension, or undefined when unsupported. */
function previewMime(type: string): { kind: "image" | "video"; mime: string } | null {
  switch (type.toLowerCase()) {
    case "png": return { kind: "image", mime: "image/png" };
    case "jpg":
    case "jpeg": return { kind: "image", mime: "image/jpeg" };
    case "gif": return { kind: "image", mime: "image/gif" };
    case "webp": return { kind: "image", mime: "image/webp" };
    case "svg": return { kind: "image", mime: "image/svg+xml" };
    case "bmp": return { kind: "image", mime: "image/bmp" };
    case "mp4": return { kind: "video", mime: "video/mp4" };
    case "webm": return { kind: "video", mime: "video/webm" };
    case "ogv": return { kind: "video", mime: "video/ogg" };
    case "mov": return { kind: "video", mime: "video/quicktime" };
    default: return null;
  }
}

/**
 * Read the file's real bytes through the FilesystemProvider and expose an
 * object URL. The URL is revoked when the file changes or the preview unmounts.
 */
function usePreviewUrl(file: FileItem) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const kind = previewMime(file.type);
    if (kind === null) {
      setUrl(null);
      setLoading(false);
      setError(null);
      return;
    }
    if (!file.path) {
      setUrl(null);
      setLoading(false);
      setError("No file location on disk to read.");
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;
    setLoading(true);
    setError(null);
    setUrl(null);

    getFilesystemProvider()
      .readFile(file.path)
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([bytes as unknown as BlobPart], { type: kind.mime });
        createdUrl = URL.createObjectURL(blob);
        setUrl(createdUrl);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (createdUrl !== null) URL.revokeObjectURL(createdUrl);
    };
  }, [file]);

  return { url, loading, error, kind: previewMime(file.type) };
}

function PreviewArea({ file }: { file: FileItem }) {
  const { url, loading, error, kind } = usePreviewUrl(file);

  if (kind === null) {
    return (
      <div className="flex-1 bg-secondary rounded-xl flex items-center justify-center">
        <div className="text-center">
          <FileIcon type={file.type} size="lg" />
          <p className="text-sm text-muted-foreground mt-3">{file.name}</p>
          <p className="text-xs text-muted-foreground mt-1">Preview unavailable</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 bg-card flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 rounded-full border-2 border-border border-t-accent animate-spin mx-auto mb-4" />
          <p className="text-sm text-muted-foreground">Loading preview…</p>
        </div>
      </div>
    );
  }

  if (error !== null || url === null) {
    return (
      <div className="flex-1 bg-secondary rounded-xl flex items-center justify-center">
        <div className="text-center">
          <FileIcon type={file.type} size="lg" />
          <p className="text-sm text-muted-foreground mt-3">This file couldn't be previewed</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs">{error ?? "Unknown error."}</p>
        </div>
      </div>
    );
  }

  if (kind.kind === "image") {
    return (
      <div className="flex-1 bg-zinc-900 flex items-center justify-center rounded-xl overflow-hidden">
        <img
          src={url}
          alt={file.name}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  return (
    <div className="flex-1 bg-zinc-950 flex items-center justify-center rounded-xl overflow-hidden">
      <video src={url} controls data-testid="preview-video" className="max-h-full max-w-full" />
    </div>
  );
}
export default function FilePreview({
  file,
  onClose,
  onOpen,
  onStar,
  onDelete,
  onRename,
  onMove,
  onDuplicate,
  onCopy,
  confirmDelete = true,
}: FilePreviewProps) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  async function submitRename() {
    const name = renameValue.trim();
    if (!name || !onRename || renaming) return;
    setRenaming(true);
    setRenameError(null);
    const result = await onRename(name);
    setRenaming(false);
    if (result) {
      setRenameError(result);
      return;
    }
    setRenameOpen(false);
  }

  return (
    <>
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
                  setRenameValue(file.name);
                  setRenameError(null);
                  setRenameOpen(true);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-secondary transition-colors"
              >
                <Edit2 size={14} className="text-muted-foreground" />
                <span>Rename</span>
              </button>
              <button
                onClick={() => {
                  if (onMove) setMoveOpen(true);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-secondary transition-colors"
              >
                <Move size={14} className="text-muted-foreground" />
                <span>Move</span>
              </button>
              <button
                onClick={() => {
                  if (onCopy) setCopyOpen(true);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-secondary transition-colors"
              >
                <Copy size={14} className="text-muted-foreground" />
                <span>Copy to…</span>
              </button>
              <button
                onClick={() => onDuplicate && onDuplicate()}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-secondary transition-colors"
              >
                <Copy size={14} className="text-muted-foreground" />
                <span>Duplicate</span>
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
                  if (!onDelete) return;
                  if (confirmDelete === false) {
                    onDelete();
                    return;
                  }
                  if (window.confirm(`Move "${file.name}" to Trash? You can restore it from the Trash view.`)) onDelete();
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

      {moveOpen && (
        <MoveFolderDialog
          itemName={file.name}
          initialPath={file.location}
          onConfirm={(dest) => {
            if (onMove) onMove(dest);
            setMoveOpen(false);
          }}
          onClose={() => setMoveOpen(false)}
        />
      )}

      {copyOpen && (
        <MoveFolderDialog
          itemName={file.name}
          initialPath={file.location}
          titleVerb="Copy"
          actionLabel="Copy here"
          onConfirm={(dest) => {
            if (onCopy) onCopy(dest);
            setCopyOpen(false);
          }}
          onClose={() => setCopyOpen(false)}
        />
      )}
      {renameOpen && (
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
                onClick={() => setRenameOpen(false)}
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
      </div>
    </>
  );
}