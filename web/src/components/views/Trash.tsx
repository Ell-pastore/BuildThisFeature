import { useEffect, useState } from "react";
import { Trash2, RotateCcw } from "../../components/Icons";
import FileIcon from "../FileIcon";
import { getFilesystemProvider } from "../../services/filesystem";
import type { TrashItem } from "../../types";

/**
 * Trash. Shows the REAL contents of the application-managed trash through the
 * FilesystemProvider.listTrash() bridge (→ Rust `list_trash`). Restore uses
 * the existing restoreItem() flow, then refreshes the view from the provider.
 */
export default function Trash() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setItems(await getFilesystemProvider().listTrash());
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function restore(item: TrashItem) {
    setRestoring(item.path);
    setError(null);
    try {
      await getFilesystemProvider().restoreItem(item.path);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>
              Trash
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Deleted items live in the app-managed trash and can be restored to their original location.
            </p>
          </div>
        </div>

        {error && (
          <div className="bg-card border border-border rounded-xl px-5 py-3 flex items-center justify-between gap-4">
            <p className="text-sm text-foreground">{error}</p>
            <button
              onClick={() => void load()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-secondary transition-colors"
            >
              <RotateCcw size={12} />
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="bg-card border border-border rounded-xl min-h-[300px] flex flex-col items-center justify-center text-center">
            <div className="w-8 h-8 rounded-full border-2 border-border border-t-accent animate-spin mb-4" />
            <h2 className="text-base font-semibold text-foreground">Loading trash…</h2>
            <p className="text-sm text-muted-foreground mt-1">Reading the application-managed trash directory.</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mb-4">
              <Trash2 size={22} className="text-muted-foreground" />
            </div>
            <div className="text-sm font-medium text-foreground">Trash is empty</div>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Items you delete will appear here so you can restore them.
            </p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="grid grid-cols-[auto_1fr_120px_100px_1fr_auto] gap-4 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground border-b border-border">
              <div />
              <div>Name</div>
              <div>Size</div>
              <div>Modified</div>
              <div>Original location</div>
              <div />
            </div>
            {items.map((item) => (
              <div
                key={item.id}
                className="grid grid-cols-[auto_1fr_120px_100px_1fr_auto] gap-4 items-center px-5 py-3 border-b border-border last:border-none"
              >
                <FileIcon type={item.isFolder ? "folder" : item.fileType} size="sm" />
                <div className="min-w-0">
                  <div className="text-sm font-mono font-medium text-foreground truncate">{item.name}</div>
                </div>
                <div className="text-xs font-mono text-muted-foreground">
                  {item.isFolder ? "—" : item.size}
                </div>
                <div className="text-xs font-mono text-muted-foreground">{item.modified}</div>
                <div className="text-xs font-mono text-muted-foreground truncate" title={item.originalPath ?? undefined}>
                  {item.originalPath ?? "Unknown"}
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={() => void restore(item)}
                    disabled={restoring === item.path}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-secondary transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <RotateCcw size={12} className={restoring === item.path ? "animate-spin" : ""} />
                    {restoring === item.path ? "Restoring…" : "Restore"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}