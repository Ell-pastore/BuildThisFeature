import { useEffect, useState } from "react";
import { Copy, RotateCcw, ExternalLink, FolderOpen, Trash2 } from "../Icons";
import FileIcon from "../FileIcon";
import { getFilesystemProvider } from "../../services/filesystem";
import type { DuplicateGroupsResult } from "../../services/filesystem";
import type { FileItem } from "../../types";

interface DuplicatesProps {
  /** Open a member with its default app (wired to the filesystem action). */
  onOpen?: (file: FileItem) => void;
  /** Navigate to a member's containing folder in the Files view. */
  onReveal?: (file: FileItem) => void;
}

/**
 * Duplicate detection.
 *
 * Backed by the real `duplicate_groups` provider call (Rust: bounded
 * size-bucket scan + streamed SHA-256 verification). Every group shown comes
 * from the provider — nothing is invented here. Groups and members are rendered
 * in the exact order the provider returned them, and the honest `truncated`
 * flag from Rust is surfaced as a non-error notice.
 *
 * Members support the same core actions as the rest of the app: Open (default
 * app), Reveal (navigate to the containing folder), and Delete (moves the file
 * to the app-managed Trash through the existing `trashItem` flow — never a
 * permanent delete). A successful delete re-runs the real duplicate scan so the
 * groups reflect the filesystem; a failed delete or re-scan is surfaced
 * honestly without fabricating results.
 */
export default function Duplicates({ onOpen, onReveal }: DuplicatesProps) {
  const [result, setResult] = useState<DuplicateGroupsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);

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

  async function deleteMember(file: FileItem) {
    const path = file.path ?? file.id;
    setDeletingPath(path);
    setActionError(null);
    try {
      await getFilesystemProvider().trashItem(path);
      await loadDuplicates();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingPath(null);
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

        {/* Member-action error — honest and non-destructive; the list stays. */}
        {actionError && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
            {actionError}
          </div>
        )}

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
                        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                          <button
                            type="button"
                            onClick={() => onOpen?.(file)}
                            title={`Open ${file.name}`}
                            aria-label={`Open ${file.name}`}
                            className="p-1.5 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                          >
                            <ExternalLink size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => onReveal?.(file)}
                            title={`Reveal ${file.name}`}
                            aria-label={`Reveal ${file.name}`}
                            className="p-1.5 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                          >
                            <FolderOpen size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteMember(file)}
                            disabled={deletingPath === (file.path ?? file.id)}
                            title={`Delete ${file.name}`}
                            aria-label={`Delete ${file.name}`}
                            className="p-1.5 rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-50"
                          >
                            <Trash2 size={12} />
                          </button>
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