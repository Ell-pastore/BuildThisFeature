import { useState } from "react";
import { Check, Clock, Shield, X } from "../Icons";
import {
  approveAiApproval,
  rejectAiApproval,
  RESUME_AFTER_APPROVAL_INSTRUCTION,
} from "../../services/api/aiApprovals";
import { submitAiInstruction } from "../../services/api/aiInstructions";
import type { AiToolApproval } from "../../types/ai";

function formatArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

interface ApprovalCardProps {
  /** The server-provided approval projection. */
  approval: AiToolApproval;
  /**
   * Reconcile the owning conversation from the server (reload list + detail)
   * AFTER a decision has been submitted, so the rendered messages, turn state,
   * and remaining approvals are always the backend's persisted values.
   */
  onReconcile: (conversationId: string) => Promise<void>;
}

/**
 * Actionable projection of a pending tool approval (Phase 10.34).
 *
 * When the backend reports the approval as `pending` (the ONLY authoritative
 * "still decidable" signal), the card exposes Approve / Reject controls. The
 * frontend never executes the tool:
 *
 *   - Approve posts the decision to the EXISTING approval endpoint, then
 *     resumes the interrupted turn through the EXISTING instruction endpoint
 *     (`approvalId` + the Phase 10.30 resume instruction); the runtime executes
 *     the approval's exact stored arguments and may ask for a fresh approval.
 *   - Reject posts the decision; nothing resumes.
 *
 * Both paths end in a server reconciliation — the new assistant reply (if any)
 * and the derived turn state are always RENDERED from the authoritative
 * conversation projection, never from the decision responses. Expiry is never
 * guessed client-side: an expired/stale approval surfaces the backend's own
 * 400 response and the reconciled server state.
 */
export default function ApprovalCard({ approval, onReconcile }: ApprovalCardProps) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "approve" | "reject") {
    if (busy !== null) return;
    setBusy(action);
    setError(null);
    try {
      if (action === "approve") {
        await approveAiApproval(approval.id);
        // Resume the approved operation via the existing agent flow. React only
        // submits the instruction; the backend (never this app) executes tools.
        await submitAiInstruction({
          approvalId: approval.id,
          instruction: RESUME_AFTER_APPROVAL_INSTRUCTION,
        });
      } else {
        await rejectAiApproval(approval.id);
      }
      await onReconcile(approval.conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete the approval decision.");
      // The backend still owns the outcome (e.g. an approval that just elapsed
      // returns 400 "expired"). Reconcile so the derived turn state renders.
      try {
        await onReconcile(approval.conversationId);
      } catch {
        // Best effort — never mask the decision error with a refresh failure.
      }
    } finally {
      setBusy(null);
    }
  }

  const isActionable = approval.status === "pending";
  const entries = Object.entries(approval.arguments);

  return (
    <div
      data-testid="pending-approval"
      className="mt-3 rounded-xl border border-border bg-card p-3"
    >
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-md bg-ai-bg flex items-center justify-center flex-shrink-0">
          <Shield size={12} className="text-ai-text" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{approval.toolName}</p>
          <p className="text-[11px] text-muted-foreground">
            {isActionable ? "Pending approval" : `Status: ${approval.status}`}
          </p>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground flex-shrink-0">
          <Clock size={11} />
          <span>Expires {formatExpiry(approval.expiresAt)}</span>
        </div>
      </div>
      {entries.length > 0 && (
        <dl className="mt-2.5 space-y-1">
          {entries.map(([key, value]) => (
            <div key={key} className="flex gap-2 text-xs">
              <dt className="text-muted-foreground w-28 shrink-0 truncate">{key}</dt>
              <dd className="text-foreground font-mono break-all">{formatArgument(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {isActionable && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void run("approve")}
            disabled={busy !== null}
            aria-label="Approve"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy === "approve" ? <Spinner /> : <Check size={13} />}
            Approve
          </button>
          <button
            type="button"
            onClick={() => void run("reject")}
            disabled={busy !== null}
            aria-label="Reject"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy === "reject" ? <Spinner /> : <X size={13} />}
            Reject
          </button>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="mt-2.5 text-xs text-rose-500">
          {error}
        </p>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
    />
  );
}