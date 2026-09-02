import { Sparkles, Plus } from "../../components/Icons";

/**
 * Smart Folders. AI/rule-based dynamic folders aren't implemented yet, so this
 * shows a clear placeholder rather than fabricated folders.
 */
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

        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-14 h-14 rounded-2xl bg-ai-bg flex items-center justify-center mb-4">
            <Sparkles size={22} className="text-ai-text" />
          </div>
          <div className="text-sm font-medium text-foreground">No smart folders yet</div>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Smart folders require rule or AI-based analysis that isn't implemented
            yet. Real folders you create with the New button appear in the Files view.
          </p>
        </div>
      </div>
    </div>
  );
}