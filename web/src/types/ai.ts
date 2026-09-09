/**
 * Frontend types mirroring the backend's authenticated AI API (`POST
 * /api/ai/instructions`, `GET /api/ai/conversations`, and `GET
 * /api/ai/conversations/:id`).
 *
 * These are faithful mirrors of PERSISTED data returned by the backend. The
 * frontend never fabricates any of these values and never infers permission or
 * approval authority — the backend stays the sole source of truth for
 * ownership, turn state, and what is decidable.
 */

/**
 * Turn-state of a conversation's last turn, derived server-side:
 * `awaiting-approval`, `approved`, `rejected`, `expired`, `failed`, or
 * `completed`.
 */
export type AiTurnState =
  | "completed"
  | "awaiting-approval"
  | "approved"
  | "rejected"
  | "expired"
  | "failed";

/**
 * Safe projection of one persisted tool approval. `arguments` are the
 * approved/validated identifying references only — never raw file contents or
 * secrets.
 */
export interface AiToolApproval {
  id: string;
  conversationId: string;
  messageId: string;
  toolName: string;
  arguments: Readonly<Record<string, unknown>>;
  status: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

/** A persisted tool-call intent for one provider round. */
export interface AiHistoryToolCall {
  callId: string;
  toolName: string;
  input: unknown;
}

/** Safe projection of one persisted tool result (contents stripped). */
export type AiHistoryToolResult =
  | { ok: true; callId: string; data?: unknown }
  | { ok: false; callId: string; error: { code: string; category: string } };

/** One persisted transcript message, in chronological order. */
export interface AiHistoryMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  isFinal: boolean;
  toolCalls?: readonly AiHistoryToolCall[];
  toolResults?: readonly AiHistoryToolResult[];
}

/** Metadata core shared by the summary and detail shapes. */
export interface AiConversationSummaryBase {
  id: string;
  title: string | null;
  maxToolRounds: number;
  createdAt: string;
  updatedAt: string;
}

/** One owned conversation summary, newest-first, with its derived turn state. */
export interface AiConversationSummary extends AiConversationSummaryBase {
  turnState: AiTurnState;
  /** Approvals still awaiting a decision (`pending`, unexpired), oldest-first. */
  pendingApprovals: readonly AiToolApproval[];
}

/** One owned conversation with its persisted transcript and turn state. */
export interface AiConversationDetail extends AiConversationSummaryBase {
  turnState: AiTurnState;
  pendingApprovals: readonly AiToolApproval[];
  messages: readonly AiHistoryMessage[];
}

// ---------------------------------------------------------------------------
// Instruction submission (POST /api/ai/instructions)
// ---------------------------------------------------------------------------

/** Safe per-intent outcome synopsis echoed by one instruction turn. */
export interface AiToolOutcome {
  callId: string;
  ok: boolean;
}

/**
 * Safe pending-approval metadata echoed by one instruction turn: the persisted
 * approval id, the tool name, the validated arguments, and the expiry. No raw
 * file contents or secrets.
 */
export interface AiInstructionApprovalInfo {
  approvalId: string;
  toolName: string;
  arguments: unknown;
  expiresAt: string;
}

/**
 * One transcript message echoed by `POST /api/ai/instructions`. This is the
 * runtime's `AgentMessage` model (`kind`/`text`/`toolCalls`) — NOT the safe
 * history projection. The desktop client never renders this directly; it
 * reconciles from the safe `getAiConversation` history detail instead.
 */
export type AiInstructionMessage =
  | {
      kind: "provider";
      text?: string;
      toolCalls?: readonly { id: string; toolName: string; input: unknown }[];
    }
  | { kind: "final"; text: string };

/** Safe per-turn result of `POST /api/ai/instructions`. */
export interface AiInstructionTurn {
  /** True when a new conversation was created for this turn. */
  created: boolean;
  /** The validated participant-visible instruction. */
  instruction: string;
  /** The persisted transcript (`AgentMessage` model, unprojected). */
  messages: readonly AiInstructionMessage[];
  /** The agent's final reply once the turn completed. */
  finalText?: string;
  toolRounds: number;
  maxToolRounds: number;
  toolResults: readonly AiToolOutcome[];
  pendingApprovals: readonly AiInstructionApprovalInfo[];
}

/** Stable response of `POST /api/ai/instructions`. */
export interface AiInstructionResponse {
  /** The conversation id (existing or newly created). */
  conversationId: string;
  /** The safe, persisted turn result. */
  turn: AiInstructionTurn;
}