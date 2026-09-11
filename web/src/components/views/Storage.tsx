import { HardDrive, RotateCcw, Sparkles } from "../../components/Icons";
import { formatBytes } from "../../services/format";
import type { DiskUsage, StorageBreakdown, StorageCategoryName } from "../../services/filesystem";

interface StorageProps {
  /** Real free/total space reported by Rust (`disk_usage`). Null while loading or unsupported. */
  diskUsage?: DiskUsage | null;
  /** Real per-category file sizes from the bounded `storage_by_category` scan. */
  breakdown?: StorageBreakdown | null;
  /** True while the category scan is in flight. */
  loading?: boolean;
  /** Honest scan error, or null. */
  error?: string | null;
  /** Re-run the category scan (e.g. after a transient error). */
  onRetry?: () => void;
}

const CATEGORY_COLORS: Record<StorageCategoryName, string> = {
  Documents: "bg-blue-400",
  Images: "bg-purple-400",
  Videos: "bg-indigo-400",
  Audio: "bg-emerald-400",
  Archives: "bg-orange-400",
  Code: "bg-sky-400",
  Other: "bg-zinc-400",
};

/** Color dot keyed by category; unknown categories fall back to a neutral dot. */
function categoryColor(category: string): string {
  return CATEGORY_COLORS[category as StorageCategoryName] ?? "bg-zinc-400";
}

/**
 * Storage view backed by REAL volume statistics (Rust `disk_usage`) and REAL
 * per-category file sizes (Rust `storage_by_category`).
 *
 * No numbers here are invented: totals come from scanning the allowed roots,
 * and if the scan hits its safety cap (`scanCapped`) that is shown honestly.
 */
export default function Storage({
  diskUsage,
  breakdown,
  loading = false,
  error = null,
  onRetry,
}: StorageProps) {
  const totalBytes = diskUsage?.totalBytes ?? 0;
  const usedBytes =
    diskUsage && diskUsage.totalBytes >= diskUsage.freeBytes
      ? diskUsage.totalBytes - diskUsage.freeBytes
      : 0;
  const hasUsage = totalBytes > 0;
  const usedPct = hasUsage ? Math.min(100, (usedBytes / totalBytes) * 100) : 0;

  const hasBreakdown =
    !!breakdown && breakdown.scannedFileCount > 0 && breakdown.totalBytes > 0;
  const largestCategory = hasBreakdown
    ? Math.max(...breakdown!.categories.map((c) => c.bytes), 1)
    : 1;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <HardDrive size={16} className="text-emerald-500" />
            <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Storage Analysis</h1>
          </div>
          <p className="text-sm text-muted-foreground">Overview of your storage usage.</p>
        </div>

        {/* Main storage card — real volume capacity read by the OS via Rust */}
        <div className="bg-card border border-border rounded-xl p-6 space-y-5">
          {hasUsage && diskUsage ? (
            <>
              <div className="flex items-end justify-between">
                <div>
                  <div className="text-3xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>{formatBytes(usedBytes)}</div>
                  <div className="text-sm text-muted-foreground mt-1">used of {formatBytes(diskUsage.totalBytes)}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium text-foreground">{formatBytes(diskUsage.freeBytes)}</div>
                  <div className="text-xs text-muted-foreground">available</div>
                </div>
              </div>

              {/* Overall bar */}
              <div className="h-3 bg-secondary rounded-full overflow-hidden flex gap-0.5">
                <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${usedPct}%` }} />
              </div>

              {/* Legend */}
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 flex-shrink-0" />
                  <div className="text-xs font-medium text-foreground">Used · {usedPct.toFixed(0)}%</div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-zinc-300 flex-shrink-0" />
                  <div className="text-xs font-medium text-foreground">Free · {(100 - usedPct).toFixed(0)}%</div>
                </div>
              </div>
            </>
          ) : (
            <div className="py-10 text-center">
              <div className="text-sm font-medium text-foreground">Real storage numbers aren't available right now</div>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto leading-relaxed">
                Free space comes straight from your operating system through the Tauri backend.
                If the app isn't running inside the Tauri desktop shell, no real numbers can be
                shown — we don't display invented ones.
              </p>
            </div>
          )}
        </div>

        {/* Category breakdown — real sizes from the bounded Rust scan */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">By Category</h2>

          {error ? (
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
          ) : loading ? (
            <div className="bg-card border border-border rounded-xl min-h-[240px] flex flex-col items-center justify-center text-center">
              <div className="w-8 h-8 rounded-full border-2 border-border border-t-accent animate-spin mb-4" />
              <div className="text-sm font-medium text-foreground">Scanning your folders…</div>
              <p className="text-xs text-muted-foreground mt-1">Aggregating real file sizes by category across your allowed folders.</p>
            </div>
          ) : !hasBreakdown ? (
            <div className="bg-card border border-border rounded-xl px-5 py-8 text-center">
              <div className="text-sm font-medium text-foreground">No scanned files found</div>
              <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto leading-relaxed">
                Nothing was classified in your allowed folders. Files you add will appear here next time.
              </p>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl divide-y divide-border overflow-hidden">
              <div className="px-5 py-3 text-xs text-muted-foreground">
                Based on {breakdown!.scannedFileCount.toLocaleString()} scanned files · {formatBytes(breakdown!.totalBytes)} total
              </div>
              {breakdown!.categories.map((c) => (
                <div key={c.category} className="px-5 py-3.5 flex items-center gap-4">
                  <div className="flex items-center gap-2 w-28 flex-shrink-0">
                    <div className={`w-2.5 h-2.5 rounded-full ${categoryColor(c.category)} flex-shrink-0`} />
                    <span className="text-sm font-medium text-foreground truncate">{c.category}</span>
                  </div>
                  <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
                    <div
                      className={`h-full ${categoryColor(c.category)} rounded-full`}
                      style={{ width: `${(c.bytes / largestCategory) * 100}%` }}
                    />
                  </div>
                  <div className="text-xs font-mono text-muted-foreground w-16 text-right flex-shrink-0">
                    {formatBytes(c.bytes)}
                  </div>
                </div>
              ))}
              {breakdown!.scanCapped && (
                <div className="px-5 py-3 border-t border-border">
                  <p className="text-xs text-muted-foreground">
                    The scan stopped at its safety limit, so these totals reflect the scanned files only.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* AI insight — honest placeholder until the AI backend exists */}
        <div className="bg-ai-bg border border-indigo-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={13} className="text-ai-text" />
            <span className="text-sm font-semibold text-ai-text" style={{ fontFamily: "Instrument Sans, sans-serif" }}>AI Insight</span>
          </div>
          <p className="text-sm text-ai-text leading-relaxed">
            AI-powered insights aren't connected in this build yet. Suggestions will be based on
            your real files once the analysis backend ships — nothing automated is running today.
          </p>
        </div>
      </div>
    </div>
  );
}