import { useState } from "react";
import { Trash2, RotateCcw, AlertTriangle } from "../../components/Icons";
import { trashedFiles } from "../../data/files";
import FileIcon from "../FileIcon";

export default function Trash() {
  const [files, setFiles] = useState(trashedFiles);
  const [showConfirm, setShowConfirm] = useState<string | null>(null);

  function restore(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  function deletePermanently(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setShowConfirm(null);
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Trash</h1>
            <p className="text-sm text-muted-foreground mt-1">Files are permanently deleted after 30 days.</p>
          </div>
          {files.length > 0 && (
            <button
              onClick={() => setShowConfirm("all")}
              className="px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 border border-red-200 rounded-lg transition-colors"
            >
              Empty Trash
            </button>
          )}
        </div>

        {/* Warning */}
        {files.length > 0 && (
          <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
            <AlertTriangle size={15} />
            <span>Items in Trash will be permanently deleted after 30 days.</span>
          </div>
        )}

        {files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mb-4">
              <Trash2 size={22} className="text-muted-foreground" />
            </div>
            <div className="text-sm font-medium text-foreground">Trash is empty</div>
            <p className="text-xs text-muted-foreground mt-1">Deleted files will appear here.</p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl divide-y divide-border overflow-hidden">
            {files.map((file) => (
              <div key={file.id} className="flex items-center gap-4 px-5 py-3.5">
                <FileIcon type={file.type} size="sm" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-mono font-medium text-foreground truncate">{file.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{file.location} · Deleted {file.deletedOn}</div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => restore(file.id)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-foreground border border-border rounded-md hover:bg-secondary transition-colors"
                  >
                    <RotateCcw size={11} />
                    <span>Restore</span>
                  </button>
                  <button
                    onClick={() => setShowConfirm(file.id)}
                    className="px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded-md transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Confirm dialog */}
        {showConfirm && (
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-8">
            <div className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full shadow-xl">
              <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center mb-4">
                <Trash2 size={18} className="text-red-500" />
              </div>
              <h2 className="text-base font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>
                Permanently delete?
              </h2>
              <p className="text-sm text-muted-foreground mt-2">
                This action cannot be undone. The file will be permanently removed from your storage.
              </p>
              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => setShowConfirm(null)}
                  className="flex-1 px-4 py-2 text-sm border border-border rounded-lg hover:bg-secondary transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => deletePermanently(showConfirm)}
                  className="flex-1 px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                >
                  Delete permanently
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
