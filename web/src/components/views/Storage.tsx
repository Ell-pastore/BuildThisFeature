import { HardDrive, Sparkles } from "../../components/Icons";
import { formatBytes } from "../../services/format";
import type { DiskUsage } from "../../services/filesystem";

interface StorageProps {
  /** Real free/total space reported by Rust (`disk_usage`). Null while loading or unsupported. */
  diskUsage?: DiskUsage | null;
}

/**
 * Storage view backed by REAL volume statistics from the Rust backend.
 *
 * Deliberate limitations, shown honestly instead of faked:
 * - A per-category breakdown ("Documents: 18 GB ...") would require scanning or
 *   indexing large parts of the disk. Not implemented in this release.
 * - Largest-files ranking and AI cleanup suggestions need that same index plus
 *   an AI backend, so those sections are placeholders - never invented numbers.
 */
export default function Storage({ diskUsage }: StorageProps) {
  const totalBytes = diskUsage?.totalBytes ?? 0;
  const usedBytes =
    diskUsage && diskUsage.totalBytes >= diskUsage.freeBytes
      ? diskUsage.totalBytes - diskUsage.freeBytes
      : 0;
  const hasUsage = totalBytes > 0;
  const usedPct = hasUsage ? Math.min(100, (usedBytes / totalBytes) * 100) : 0;

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

        {/* Category breakdown — deliberately not implemented yet */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">By Category</h2>
          <div className="bg-card border border-border rounded-xl px-5 py-8 text-center">
            <div className="text-sm font-medium text-foreground">Category breakdown isn't available yet</div>
            <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto leading-relaxed">
              Grouping storage by Documents/Videos/Images etc. requires indexing files across your
              disks, which isn't part of this release. We won't show made-up sizes here in the meantime.
            </p>
          </div>
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