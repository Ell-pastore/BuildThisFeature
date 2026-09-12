import { useEffect, useState } from "react";
import { Copy, RotateCcw } from "../Icons";
import FileIcon from "../FileIcon";
import { getFilesystemProvider } from "../../services/filesystem";
import type { DuplicateGroupsResult } from "../../services/filesystem";

/**
 * Duplicate detection.
 *
 * Backed by the real `duplicate_groups` provider call (Rust: bounded
 * size-bucket scan + streamed SHA-256 verification). Every group shown comes
 * from the provider — nothing is invented here. Groups and members are rendered
 * in the exact order the provider returned them, and the honest `truncated`
 * flag from Rust is surfaced as a non-error notice.
 */
export default function Duplicates() {
  const [result, setResult] = useState<DuplicateGroupsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadDuplicates() {
    setLoading(true);
    setError(null);
    try {
      const res = await getFilesystemProvider().duplicateGroups();
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDuplicates();
  }, []);

  const groups = result?.groups ?? [];
  const truncated = result?.truncated ?? false;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Copy size={16} className="text-purple-500" />
            <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Duplicate Detection</h1>
          </div>
          <p className="text-sm text-muted-foreground">Files verified as duplicates by size and content.</p>
        </div>

        {loading && !error ? (
          <div className="bg-card border border-border rounded-xl px-5 py-12 text-center">
            <div className="w-8 h-8 rounded-full border-2 border-border border-t-accent animate-spin mx-auto mb-4" />
            <p className="text-sm font-medium text-foreground">Scanning your files…</p>
            <p className="text-xs text-muted-foreground mt-1">
              Hashing size-matched files across your allowed folders.
            </p>
          </div>
        ) : error ? (
          <div className="bg-card border border-border rounded-xl px-5 py-12 text-center">
            <p className="text-sm font-medium text-foreground">Couldn't scan for duplicates</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">{error}</p>
            <button
              onClick={() => void loadDuplicates()}
              className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-secondary transition-colors"
            >
              <RotateCcw size={12} />
              Retry
            </button>
          </div>
        ) : groups.length === 0 ? (
          <div className="bg-card border border-border rounded-xl px-5 py-12 text-center">
            <div className="w-14 h-14 rounded-2xl bg-purple-50 flex items-center justify-center mb-4">
              <Copy size={22} className="text-purple-500" />
            </div>
            <div className="text-sm font-medium text-foreground">No duplicate files found</div>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm leading-relaxed mx-auto">
              Every distinct file in your allowed folders has unique content. Re-run the scan
              after adding files to check again.
            </p>
            {truncated && (
              <div className="mt-4 mx-auto max-w-sm rounded-lg border border-border bg-background px-4 py-3 text-xs text-muted-foreground">
                The scan stopped at its safety budget — the empty result may be incomplete.
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground">{groups.length === 1 ? "1 duplicate group" : `${groups.length} duplicate groups`}</div>

            {truncated && (
              <div className="rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground leading-relaxed">
                The scan stopped at its safety budget — the groups below may be incomplete. Try
                again later or reduce the files being scanned to see a fuller picture.
              </div>
            )}

            <div className="space-y-4">
              {groups.map((group) => (
                <div key={group.id} className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between gap-4 px-5 py-3 border-b border-border">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="text-sm font-semibold text-foreground">{group.size}</span>
                      <span className="text-xs text-muted-foreground">shared total</span>
                    </div>
                    <div className="text-xs font-medium text-muted-foreground flex-shrink-0">
                      {group.items.length === 1 ? "1 duplicate file" : `${group.items.length} duplicate files`}
                    </div>
                  </div>
                  <ul className="divide-y divide-border">
                    {group.items.map((file) => (
                      <li
                        key={file.id}
                        className="w-full flex items-center gap-4 px-5 py-4 text-left"
                      >
                        <FileIcon type={file.type} size="sm" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-mono font-medium text-foreground truncate">
                            {file.name}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 truncate">
                            {file.location} · {file.modified}
                          </div>
                        </div>
                        <div className="text-xs font-mono text-muted-foreground flex-shrink-0">
                          {file.size}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}