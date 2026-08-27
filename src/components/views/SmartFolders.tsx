import { Sparkles, Plus } from "../../components/Icons";
import { smartFolders } from "../../data/files";

export default function SmartFolders() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Sparkles size={16} className="text-accent" />
              <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Smart Folders</h1>
            </div>
            <p className="text-sm text-muted-foreground">Dynamic folders that automatically update based on rules or AI understanding.</p>
          </div>
          <button className="flex items-center gap-1.5 px-3 py-1.5 bg-foreground text-primary-foreground rounded-lg text-xs font-medium hover:opacity-90 transition-opacity">
            <Plus size={13} />
            New smart folder
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {smartFolders.map((folder) => (
            <button
              key={folder.id}
              className="bg-card border border-border rounded-xl p-5 text-left hover:border-accent/40 hover:shadow-sm transition-all group"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="text-2xl">{folder.icon}</div>
                <div className="text-xs font-mono text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                  {folder.count} files
                </div>
              </div>
              <div className="text-sm font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>
                {folder.name}
              </div>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{folder.description}</p>
              <div className="mt-3 pt-3 border-t border-border">
                <div className="flex items-center gap-1.5">
                  <Sparkles size={10} className="text-accent" />
                  <span className="text-[10px] text-muted-foreground truncate">{folder.rule}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
