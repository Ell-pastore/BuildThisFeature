import { useState } from "react";
import { Copy, Trash2, Shield, ChevronDown, ChevronUp } from "../../components/Icons";
import { duplicateGroups } from "../../data/files";
import FileIcon from "../FileIcon";

export default function Duplicates() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["d1"]));
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<string | null>(null);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function markDeleted(fileId: string) {
    setDeleted((prev) => new Set([...prev, fileId]));
    setConfirm(null);
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Copy size={16} className="text-purple-500" />
            <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Duplicate Detection</h1>
          </div>
          <p className="text-sm text-muted-foreground">Files that appear to be identical or near-identical copies.</p>
        </div>

        {/* Summary */}
        <div className="bg-purple-50 border border-purple-200 rounded-xl px-5 py-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-purple-700">{duplicateGroups.length} duplicate groups found</div>
            <div className="text-xs text-purple-600 mt-0.5">Approx. 127 MB of duplicate storage</div>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-purple-600">
            <Shield size={13} />
            <span>No files deleted automatically</span>
          </div>
        </div>

        {/* Groups */}
        <div className="space-y-3">
          {duplicateGroups.map((group, gi) => {
            const isExpanded = expanded.has(group.id);
            const groupDeleted = group.files.filter((f) => deleted.has(f.id));
            return (
              <div key={group.id} className="bg-card border border-border rounded-xl overflow-hidden">
                <button
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-secondary transition-colors"
                  onClick={() => toggle(group.id)}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] font-mono text-muted-foreground">GROUP {String(gi + 1).padStart(2, "0")}</span>
                    <span className="text-sm font-medium text-foreground">{group.files[0].name.replace(/(_Copy|_Final|\s?\(1\)).*/, "")}</span>
                    <span className="text-xs text-muted-foreground">{group.files.length} copies · {group.files[0].size}</span>
                    {groupDeleted.length > 0 && (
                      <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                        {groupDeleted.length} deleted
                      </span>
                    )}
                  </div>
                  {isExpanded ? <ChevronUp size={15} className="text-muted-foreground" /> : <ChevronDown size={15} className="text-muted-foreground" />}
                </button>

                {isExpanded && (
                  <div className="border-t border-border divide-y divide-border">
                    {group.files.map((file) => {
                      const isDeleted = deleted.has(file.id);
                      return (
                        <div
                          key={file.id}
                          className={`flex items-center gap-4 px-5 py-3.5 transition-colors ${isDeleted ? "opacity-40" : ""}`}
                        >
                          <FileIcon type="pdf" size="sm" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-mono font-medium text-foreground truncate">{file.name}</span>
                              {file.isBest && (
                                <span className="text-[10px] px-2 py-0.5 bg-emerald-50 text-emerald-600 rounded-full font-medium flex-shrink-0">
                                  Best version
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5 font-mono">{file.location} · {file.size} · {file.modified}</div>
                          </div>
                          {!isDeleted && (
                            <div className="flex gap-2 flex-shrink-0">
                              {!file.isBest && (
                                <button
                                  onClick={() => setConfirm(file.id)}
                                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-md transition-colors"
                                >
                                  <Trash2 size={11} />
                                  Delete duplicate
                                </button>
                              )}
                              <button className="px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary rounded-md transition-colors">
                                Keep
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Confirm delete */}
        {confirm && (
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-8">
            <div className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full shadow-xl">
              <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center mb-4">
                <Trash2 size={18} className="text-red-500" />
              </div>
              <h2 className="text-base font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Delete duplicate?</h2>
              <p className="text-sm text-muted-foreground mt-2">The file will be moved to Trash. You can restore it from there.</p>
              <div className="flex gap-3 mt-6">
                <button onClick={() => setConfirm(null)} className="flex-1 px-4 py-2 text-sm border border-border rounded-lg hover:bg-secondary transition-colors">
                  Cancel
                </button>
                <button onClick={() => markDeleted(confirm)} className="flex-1 px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors">
                  Move to Trash
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
