import { Clock, RotateCcw } from "../../components/Icons";
import FileIcon from "../FileIcon";
import type { FileItem } from "../../types";

interface RecentProps {
  onOpenFile: (file: FileItem) => void;
  /** Real, most recently modified files and folders from the allowed roots. */
  items?: FileItem[];
  /** True while the recent-files scan is in flight. */
  loading?: boolean;
  /** Honest scan error, or null. */
  error?: string | null;
  /** Re-run the recent-files scan (e.g. after a transient error). */
  onRetry?: () => void;
}

/**
 * Recent files. Real, bounded listing of the most recently modified files and
 * folders across all allowed roots — never the loaded directory contents.
 */
export default function Recent({
  onOpenFile,
  items = [],
  loading = false,
  error = null,
  onRetry,
}: RecentProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-8">
        <div>
          <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Recent</h1>
          <p className="text-sm text-muted-foreground mt-1">The most recently modified files in your allowed folders.</p>
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
            <h2 className="text-base font-semibold text-foreground">Loading recent files…</h2>
            <p className="text-sm text-muted-foreground mt-1">Scanning your allowed folders for the most recently modified items.</p>
          </div>
        ) : items.length === 0 && !error ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mb-4">
              <Clock size={22} className="text-muted-foreground" />
            </div>
            <div className="text-sm font-medium text-foreground">No recent files yet</div>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Files you modify or create in your allowed folders will appear here.
            </p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl divide-y divide-border overflow-hidden">
            {items.map((file) => (
              <button
                key={file.id}
                onClick={() => onOpenFile(file)}
                className="w-full flex items-center gap-4 px-5 py-3 hover:bg-secondary transition-colors text-left"
              >
                <FileIcon type={file.type} size="sm" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-mono font-medium text-foreground truncate">{file.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{file.location}</div>
                </div>
                <div className="flex items-center gap-4 flex-shrink-0">
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-zinc-100 text-zinc-500">
                    {file.isFolder ? "Folder" : file.type.toUpperCase()}
                  </span>
                  <span className="text-xs font-mono text-muted-foreground">{file.isFolder ? "—" : file.size}</span>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock size={11} />
                    <span>{file.modified}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}