import { useState } from "react";
import { Sparkles, Check, X, ChevronRight, RotateCcw } from "../../components/Icons";
import { aiOrgSuggestions } from "../../data/files";
import FileIcon from "../FileIcon";

interface Suggestion {
  id: string;
  name: string;
  from: string;
  to: string;
  reason: string;
  confidence: number;
  accepted: boolean | null;
}

export default function AIOrganization() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>(aiOrgSuggestions);
  const [applied, setApplied] = useState(false);

  function accept(id: string) {
    setSuggestions((prev) => prev.map((s) => s.id === id ? { ...s, accepted: true } : s));
  }
  function reject(id: string) {
    setSuggestions((prev) => prev.map((s) => s.id === id ? { ...s, accepted: false } : s));
  }
  function acceptAll() {
    setSuggestions((prev) => prev.map((s) => ({ ...s, accepted: true })));
  }
  function rejectAll() {
    setSuggestions((prev) => prev.map((s) => ({ ...s, accepted: false })));
  }

  const accepted = suggestions.filter((s) => s.accepted === true).length;
  const pending = suggestions.filter((s) => s.accepted === null).length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={16} className="text-accent" />
            <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>AI Organization</h1>
          </div>
          <p className="text-sm text-muted-foreground">Let Smart File Manager analyze your files and suggest a better structure.</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: "Files analyzed", value: "312" },
            { label: "Misplaced files", value: "23" },
            { label: "Duplicate files", value: "8" },
            { label: "Suggested folders", value: "5" },
          ].map(({ label, value }) => (
            <div key={label} className="bg-card border border-border rounded-xl px-4 py-4 text-center">
              <div className="text-2xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>{value}</div>
              <div className="text-xs text-muted-foreground mt-1">{label}</div>
            </div>
          ))}
        </div>

        {/* Suggestion header */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-foreground font-medium">Your Downloads folder contains files that appear to belong in other folders.</p>
            <p className="text-xs text-muted-foreground mt-0.5">{pending} pending · {accepted} accepted</p>
          </div>
          <div className="flex gap-2">
            <button onClick={rejectAll} className="px-3 py-1.5 text-xs font-medium border border-border rounded-lg text-muted-foreground hover:bg-secondary transition-colors">
              Reject all
            </button>
            <button onClick={acceptAll} className="px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-lg hover:bg-indigo-600 transition-colors">
              Accept all
            </button>
          </div>
        </div>

        {/* Suggestions */}
        <div className="space-y-2">
          {suggestions.map((s) => (
            <div
              key={s.id}
              className={`bg-card border rounded-xl px-5 py-4 transition-all
                ${s.accepted === true ? "border-emerald-200 bg-emerald-50/50"
                : s.accepted === false ? "border-border opacity-50"
                : "border-border hover:border-accent/30"}`}
            >
              <div className="flex items-start gap-4">
                <FileIcon type="pdf" size="sm" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-mono font-medium text-foreground truncate">{s.name}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0
                      ${s.confidence >= 90 ? "bg-emerald-50 text-emerald-600"
                      : s.confidence >= 80 ? "bg-blue-50 text-blue-600"
                      : "bg-secondary text-muted-foreground"}`}>
                      {s.confidence}% confidence
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                    <span className="font-mono bg-secondary px-2 py-0.5 rounded">{s.from}</span>
                    <ChevronRight size={12} />
                    <span className="font-mono bg-indigo-50 text-ai-text px-2 py-0.5 rounded">{s.to}</span>
                  </div>
                  <p className="text-xs text-muted-foreground italic">"{s.reason}"</p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  {s.accepted === null ? (
                    <>
                      <button
                        onClick={() => accept(s.id)}
                        className="w-8 h-8 flex items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 hover:bg-emerald-100 transition-colors"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        onClick={() => reject(s.id)}
                        className="w-8 h-8 flex items-center justify-center rounded-lg bg-secondary text-muted-foreground hover:bg-border transition-colors"
                      >
                        <X size={14} />
                      </button>
                    </>
                  ) : s.accepted ? (
                    <div className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
                      <Check size={13} />
                      <span>Accepted</span>
                      <button onClick={() => setSuggestions((p) => p.map((x) => x.id === s.id ? { ...x, accepted: null } : x))} className="ml-1 text-muted-foreground hover:text-foreground">
                        <RotateCcw size={11} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <X size={13} />
                      <span>Rejected</span>
                      <button onClick={() => setSuggestions((p) => p.map((x) => x.id === s.id ? { ...x, accepted: null } : x))} className="ml-1 hover:text-foreground">
                        <RotateCcw size={11} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Apply */}
        {accepted > 0 && !applied && (
          <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4">
            <div>
              <div className="text-sm font-medium text-emerald-700">{accepted} changes ready to apply</div>
              <div className="text-xs text-emerald-600 mt-0.5">You can undo these changes immediately after.</div>
            </div>
            <button
              onClick={() => setApplied(true)}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors"
            >
              Apply changes
            </button>
          </div>
        )}

        {applied && (
          <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4 text-emerald-700">
            <Check size={16} />
            <span className="text-sm font-medium">{accepted} files organized successfully.</span>
            <button onClick={() => setApplied(false)} className="ml-auto flex items-center gap-1.5 text-xs hover:text-emerald-900 transition-colors">
              <RotateCcw size={12} />
              Undo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
