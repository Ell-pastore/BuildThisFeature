import { useEffect, useState } from "react";
import { ChevronUp } from "./Icons";
import { getFilesystemProvider } from "../services/filesystem";
import type { FileItem } from "../types";
import FileIcon from "./FileIcon";

interface MoveFolderDialogProps {
  /** Name of the item being moved/copied (shown in the title for context). */
  itemName: string;
  /** Folder the picker opens in (the item's current parent). */
  initialPath: string;
  /** Verb used in the title, e.g. "Move" or "Copy". */
  titleVerb?: string;
  /** Confirm button label, e.g. "Move here" or "Copy here". */
  actionLabel?: string;
  onConfirm: (destDir: string) => void;
  onClose: () => void;
}

/**
 * Modal folder picker reused by the Move and Copy flows. Browses the REAL
 * filesystem through the FilesystemProvider.listDirectory() bridge; the
 * "currently selected destination" is always the folder being viewed.
 */
export default function MoveFolderDialog({
  itemName,
  initialPath,
  titleVerb = "Move",
  actionLabel = "Move here",
  onConfirm,
  onClose,
}: MoveFolderDialogProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [folders, setFolders] = useState<FileItem[]>([]);
  const [upPath, setUpPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getFilesystemProvider()
      .listDirectory(currentPath)
      .then((listing) => {
        if (cancelled) return;
        setFolders(listing.items.filter((i) => i.isFolder));
        setUpPath(listing.parentPath);
      })
      .catch((err) => {
        if (cancelled) return;
        setFolders([]);
        setUpPath(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-8">
      <div className="bg-card border border-border rounded-2xl p-6 max-w-lg w-full shadow-xl">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-foreground">{titleVerb} "{itemName}" to</div>
            <div className="text-xs text-muted-foreground mt-1">Navigate to the destination folder.</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Currently selected destination */}
        <div className="mt-4 px-3 py-2.5 border border-accent/40 bg-accent/5 rounded-lg">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Selected destination
          </div>
          <div className="text-sm font-mono text-foreground truncate mt-0.5">{currentPath}</div>
        </div>

        {/* Browse real folders */}
        <div className="mt-4 border border-border rounded-lg overflow-hidden max-h-64 flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/40">
            <span className="text-xs font-medium text-muted-foreground">Folders</span>
            <button
              onClick={() => {
                if (upPath) {
                  setCurrentPath(upPath);
                }
              }}
              disabled={!upPath}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-border text-muted-foreground hover:bg-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronUp size={12} />
              Up
            </button>
          </div>

          <div className="p-1 overflow-y-auto">
            {loading ? (
              <div className="px-3 py-6 text-center">
                <div className="w-6 h-6 rounded-full border-2 border-border border-t-accent animate-spin mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">Loading folders…</p>
              </div>
            ) : error ? (
              <div className="px-3 py-6 text-center">
                <p className="text-sm text-foreground">Couldn't load this folder</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">{error}</p>
              </div>
            ) : folders.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <p className="text-sm text-foreground">No subfolders here</p>
                <p className="text-xs text-muted-foreground mt-1">
                  You can still place the item into the selected folder above.
                </p>
              </div>
            ) : (
              folders.map((folder) => (
                <button
                  key={folder.id}
                  onClick={() => {
                    if (folder.path) setCurrentPath(folder.path);
                  }}
                  className="w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-left hover:bg-secondary transition-colors"
                >
                  <FileIcon type="folder" size="sm" />
                  <span className="text-sm text-foreground truncate">{folder.name}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 text-sm border border-border rounded-lg hover:bg-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={loading}
            onClick={() => onConfirm(currentPath)}
            className="flex-1 px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-indigo-600 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}