import { RotateCcw, Star } from "../../components/Icons";
import FileIcon from "../FileIcon";
import type { FileItem } from "../../types";

interface StarredProps {
  onOpenFile: (file: FileItem) => void;
  /** Navigate into a folder (falls back to onOpenFile when unset). */
  onOpenFolder?: (item: FileItem) => void;
  /** Real starred files resolved from the persisted star store. */
  items?: FileItem[];
  /** Persisted starred paths that could not be resolved (moved/deleted/outside allowed folders). */
  missingPaths?: string[];
  /** Whether the persisted stars are still being resolved. */
  loading?: boolean;
  /** Honest resolution error, or null. */
  error?: string | null;
  /** Re-run the resolution (e.g. after a transient error). */
  onRetry?: () => void;
}

export default function Starred({
  onOpenFile,
  onOpenFolder,
  items = [],
  missingPaths = [],
  loading = false,
  error = null,
  onRetry,
}: StarredProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Starred</h1>
          <p className="text-sm text-muted-foreground mt-1">Files and folders you've marked as important.</p>
        </div>

        {error && (
          <div className="bg-card border border-border rounded-xl px-5 py-3 flex items-center justify-between gap-4">
            <p className="text-sm text-foreground">{error}</p>
            {onRetry && (
              <button
                onClick={onRetry}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-secondary transition-colors"
              >
                <RotateCcw size={12} />
                Retry
              </button>
            )}
          </div>
        )}

        {loading && !error ? (
          <div className="bg-card border border-border rounded-xl min-h-[300px] flex flex-col items-center justify-center text-center">
            <div className="w-8 h-8 rounded-full border-2 border-border border-t-accent animate-spin mb-4" />
            <h2 className="text-base font-semibold text-foreground">Loading starred files…</h2>
            <p className="text-sm text-muted-foreground mt-1">Resolving your starred paths against the filesystem.</p>
          </div>
        ) : items.length === 0 && missingPaths.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 rounded-2xl bg-amber-50 flex items-center justify-center mb-4">
              <Star size={22} className="text-amber-400" />
            </div>
            <div className="text-sm font-medium text-foreground">No starred files yet</div>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Star files and folders to quickly find them here.
            </p>
          </div>
        ) : (
          <>
            <div className="bg-card border border-border rounded-xl divide-y divide-border overflow-hidden">
              {items.map((file) => (
                <button
                  key={file.id}
                  onClick={() => (file.isFolder ? onOpenFolder?.(file) : onOpenFile(file))}
                  className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-secondary transition-colors text-left"
                >
                  <FileIcon type={file.type} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-mono font-medium text-foreground truncate">{file.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{file.location}</div>
                  </div>
                  <div className="flex items-center gap-4 flex-shrink-0">
                    <span className="text-xs font-mono text-muted-foreground">{file.size}</span>
                    <span className="text-xs font-mono text-muted-foreground">{file.modified}</span>
                    <Star size={14} className="text-amber-400 fill-amber-400" />
                  </div>
                </button>
              ))}
            </div>

            {missingPaths.length > 0 && (
              <div className="bg-card border border-border rounded-xl px-5 py-3">
                <p className="text-xs text-muted-foreground">
                  {missingPaths.length === 1
                    ? "1 starred item can't be found — it may have been moved or deleted. It will disappear from this list once you unstar it."
                    : `${missingPaths.length} starred items can't be found — they may have been moved or deleted. They will disappear from this list once you unstar them.`}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}