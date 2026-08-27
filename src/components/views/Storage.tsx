import { HardDrive, Sparkles } from "../../components/Icons";

const categories = [
  { label: "Documents", size: "18.4 GB", pct: 27, color: "bg-blue-400" },
  { label: "Videos", size: "28.7 GB", pct: 42, color: "bg-purple-400" },
  { label: "Images", size: "9.6 GB", pct: 14, color: "bg-emerald-400" },
  { label: "Audio", size: "3.2 GB", pct: 5, color: "bg-amber-400" },
  { label: "Archives", size: "5.1 GB", pct: 7, color: "bg-orange-400" },
  { label: "Other", size: "3.4 GB", pct: 5, color: "bg-zinc-300" },
];

const largestFiles = [
  { name: "Lecture_Recordings.mp4", size: "1.8 GB", location: "Videos", lastOpened: "Aug 8, 2026" },
  { name: "Holiday_Photos.zip", size: "234 MB", location: "Downloads", lastOpened: "Aug 10, 2026" },
  { name: "Java_Project.zip", size: "45 MB", location: "Downloads", lastOpened: "Aug 5, 2026" },
  { name: "Presentation_Final.pptx", size: "8.7 MB", location: "Documents/Projects", lastOpened: "Aug 12, 2026" },
  { name: "Project_Proposal.pdf", size: "3.1 MB", location: "Documents/Projects", lastOpened: "Aug 18, 2026" },
];

export default function Storage() {
  const usedGb = 68.4;
  const totalGb = 256;
  const usedPct = (usedGb / totalGb) * 100;

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

        {/* Main storage card */}
        <div className="bg-card border border-border rounded-xl p-6 space-y-5">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-3xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>{usedGb} GB</div>
              <div className="text-sm text-muted-foreground mt-1">used of {totalGb} GB</div>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium text-foreground">{totalGb - usedGb} GB</div>
              <div className="text-xs text-muted-foreground">available</div>
            </div>
          </div>

          {/* Overall bar */}
          <div className="h-3 bg-secondary rounded-full overflow-hidden flex gap-0.5">
            {categories.map((c) => (
              <div key={c.label} className={`h-full ${c.color} first:rounded-l-full last:rounded-r-full`} style={{ width: `${c.pct}%` }} />
            ))}
          </div>

          {/* Legend */}
          <div className="grid grid-cols-3 gap-3">
            {categories.map((c) => (
              <div key={c.label} className="flex items-center gap-2">
                <div className={`w-2.5 h-2.5 rounded-full ${c.color} flex-shrink-0`} />
                <div>
                  <div className="text-xs font-medium text-foreground">{c.label}</div>
                  <div className="text-[10px] text-muted-foreground font-mono">{c.size} · {c.pct}%</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* AI suggestion */}
        <div className="bg-ai-bg border border-indigo-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={13} className="text-ai-text" />
            <span className="text-sm font-semibold text-ai-text" style={{ fontFamily: "Instrument Sans, sans-serif" }}>AI Insight</span>
          </div>
          <p className="text-sm text-ai-text">Your Videos folder uses 42% of your storage. 12 large videos haven't been opened in 6 months and could be archived.</p>
          <button className="mt-3 px-3 py-1.5 bg-accent text-white text-xs font-medium rounded-lg hover:bg-indigo-600 transition-colors">
            Review videos
          </button>
        </div>

        {/* Largest files */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Largest Files</h2>
          <div className="bg-card border border-border rounded-xl divide-y divide-border overflow-hidden">
            {largestFiles.map((file) => (
              <div key={file.name} className="flex items-center gap-4 px-5 py-3.5">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-mono font-medium text-foreground truncate">{file.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{file.location} · Last opened {file.lastOpened}</div>
                </div>
                <span className="text-sm font-mono font-semibold text-foreground">{file.size}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Cleanup */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Cleanup Suggestions</h2>
          <div className="space-y-3">
            {[
              { label: "Old files (not opened in 6+ months)", size: "2.1 GB", action: "Review" },
              { label: "Potential duplicates", size: "127 MB", action: "Review duplicates" },
              { label: "Large downloads (>100 MB)", size: "279 MB", action: "Review" },
            ].map(({ label, size, action }) => (
              <div key={label} className="flex items-center justify-between bg-card border border-border rounded-xl px-5 py-4">
                <div>
                  <div className="text-sm text-foreground font-medium">{label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Potential savings: {size}</div>
                </div>
                <button className="px-3 py-1.5 text-xs font-medium text-ai-text bg-ai-bg hover:bg-indigo-100 rounded-lg transition-colors">
                  {action}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
