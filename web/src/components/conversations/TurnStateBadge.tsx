import type { AiTurnState } from "../../types/ai";

const STYLES: Record<AiTurnState, string> = {
  "awaiting-approval": "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-rose-100 text-rose-800",
  expired: "bg-neutral-200 text-neutral-600",
  failed: "bg-rose-100 text-rose-800",
  completed: "bg-emerald-100 text-emerald-800",
};

const LABELS: Record<AiTurnState, string> = {
  "awaiting-approval": "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  failed: "Failed",
  completed: "Completed",
};

/** Small pill marking a conversation's server-derived turn state. */
export default function TurnStateBadge({ state }: { state: AiTurnState }) {
  return (
    <span
      data-testid={`turn-state-${state}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ${STYLES[state]}`}
    >
      {LABELS[state]}
    </span>
  );
}