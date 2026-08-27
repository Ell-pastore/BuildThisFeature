import { Star } from "../../components/Icons";
import { sampleFiles } from "../../data/files";
import FileIcon from "../FileIcon";
import type { FileItem } from "../../data/files";

interface StarredProps {
  onOpenFile: (file: FileItem) => void;
}

export default function Starred({ onOpenFile }: StarredProps) {
  const starred = sampleFiles.filter((f) => f.starred);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Starred</h1>
          <p className="text-sm text-muted-foreground mt-1">Files and folders you've marked as important.</p>
        </div>

        {starred.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 rounded-2xl bg-amber-50 flex items-center justify-center mb-4">
              <Star size={22} className="text-amber-400" />
            </div>
            <div className="text-sm font-medium text-foreground">No starred files yet</div>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Star files and folders to quickly find them here.
            </p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl divide-y divide-border overflow-hidden">
            {starred.map((file) => (
              <button
                key={file.id}
                onClick={() => onOpenFile(file)}
                className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-secondary transition-colors text-left"
              >
                <FileIcon type={file.type} size="sm" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-mono font-medium text-foreground truncate">{file.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{file.location}</div>
                </div>
                <div className="flex items-center gap-4 flex-shrink-0">
                  <span className="text-xs font-mono text-muted-foreground">{file.size}</span>
                  <span className="text-xs font-mono text-muted-foreground">{file.modified}</span>
                  <Star size={14} className="text-amber-400 fill-amber-400" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
