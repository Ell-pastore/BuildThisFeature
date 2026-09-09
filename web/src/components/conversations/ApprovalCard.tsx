import { Clock, Shield } from "../Icons";
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

/**
 * Read-only projection of a still-decidable tool approval (Phase 10.32).
 * Renders ONLY the safe metadata the backend returned (tool name, validated
 * arguments, status, expiry). It deliberately renders NO approve/reject
 * actions — approval decisions are out of scope for this foundation phase and
 * the frontend never executes tools.
 */
export default function ApprovalCard({ approval }: { approval: AiToolApproval }) {
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
          <p className="text-[11px] text-muted-foreground">Pending approval</p>
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
      <p className="mt-2.5 text-[11px] text-muted-foreground">
        Read-only: approval actions are not available in this view yet.
      </p>
    </div>
  );
}