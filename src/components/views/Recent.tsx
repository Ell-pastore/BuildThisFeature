import FileIcon from "../FileIcon";
import type { FileItem } from "../../types";
import { Clock } from "../../components/Icons";

interface RecentProps {
  onOpenFile: (file: FileItem) => void;
  /** Real files provided by the app (loaded directory contents). */
  recentFiles?: FileItem[];
}

/**
 * Recent files. Presentational only — data comes from the app. Real,
 * persisted "recently accessed" tracking is not implemented yet, so we show
 * the caller-provided items (currently the loaded directory).
 */
export default function Recent({ onOpenFile, recentFiles = [] }: RecentProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-8">
        <div>
          <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Recent</h1>
          <p className="text-sm text-muted-foreground mt-1">Files you've opened, modified, or created recently.</p>
        </div>

        {recentFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mb-4">
              <Clock size={22} className="text-muted-foreground" />
            </div>
            <div className="text-sm font-medium text-foreground">No recent files yet</div>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Recently accessed file tracking isn't implemented yet. Items from your real filesystem will appear here.
            </p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl divide-y divide-border overflow-hidden">
            {recentFiles.map((file) => (
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
                <div className="flex items-center gap-4 flex-shrink-0">
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-zinc-100 text-zinc-500">
                    {file.isFolder ? "Folder" : file.type.toUpperCase()}
                  </span>
                  <span className="text-xs font-mono text-muted-foreground">{file.isFolder ? "—" : file.size}</span>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock size={11} />
                    <span>{file.modified}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
