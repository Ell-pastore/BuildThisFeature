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
 * `awaiting-approval`, `awaiting-host-execution`, `approved`, `rejected`,
 * `expired`, `failed`, or `completed`.
 */
export type AiTurnState =
  | "completed"
  | "awaiting-approval"
  | "awaiting-host-execution"
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

/** Safe projection of one persisted host execution (Phase 10.39). `arguments`
 * are the validated identifying references only — never raw file contents or
 * secrets. `executedAt` is null until the desktop host submits its result.
 */
export interface AiHostExecution {
  id: string;
  conversationId: string;
  messageId: string;
  toolName: string;
  callId: string;
  arguments: Readonly<Record<string, unknown>>;
  round: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  executedAt: string | null;
}

/**
 * The turn-echo of ONE pending host execution (`POST /api/ai/instructions`
 * paused response, Phase 10.39). Mirrors the backend's
 * `HostExecutionRequestInfo` — deliberately narrower than `AiHostExecution`
 * (no `id`/`callId`/`status`): the desktop host needs only the execution id
 * to submit against, the tool to execute, and the validated arguments.
 */
export interface AiInstructionHostExecution {
  /** The persisted pending host-execution id (submission key). */
  executionId: string;
  /** The registered tool the host execution was created for. */
  toolName: string;
  /** The schema-validated arguments stored for the host. */
  arguments: unknown;
  /** When the host-execution window closes. */
  expiresAt: string;
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
  /**
   * Host executions still awaiting the desktop host to submit a result
   * (`pending`, unexpired), oldest-first. Safe identification metadata only.
   */
  pendingHostExecutions: readonly AiHostExecution[];
}

/** One owned conversation with its persisted transcript and turn state. */
export interface AiConversationDetail extends AiConversationSummaryBase {
  turnState: AiTurnState;
  pendingApprovals: readonly AiToolApproval[];
  pendingHostExecutions: readonly AiHostExecution[];
  messages: readonly AiHistoryMessage[];
}

// ---------------------------------------------------------------------------
// Runtime status (GET /api/ai/status)
// ---------------------------------------------------------------------------

/** One safe, non-secret configuration/validation reason category. */
export interface AiProviderIssue {
  code: string;
  message: string;
}

/** Safe per-provider capability status exposed to an authenticated client. */
export interface AiProviderStatus {
  /** Provider id, e.g. "grok", "gemini", "openrouter", "ollama". */
  provider: string;
  /** Zero-based position in the configured fallback chain. */
  order: number;
  /** Fully valid + constructible (NOT a proof of reachability). */
  enabled: boolean;
  /** Per-provider validation outcome. */
  validationStatus: "valid" | "disabled";
  /** Configured model, when present and safe to report. */
  model?: string;
  /** Number of configured credentials — never the values or handles. */
  credentialCount: number;
  /** True for credential-free providers (e.g. local Ollama). */
  credentialFree: boolean;
  /** Safe reason categories when the provider is disabled/invalid. */
  issues: readonly AiProviderIssue[];
}

/** Stable, explicitly typed response of `GET /api/ai/status`. */
export interface AiRuntimeStatus {
  /** The status service itself computed successfully ("ok"). */
  status: "ok";
  /**
   * Whether at least one provider is fully configured and constructible.
   * Safe to drive "AI isn't configured yet" UX on.
   */
  configured: boolean;
  /** Provider capability status, in configured fallback order. */
  providers: readonly AiProviderStatus[];
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
  /**
   * Host executions the desktop host is still expected to run locally
   * (Phase 10.39). Non-empty means the turn is PAUSED at a filesystem
   * operation: the desktop client must execute each request, then resume the
   * turn with `resumeExecutions`.
   */
  pendingExecutions: readonly AiInstructionHostExecution[];
}

/**
 * One strict host-execution submission for `resumeExecutions` (Phase 10.39):
 * the desktop host's own result for the matched pending execution. `result`
 * is transient provider context (never persisted); `error` carries a
 * categorized tool error and is mutually exclusive with `result`.
 */
export interface AiHostExecutionSubmission {
  /** The matched pending execution's id (its echo's `executionId`). */
  executionId: string;
  /** Whether the host's execution succeeded. */
  ok: boolean;
  /** The host's execution payload when it succeeded. */
  result?: unknown;
  /** The categorized tool error when the host's execution failed. */
  error?: { code: string; category: string };
}

/** Stable response of `POST /api/ai/instructions`. */
export interface AiInstructionResponse {
  /** The conversation id (existing or newly created). */
  conversationId: string;
  /** The safe, persisted turn result. */
  turn: AiInstructionTurn;
}