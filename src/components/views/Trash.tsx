import { useState } from "react";
import { Trash2, AlertTriangle } from "../../components/Icons";

/**
 * Trash. Currently delete is permanent — there is no OS-trash backend yet, so
 * this view shows an empty state rather than faking deleted files.
 */
export default function Trash() {
  const [showConfirm, setShowConfirm] = useState<string | null>(null);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Trash</h1>
            <p className="text-sm text-muted-foreground mt-1">Files are permanently deleted after 30 days.</p>
          </div>
        </div>

        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mb-4">
            <Trash2 size={22} className="text-muted-foreground" />
          </div>
          <div className="text-sm font-medium text-foreground">Trash is empty</div>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs">
            Deleted files will appear here. Note: the OS trash integration isn't
            implemented yet — deleting currently removes files permanently.
          </p>
        </div>

        {/* Confirm dialog (kept for future use) */}
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
                This action cannot be undone.
              </p>
              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => setShowConfirm(null)}
                  className="flex-1 px-4 py-2 text-sm border border-border rounded-lg hover:bg-secondary transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => setShowConfirm(null)}
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
