import { useState } from "react";
import { Filter } from "../../components/Icons";
import FileIcon from "../FileIcon";
import type { FileItem } from "../../types";

/**
 * Client-side quick filters; only ever applied to non-folder results.
 *
 * Extension sets mirror the canonical classification in
 * `desktop/src/fs_service.rs` (`storage_category_for_extension`). PDF is its
 * own chip (only `pdf`); the Documents chip takes the remaining canonical
 * Documents extensions.
 */
const TYPE_FILTERS: Record<string, Set<string>> = {
  PDF: new Set(["pdf"]),
  Documents: new Set([
    "txt", "rtf", "doc", "docx", "odt", "xls", "xlsx", "csv", "ods", "ppt",
    "pptx", "odp", "pages", "numbers", "keynote", "md", "tex", "epub", "mobi",
    "log",
  ]),
  Images: new Set([
    "jpg", "jpeg", "png", "gif", "bmp", "tiff", "tif", "webp", "svg", "ico",
    "heic", "heif", "raw", "psd", "ai", "eps",
  ]),
  Videos: new Set([
    "mp4", "mov", "mkv", "avi", "webm", "flv", "wmv", "m4v", "m2ts", "3gp",
    "mpg", "mpeg",
  ]),
};

interface SearchProps {
  query: string;
  onOpenFile: (file: FileItem) => void;
  /** Navigate into a folder (falls back to onOpenFile when unset). */
  onOpenFolder?: (item: FileItem) => void;
  /** Real results from the recursive desktop filesystem search. */
  results?: FileItem[];
  /** True while the recursive search is in flight. */
  searching?: boolean;
  /** Honest error string when the underlying search failed. */
  error?: string | null;
}

export default function Search({
  query,
  onOpenFile,
  onOpenFolder,
  results = [],
  searching = false,
  error = null,
}: SearchProps) {
  const hasQuery = query.trim().length > 0;
  const [activeFilter, setActiveFilter] = useState("All");

  // Folders always pass a quick filter; only non-folder results are filtered.
  const filtered =
    activeFilter === "All"
      ? results
      : results.filter(
          (r) => r.isFolder || (TYPE_FILTERS[activeFilter]?.has(r.type.toLowerCase()) ?? false),
        );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        {hasQuery && (
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">
              Search Query
            </div>
            <div
              className="text-lg font-medium text-foreground"
              style={{ fontFamily: "Instrument Sans, sans-serif" }}
            >
              "{query}"
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Filter:</span>
          {["All", "PDF", "Documents", "Images", "Videos"].map((f) => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors
                ${activeFilter === f ? "bg-foreground text-primary-foreground" : "bg-secondary text-muted-foreground hover:bg-border"}`}
            >
              {f}
            </button>
          ))}
          <button className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
            <Filter size={12} />
            More filters
          </button>
        </div>

        {/* Results — rendered only from real provider data; honest states. */}
        <div>
          {searching ? (
            <div className="bg-card border border-border rounded-xl px-5 py-12 text-center">
              <div className="w-8 h-8 rounded-full border-2 border-border border-t-accent animate-spin mx-auto mb-4" />
              <p className="text-sm font-medium text-foreground">Searching your folders…</p>
              <p className="text-xs text-muted-foreground mt-1">
                Looking through all your allowed folders.
              </p>
            </div>
          ) : error ? (
            <div className="bg-card border border-border rounded-xl px-5 py-12 text-center">
              <p className="text-sm font-medium text-foreground">Couldn't search your folders</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">{error}</p>
            </div>
          ) : !hasQuery ? (
            <div className="bg-card border border-border rounded-xl px-5 py-12 text-center">
              <p className="text-sm font-medium text-foreground">Search across all your folders</p>
              <p className="text-xs text-muted-foreground mt-1">
                Type a query to find files and folders anywhere on your allowed filesystem.
              </p>
            </div>
          ) : results.length === 0 ? (
            <div className="bg-card border border-border rounded-xl px-5 py-12 text-center">
              <p className="text-sm font-medium text-foreground">No files found</p>
              <p className="text-xs text-muted-foreground mt-1">
                Nothing in your folders matches "{query}".
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="bg-card border border-border rounded-xl px-5 py-12 text-center">
              <p className="text-sm font-medium text-foreground">No matching results</p>
              <p className="text-xs text-muted-foreground mt-1">
                Nothing matches the "{activeFilter}" filter.
              </p>
            </div>
          ) : (
            <>
              <div className="text-xs text-muted-foreground mb-3">{filtered.length} results</div>
              <div className="space-y-2">
                {filtered.map((file) => (
                  <button
                    key={file.id}
                    onClick={() => (file.isFolder ? onOpenFolder?.(file) : onOpenFile(file))}
                    className="w-full flex items-center gap-4 bg-card border border-border rounded-xl px-5 py-4 hover:border-accent/40 hover:shadow-sm transition-all text-left"
                  >
                    <FileIcon type={file.type} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-mono font-medium text-foreground truncate">
                        {file.name}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {file.location} · {file.modified}
                      </div>
                    </div>
                    <div className="text-xs font-mono text-muted-foreground flex-shrink-0">
                      {file.size}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}