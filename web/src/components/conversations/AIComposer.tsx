import { useState, type FormEvent } from "react";
import { Send } from "../Icons";

interface AIComposerProps {
  /** Disables input + submission (e.g. while a turn is in flight). */
  disabled: boolean;
  /** True while an instruction turn is being processed. */
  submitting: boolean;
  /** Submission error message to surface above the input, or null. */
  error: string | null;
  /**
   * Submit one instruction; resolves `true` when the turn was accepted so the
   * composer can clear its input, `false` when it failed (input is kept for
   * retry).
   */
  onSubmit: (instruction: string) => Promise<boolean>;
}

/**
 * Composer for the desktop AI assistant (Phase 10.33): a single-line input and
 * a send control backed by the real `POST /api/ai/instructions` endpoint.
 *
 * It only produces an `{ instruction }` (the parent decides whether to attach
 * a `conversationId`); it never renders or holds a token, never executes a
 * tool, and never infers approvals. Submission state and errors are reflected
 * inline so the user always knows whether their instruction was accepted.
 */
export default function AIComposer({ disabled, submitting, error, onSubmit }: AIComposerProps) {
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const canSubmit = !disabled && !submitting && trimmed.length > 0;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    const accepted = await onSubmit(trimmed);
    if (accepted) setText("");
  }

  return (
    <div className="border-t border-border px-4 py-3">
      {error !== null && (
        <p role="alert" className="mb-2 text-xs text-rose-500">
          {error}
        </p>
      )}
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask the assistant to work on your files…"
          aria-label="Give the assistant an instruction"
          maxLength={4096}
          disabled={disabled || submitting}
          className="flex-1 rounded-lg border border-border bg-secondary px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-accent transition-colors disabled:opacity-50 min-w-0"
        />
        <button
          type="submit"
          disabled={!canSubmit}
          aria-label="Send instruction"
          className="w-10 h-10 flex items-center justify-center rounded-lg bg-accent text-white hover:bg-indigo-600 transition-colors disabled:opacity-40 flex-shrink-0"
        >
          {submitting ? (
            <span
              aria-hidden="true"
              className="block w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin"
            />
          ) : (
            <Send size={16} />
          )}
        </button>
      </form>
      {submitting && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          The assistant is working on your instruction…
        </p>
      )}
    </div>
  );
}