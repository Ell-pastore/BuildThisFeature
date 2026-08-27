import { sampleFiles } from "../../data/files";
import FileIcon from "../FileIcon";
import type { FileItem } from "../../data/files";
import { Clock } from "../../components/Icons";

interface RecentProps {
  onOpenFile: (file: FileItem) => void;
}

const groups = [
  { label: "Today", files: sampleFiles.slice(0, 2), activity: ["Opened", "Modified"] },
  { label: "Yesterday", files: sampleFiles.slice(2, 4), activity: ["Created", "Opened"] },
  { label: "Earlier this week", files: sampleFiles.slice(4, 7), activity: ["Modified", "Renamed", "Opened"] },
  { label: "Earlier", files: sampleFiles.slice(7), activity: ["Opened", "Moved", "Opened", "Opened", "Created", "Moved", "Opened", "Modified"] },
];

export default function Recent({ onOpenFile }: RecentProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-8">
        <div>
          <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Recent</h1>
          <p className="text-sm text-muted-foreground mt-1">Files you've opened, modified, or created recently.</p>
        </div>

        {groups.map(({ label, files, activity }) => (
          <div key={label}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</span>
              <div className="flex-1 h-px bg-border" />
            </div>
            <div className="bg-card border border-border rounded-xl divide-y divide-border overflow-hidden">
              {files.map((file, i) => (
                <button
                  key={file.id}
                  onClick={() => onOpenFile(file)}
                  className="w-full flex items-center gap-4 px-5 py-3 hover:bg-secondary transition-colors text-left"
                >
                  <FileIcon type={file.type} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-mono font-medium text-foreground truncate">{file.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{file.location}</div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium
                      ${activity[i] === "Modified" ? "bg-amber-50 text-amber-600"
                      : activity[i] === "Created" ? "bg-emerald-50 text-emerald-600"
                      : activity[i] === "Renamed" ? "bg-blue-50 text-blue-600"
                      : activity[i] === "Moved" ? "bg-purple-50 text-purple-600"
                      : "bg-zinc-100 text-zinc-500"
                    }`}>
                      {activity[i] ?? "Opened"}
                    </span>
                    <span className="text-xs font-mono text-muted-foreground">{file.size}</span>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock size={11} />
                      <span>{file.modified}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
