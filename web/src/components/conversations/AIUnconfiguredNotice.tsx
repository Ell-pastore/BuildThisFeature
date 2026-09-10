import { AlertTriangle } from "../Icons";

interface AIUnconfiguredNoticeProps {
  /** Re-check configuration (and, when a retry instruction exists, re-run it). */
  onRetry: () => void;
}

/**
 * Clear "AI isn't configured yet" state (Phase M1). Shown in place of the
 * composer when the backend reports `GET /api/ai/status` with no configured
 * provider, or when an instruction failed with the stable 503
 * `common/not-configured` error. Replaces a raw error string with actionable,
 * friendly copy plus a retry control.
 */
export default function AIUnconfiguredNotice({ onRetry }: AIUnconfiguredNoticeProps) {
  return (
    <div
      data-testid="ai-unconfigured-notice"
      className="border-t border-border px-4 py-3 flex items-start gap-3"
    >
      <div className="w-7 h-7 rounded-lg bg-ai-bg flex items-center justify-center flex-shrink-0 mt-0.5">
        <AlertTriangle size={14} className="text-ai-text" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">AI isn't configured yet</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          No AI provider is configured on the backend, so the assistant can't work on your files
          yet. Add a provider key (Grok, Gemini, OpenRouter, or a local Ollama), then try again.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:bg-indigo-600 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}