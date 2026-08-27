import { Sparkles, Filter } from "../../components/Icons";
import { sampleFiles } from "../../data/files";
import FileIcon from "../FileIcon";
import type { FileItem } from "../../data/files";

interface SearchProps {
  query: string;
  onOpenFile: (file: FileItem) => void;
}

const aiUnderstanding: Record<string, string[]> = {
  default: ["Documents", "Relevant content", "Recent files"],
  internship: ["Documents", "Internship/SIWES related content", "Recent or relevant files"],
  video: ["Video files", "Large media", "All folders"],
  duplicate: ["PDF files", "Duplicate content", "Same file size"],
  week: ["All file types", "Modified in last 7 days", "Any location"],
};

function getUnderstanding(q: string) {
  const l = q.toLowerCase();
  if (l.includes("internship") || l.includes("siwes")) return aiUnderstanding.internship;
  if (l.includes("video") || l.includes("large")) return aiUnderstanding.video;
  if (l.includes("duplicate")) return aiUnderstanding.duplicate;
  if (l.includes("week") || l.includes("yesterday") || l.includes("recent")) return aiUnderstanding.week;
  return aiUnderstanding.default;
}

function matchScore(file: FileItem, query: string): number {
  const q = query.toLowerCase();
  const name = file.name.toLowerCase();
  if (name.includes(q)) return 94;
  const words = q.split(" ");
  const matches = words.filter((w) => name.includes(w) || file.location.toLowerCase().includes(w) || file.type.includes(w));
  return Math.max(40, Math.round((matches.length / words.length) * 80 + Math.random() * 15));
}

function getReason(file: FileItem, query: string): string {
  const q = query.toLowerCase();
  if (file.name.toLowerCase().includes(q)) return `Filename directly matches "${query}".`;
  if (q.includes("internship") || q.includes("siwes")) return "Contains internship-related content and references to SIWES.";
  if (q.includes("university")) return "Located in the University folder, likely coursework.";
  if (q.includes("pdf")) return "PDF document matching your search criteria.";
  return `File type and location are relevant to "${query}".`;
}

export default function Search({ query, onOpenFile }: SearchProps) {
  const understanding = getUnderstanding(query);
  const results = sampleFiles
    .map((f) => ({ ...f, score: matchScore(f, query), reason: getReason(f, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 7);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        {/* Query header */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Search Query</div>
          <div className="text-lg font-medium text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>
            "{query}"
          </div>
        </div>

        {/* AI Understanding */}
        <div className="bg-ai-bg border border-indigo-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={14} className="text-ai-text" />
            <span className="text-sm font-semibold text-ai-text" style={{ fontFamily: "Instrument Sans, sans-serif" }}>AI Understanding</span>
          </div>
          <div className="text-xs text-ai-text mb-3">Looking for:</div>
          <ul className="space-y-1.5">
            {understanding.map((item) => (
              <li key={item} className="flex items-center gap-2 text-sm text-ai-text">
                <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Filter:</span>
          {["All", "PDF", "Documents", "Images", "Videos"].map((f) => (
            <button
              key={f}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors
                ${f === "All" ? "bg-foreground text-primary-foreground" : "bg-secondary text-muted-foreground hover:bg-border"}`}
            >
              {f}
            </button>
          ))}
          <button className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
            <Filter size={12} />
            More filters
          </button>
        </div>

        {/* Results */}
        <div>
          <div className="text-xs text-muted-foreground mb-3">{results.length} results</div>
          <div className="space-y-2">
            {results.map((file) => (
              <button
                key={file.id}
                onClick={() => onOpenFile(file)}
                className="w-full flex items-center gap-4 bg-card border border-border rounded-xl px-5 py-4 hover:border-accent/40 hover:shadow-sm transition-all text-left"
              >
                <FileIcon type={file.type} size="sm" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-mono font-medium text-foreground truncate">{file.name}</div>
                  <div className="text-xs text-muted-foreground mt-1 truncate">{file.reason}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{file.location} · {file.modified}</div>
                </div>
                <div className="flex flex-col items-end gap-2 flex-shrink-0">
                  <div className={`text-xs font-semibold px-2 py-0.5 rounded-full
                    ${file.score >= 90 ? "bg-emerald-50 text-emerald-600"
                    : file.score >= 75 ? "bg-blue-50 text-blue-600"
                    : "bg-secondary text-muted-foreground"}`}>
                    {file.score}% match
                  </div>
                  <div className="text-xs font-mono text-muted-foreground">{file.size}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
