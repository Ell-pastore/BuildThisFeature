import { Sparkles } from "../../components/Icons";

/**
 * AI Organization. The AI backend is not implemented yet, so this shows a
 * clear placeholder rather than presenting fabricated suggestions.
 */
export default function AIOrganization() {
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

        {/* Placeholder */}
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-14 h-14 rounded-2xl bg-ai-bg flex items-center justify-center mb-4">
            <Sparkles size={22} className="text-ai-text" />
          </div>
          <div className="text-sm font-medium text-foreground">AI organization is not available yet</div>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            This feature requires an AI analysis backend. In the meantime you can
            browse, open, star, rename, move, and delete files from the Files view.
          </p>
        </div>
      </div>
    </div>
  );
}