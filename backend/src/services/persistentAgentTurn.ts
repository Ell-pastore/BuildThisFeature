/**
 * Persistent agent turn orchestration (Phase 10.8).
 *
 * The smallest service that connects the Phase 10.3–10.7 agent layers into
 * one durable, authenticated turn:
 *
 *   1. AUTH + CONTEXT (Phase 10.5): `buildAgentContext` pre-flights the
 *      authenticated user (fail closed — no provider call without a valid
 *      session) and filters the offered tool metadata down to registered
 *      tools. The authenticated user id is the ownership key for everything
 *      the repository writes or reads.
 *   2. LOAD OR CREATE (Phase 10.7): an existing conversation is loaded with
 *      ownership enforced (a foreign/missing conversation is rejected), and
 *      its persisted round bound becomes this turn's bound; otherwise a new
 *      conversation is prepared for creation.
 *   3. LOOP (Phase 10.4): the existing bounded tool loop runs against the
 *      provider with the registered tool metadata. An `onRound` observer
 *      (additive, added in 10.8) records each executed round's transcript in
 *      memory, and a `prepareRound` hook (added in 10.28C-prep) EAGERLY
 *      persists — BEFORE each round's intents execute — the conversation
 *      (first round) and the round's assistant/tool-call message, so a REAL
 *      persisted `messageId` exists for every tool execution. That context is
 *      threaded through `routeAgentResponse` → `invokeTool` and bound to each
 *      tool's `ToolExecutionContext` (the Phase 10.28 approval boundary).
 *   4. STATE (Phase 10.6): the transcript is replayed through the immutable
 *      `ConversationState` transitions — the same validators persistence
 *      uses — to produce the updated state (and to reject malformed rounds
 *      before the final write).
 *   5. PERSIST (Phase 10.7 repository): a tool round's eager rows are the
 *      REAL committed transcript; on success `completeAgentTurn` attaches the
 *      results + final reply in ONE transaction. Text-only turns (no tools)
 *      keep the original all-or-nothing `persistAgentTurn` write. If the turn
 *      fails AFTER eager persistence, `cancelAgentTurn` compensates so NO
 *      partial turn state remains: a new conversation is deleted (cascade),
 *      a resumed conversation loses exactly this turn's messages.
 *
 * Phase 10.20 — COMPOSED STACK INTEGRATION: production turns obtain the
 * provider through the composed provider stack (`ComposedProviderStack` from
 * the composition root), NOT by constructing/selecting a single provider.
 * The stack is injected once (created at startup via
 * `composeDefaultProviderStack()`) and its `provider` facade — the fallback
 * layer that owns credential rotation and health/cooldown — runs EVERY round
 * of the turn. Fallback, rotation, and cooldown are therefore REAL for
 * production turns yet fully transparent to the Agent: it still receives
 * only plain `AgentResponse` values, never provider ids, credentials,
 * fallback state, or cooldown state.
 *
 * Phase 10.30 — APPROVAL RESUME: `resumeApprovalId` continues an interrupted
 * turn after a tool approval decision. The approved approval is resolved with
 * ownership enforced, asserted executable, executed ONCE through the existing
 * `invokeTool` gate → policy → handler → executor pipeline (only the EXACT
 * stored arguments run), consumed so it can never be replayed, and recorded
 * as this turn's first (pre-run) tool round. The bounded loop then continues
 * from round one against the approval's own conversation with the executed
 * result as seeded context — bounded by the conversation's persisted
 * `maxToolRounds`, never beyond it. Rejected, expired, foreign, or
 * already-consumed approvals are rejected before anything runs, and the tool
 * round's result is persisted through the same eager transcript +
 * `completeAgentTurn` path as every other round.
 *
 * Design rules:
 *
 *   - OWNERSHIP EVERYWHERE: load, eager-write, complete, and cancel are keyed
 *     by the authenticated user derived from the session, never from
 *     provider/request data. A foreign conversation looks identical to a
 *     missing one.
 *   - NO DUPLICATED LOOP: this service does not re-implement the bounded loop;
 *     it observes it, persists what it records, and threads persisted
 *     turn context through the loop's existing invocation path.
 *   - NO POLICY BYPASS: tool execution stays in the Phase 10.2/9.8
 *     `invokeTool()` pipeline on every round; the only new data is the
 *     persisted `conversationId`/`messageId` bound to the execution context.
 *   - CONSISTENCY: eager rows are committed ONLY for tool rounds that will
 *     actually execute; a failure afterwards compensates via `cancelAgentTurn`
 *     so a failed turn leaves no partial state (a hard process crash in that
 *     window can leave a valid-but-incomplete transcript — never corrupt —
 *     which the load/reconstruct path handles and a later turn appends to).
 *   - NO I/O OUTSIDE THE REPOSITORY: the service performs no direct Prisma
 *     access; it goes through the Phase 10.7 repository functions.
 */
import { AppError } from "../core/errors.js";
import type { AgentHistoryMessage, AgentProvider } from "./provider.js";
import type { ToolDefinition } from "../tools/types.js";
import { ToolError, type ToolErrorCategory } from "../tools/errors.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import {
  HOST_EXECUTION_WINDOW_MS,
  invokeTool,
  type HostExecutionRequestInfo,
  type InvokeToolOptions,
  type ToolApprovalRequestInfo,
} from "./tools.js";
import type { AgentToolCall, AgentToolResult } from "./agent.js";
import type { RawToolInput } from "../tools/handlers/handler.js";
import {
  ToolApprovalNotFoundError,
  assertToolApprovalExecutable,
  consumeToolApproval,
  getToolApproval,
  type ToolApprovalRecord,
} from "./aiToolApprovals.js";
import {
  HOST_DELEGATED_APPROVED_WRITE_TOOLS,
  HostExecutionDuplicateError,
  HostExecutionNotFoundError,
  assertHostExecutionExecutable,
  createAiHostExecution,
  getAiHostExecution,
  getPendingHostExecutionByApproval,
  submitHostExecution,
  type HostExecutionRecord,
} from "./aiHostExecutions.js";
import { buildAgentContext } from "./agentContext.js";
import { runAgentLoop, type AgentLoopRound } from "./agentLoop.js";
import type { ComposedProviderStack } from "./providerComposition.js";
import {
  createConversationState,
  finalizeConversation,
  recordProviderTurn,
  recordToolResults,
  type ConversationState,
} from "./conversation.js";
import {
  AgentConversationNotFoundError,
  appendAgentTurnRoundMessage,
  attachAgentMessageToolResult,
  beginAgentTurn,
  cancelAgentTurn,
  completeAgentTurn,
  loadAgentConversationMessages,
  loadAgentConversationState,
  persistAgentTurn,
  type AgentTurnRecord,
  type StoredMessage,
} from "../database/repositories/agentConversations.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One host submission on a paused turn's resume (Phase 10.39). The desktop
 * host executed a pending host-execution LOCALLY and reports the outcome so
 * the backend can seal the record and seed the resumed turn's provider
 * context. The `result` is transient — it is passed straight to the provider
 * as seeded tool context and is NEVER persisted.
 */
export interface HostExecutionSubmission {
  /** The user-owned, pending host-execution that was executed. */
  executionId: string;
  /** Whether the desktop host's execution succeeded. */
  ok: boolean;
  /** The host's execution payload when it succeeded. Persisted as the
   *  deferred round's tool result on resume. */
  result?: unknown;
  /** The categorized tool error when the host execution failed. */
  error?: { code: string; category: string };
}

export interface PersistentTurnInput {
  /** Resume this conversation (ownership enforced). Omit to create a new one. */
  conversationId?: string;
  /** The user's instruction for this turn. */
  instruction: string;
  /** Optional display title for newly created conversations. */
  title?: string;
  /**
   * Resume mode (Phase 10.30): the id of an OWNED, `approved` tool approval to
   * execute. The turn executes ONLY the approval's exact stored arguments
   * through the existing gate → policy → handler → executor pipeline, records
   * the result as this turn's first round, consumes the approval so it can
   * never be replayed, then continues the bounded loop against the approval's
   * OWN conversation (the conversation's persisted round bound applies). A
   * supplied `conversationId` must match the approval's conversation.
   */
  resumeApprovalId?: string;
  /**
   * Resume mode (Phase 10.39): submissions for the pending host executions a
   * PAUSED turn produced. Each owned record is asserted executable and SEALED
   * (`executed`, single-use) so it can never be submitted again, then this
   * turn resumes the bounded loop against the executions' OWN conversation
   * with each submission seeded as an already-executed tool round
   * (`initialToolRounds` = the highest recorded round, bound from the
   * conversation's persisted `maxToolRounds`). All submissions must share one
   * conversation, matching an optional supplied `conversationId`. Each
   * submission's result is persisted onto its deferred round's transcript
   * message BEFORE the record seals, and seeded into the loop as
   * already-executed context.
   */
  resumeHostExecutions?: readonly HostExecutionSubmission[];
}

export interface PersistentTurnOptions extends InvokeToolOptions {
  /**
   * The composed provider stack whose `provider` facade drives the turn
   * (Phase 10.20 preferred integration). Every round runs through the stack's
   * fallback layer — credential rotation and health/cooldown included — all
   * transparent to the Agent. Mutually exclusive with `provider`.
   */
  stack?: ComposedProviderStack;
  /**
   * A ready `AgentProvider` facade (retained for back-compat / direct tests).
   * Mutually exclusive with `stack`; exactly one of the two is required.
   */
  provider?: AgentProvider;
  /** Candidate tool metadata; filtered to registered tools before use. */
  tools: readonly ToolDefinition[];
  /** Loop bound used when creating a new conversation. Default 1. */
  maxToolRounds?: number;
  /**
   * Per-request filesystem executor resolution (Phase 10.39). When set, it is
   * consulted for EACH turn with the authenticated request context (which
   * carries the `desktopHost` header flag) and its return value — when not
   * `undefined` — REPLACES the base `filesystem` for that turn. The
   * production resolver returns `hostDelegatedFilesystemExecutor()` exactly
   * when the request came from the desktop host, and `undefined` otherwise so
   * the fail-closed Tauri bridge stays in effect. Absent for non-production
   * callers — behavior is unchanged.
   */
  resolveFilesystem?: (
    c: { get: (key: string) => unknown },
  ) => FilesystemExecutor | undefined;
  /**
   * Per-request tool-round bound resolution (Phase 10.40). When set, it is
   * consulted for EACH turn with the authenticated request context (which
   * carries the `aiQuality` header tier) and its return value — when not
   * `undefined` — REPLACES `maxToolRounds` for that turn, BEFORE the
   * `bound ?? options.maxToolRounds ?? 1` precedence in `runPersistentTurn`.
   * A returned bound therefore applies only to NEW conversations: a resumed
   * conversation still keeps its persisted bound. The production resolver
   * maps the request's AI Quality tier (Low 3 / Medium 5 / High 8) and
   * returns `undefined` on absent/invalid values so the default bound stays
   * in effect. Absent for non-production callers — behavior is unchanged.
   */
  resolveMaxToolRounds?: (
    c: { get: (key: string) => unknown },
  ) => number | undefined;
}

export interface PersistentTurnResult {
  /** The conversation id (existing or newly created). */
  conversationId: string;
  /** True when a new conversation was created for this turn. */
  created: boolean;
  /** The updated, fully persisted conversation state (Phase 10.6). */
  state: ConversationState;
  /**
   * Pending approval metadata collected during this turn (Phase 10.29).
   * Empty when no tools required approval. Safe metadata only: approval id,
   * tool name, validated arguments, and expiry — no raw file contents or
   * provider output.
   */
  pendingApprovals: readonly ToolApprovalRequestInfo[];
  /**
   * Pending host-execution metadata collected from a PAUSED round
   * (Phase 10.39). Empty unless the loop stopped WITHOUT executing its
   * intents: the turn's eager rows persist by design, the state below is the
   * partial (unfinalized) conversation, and the caller must resume after the
   * desktop host submits each execution. Never populated on a completed turn.
   */
  pendingExecutions: readonly HostExecutionRequestInfo[];
}

/**
 * Resolve the turn's provider facade. Exactly one of `stack` (preferred,
 * Phase 10.20) or `provider` must be supplied — the composed stack's
 * `provider` is the fallback facade that owns rotation + health/cooldown.
 *
 * @throws `TypeError` when neither or both sources are supplied.
 */
function resolveTurnProvider(options: PersistentTurnOptions): AgentProvider {
  const hasStack = options.stack !== undefined;
  const hasProvider = options.provider !== undefined;
  if (hasStack === hasProvider) {
    throw new TypeError(
      "runPersistentTurn requires exactly one provider source: `stack` " +
        "(composed provider stack) or `provider` (AgentProvider).",
    );
  }
  const provider = options.stack?.provider ?? options.provider;
  if (provider === undefined) {
    throw new TypeError("runPersistentTurn has no usable provider facade.");
  }
  return provider;
}

/** Map a loop-observed round into the repository's persist shape. */
function toTurnRecord(round: AgentLoopRound): AgentTurnRecord {
  return {
    ...(round.text !== undefined ? { text: round.text } : {}),
    toolCalls: round.toolCalls,
    toolResults: round.results,
  };
}

/**
 * Reconstruct the provider-visible prior-conversation transcript from the
 * RAW persisted rows, in stored order: a user instruction, an assistant tool
 * round (text, tool calls, and the round's results), and an assistant final
 * reply. System rows are non-transcript noise and are skipped. Returns an
 * empty array when the conversation has no prior content.
 */
function toAgentHistory(messages: readonly StoredMessage[]): readonly AgentHistoryMessage[] {
  const history: AgentHistoryMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      history.push({ role: "user", text: message.content });
      continue;
    }
    if (message.role !== "assistant") continue;
    if (message.isFinal) {
      history.push({ role: "assistant", text: message.content });
      continue;
    }
    history.push({
      role: "assistant",
      ...(message.content.length > 0 ? { text: message.content } : {}),
      ...(message.toolCalls !== undefined
        ? { toolCalls: message.toolCalls as readonly AgentToolCall[] }
        : {}),
      ...(message.toolResults !== undefined
        ? { toolResults: message.toolResults as readonly AgentToolResult[] }
        : {}),
    });
  }
  return history;
}

/**
 * Load a user-owned conversation's raw transcript and shape it into prior
 * model history. Returns `undefined` when the conversation is missing, has
 * no prior messages, or the loader is unavailable — callers treat that as
 * no history (fresh-turn behavior), never as an error.
 */
async function loadConversationHistory(
  userId: string,
  conversationId: string,
): Promise<readonly AgentHistoryMessage[] | undefined> {
  const stored = await loadAgentConversationMessages(userId, conversationId);
  if (stored === null || stored === undefined || stored.length === 0) return undefined;
  return toAgentHistory(stored);
}

/** The narrow pending-execution view a paused turn exposes to the caller (§6.9). */
function toHostExecutionRequestInfo(record: HostExecutionRecord): HostExecutionRequestInfo {
  return {
    executionId: record.id,
    toolName: record.toolName,
    arguments: record.arguments,
    expiresAt: record.expiresAt,
  };
}

/** A validated, sealed host-execution resume, ready to seed a loop. */
interface ResolvedHostResume {
  /** The ONE conversation all submitted executions belong to. */
  conversationId: string;
  /** Seeded per-submission tool results (loop context for the resumed turn). */
  seeds: readonly AgentToolResult[];
  /** The highest recorded round across the submitted executions. */
  initialRounds: number;
}

/**
 * Phase 10.39 resume: persist each submitted host-execution result into its
 * deferred round's transcript row, then validate + SEAL each submission
 * exactly once (a sealed record can never be replayed), then shape the seeds
 * for the resumed loop. Persistence happens FIRST — before the single-use
 * seal — so a DB failure here leaves every record unsealed and the resume
 * safely retryable. The shapes are the same per-submission `AgentToolResult`s
 * the resumed loop consumes, so the deferred round's persisted message gains
 * the ACTUAL completed tool result and a later turn's history reconstructs it
 * (instead of the bare tool-call intent).
 */
async function resolveHostExecutionsResume(
  userId: string,
  submissions: readonly HostExecutionSubmission[],
  now: Date,
): Promise<ResolvedHostResume> {
  // Phase 1 — resolve + assert EVERY submission without touching anything:
  // a failure (foreign/missing, already sealed, expired) leaves every record
  // untouched. Ownership is enforced by `getAiHostExecution`.
  const resolved: { record: HostExecutionRecord; submission: HostExecutionSubmission }[] = [];
  for (const submission of submissions) {
    const record = await getAiHostExecution(userId, submission.executionId);
    if (record === null) {
      throw new HostExecutionNotFoundError();
    }
    assertHostExecutionExecutable(record, now);
    resolved.push({ record, submission });
  }
  const conversations = new Set(resolved.map((s) => s.record.conversationId));
  if (conversations.size > 1) {
    throw AppError.badRequest("The submitted host executions span multiple conversations.");
  }
  const conversationId = resolved[0]?.record.conversationId ?? "";
  // Phase 1.5 — shape each submission into its tool result and persist it onto
  // the deferred round's eager message (idempotent per callId) BEFORE sealing,
  // so a persistence failure leaves every record unsealed and retryable.
  const toolResults: AgentToolResult[] = resolved.map(({ record, submission }) => {
    if (!submission.ok) {
      return {
        ok: false,
        callId: record.callId,
        toolName: record.toolName,
        toolInput: record.arguments as Record<string, unknown>,
        error: new ToolError(
          (submission.error?.category ?? "internal") as ToolErrorCategory,
          submission.error?.code ?? "tools/host-execution-required",
          "The desktop host could not execute the requested operation.",
        ),
      };
    }
    return {
      ok: true,
      callId: record.callId,
      toolName: record.toolName,
      toolInput: record.arguments as Record<string, unknown>,
      data: submission.result,
    };
  });
  for (const [index, { record }] of resolved.entries()) {
    const toolResult = toolResults[index];
    if (toolResult === undefined) continue;
    await attachAgentMessageToolResult({
      userId,
      conversationId,
      messageId: record.messageId,
      toolResult,
    });
  }
  // Phase 2 — seal EVERY record exactly once (single-use; cannot be replayed).
  for (const { record } of resolved) {
    await submitHostExecution(userId, record.id, now);
  }
  // §6.9 — BEST-EFFORT approval consumption AFTER successful submission/sealing.
  // Only an APPROVAL-LINKED execution (an approved host write, today move_file)
  // consumes an approval, and it does so exactly here. The seal is the true
  // single-use guarantee: a failed consume cannot un-seal the execution, and a
  // later submit of the same execution is rejected as `already-executed`. This
  // is the same single-request semantics caveat the Phase 10.30 approval
  // execution path documents (consume is bookkeeping for the approval card).
  for (const { record } of resolved) {
    if (record.approvalId !== null) {
      try {
        await consumeToolApproval(userId, record.approvalId, now);
      } catch {
        // The approved operation already ran exactly once; never mask the
        // executed turn with a bookkeeping failure.
      }
    }
  }
  const initialRounds = resolved.reduce(
    (highest, s) => Math.max(highest, s.record.round),
    0,
  );
  return { conversationId, seeds: toolResults, initialRounds };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Run one durable agent turn for the authenticated session user.
 *
 * Persistence ORDER (Phase 10.28C-prep):
 *
 *   - Text-only turns (the provider never requests tools) are persisted the
 *     original way: the ENTIRE turn atomically via `persistAgentTurn`; a
 *     failure before that write leaves nothing.
 *   - Tool turns EAGERLY persist round by round: `beginAgentTurn` (first
 *     round: conversation + instruction + round message committed) and
 *     `appendAgentTurnRoundMessage` (later rounds) run BEFORE that round's
 *     intents execute, so every tool execution has a REAL persisted
 *     `conversationId` + `messageId` bound to its `ToolExecutionContext`.
 *     `completeAgentTurn` then attaches the results + final reply in ONE
 *     transaction.
 *   - If the turn fails after eager persistence, `cancelAgentTurn`
 *     compensates: a new conversation is deleted, or a resumed conversation
 *     loses exactly this turn's messages — no partial turn state remains.
 *
 * @throws `AppError.unauthorized()` when `c` has no valid session (fail
 *         closed before the provider is contacted).
 * @throws `AgentConversationNotFoundError` when `conversationId` is not
 *         owned by the authenticated user (or does not exist).
 * @throws `ToolApprovalNotFoundError` (resume mode) when `resumeApprovalId`
 *         is not owned by the authenticated user (indistinguishable from
 *         missing), or references a conversation the user cannot load.
 * @throws `ToolApprovalNotExecutableError` / `ToolApprovalExpiredError`
 *         (resume mode) when the approval is not `approved` / its window has
 *         elapsed — nothing is executed. The same guards prevent replay of an
 *         already-consumed approval.
 * @throws `AppError.badRequest` (resume mode) when a supplied
 *         `conversationId` does not match the approval's own conversation.
 * @throws `ProviderError` when the provider fails — the eager rows of the
 *         failed turn are compensated away (nothing new remains).
 * @throws `AgentLoopError` when the provider requests tools past the bound —
 *         the skipped tools are never executed and the executed rounds'
 *         eager rows are compensated away.
 * @throws `TypeError` on malformed provider rounds / missing final text —
 *         any eager rows are compensated away.
 */
export async function runPersistentTurn(
  c: { get: (key: string) => unknown },
  input: PersistentTurnInput,
  options: PersistentTurnOptions,
): Promise<PersistentTurnResult> {
  // 0. Resolve the provider facade BEFORE any work: either the composed
  //    provider stack (Phase 10.20 production integration) or a ready
  //    AgentProvider. Exactly one source is allowed.
  const provider = resolveTurnProvider(options);

  // 1. Auth pre-flight + provider-visible context (Phase 10.5). Fails closed,
  //    filters registered tools, and validates the instruction.
  const { auth, context } = buildAgentContext({
    instruction: input.instruction,
    tools: options.tools,
    registry: options.registry,
    user: c.get("user"),
  });
  const userId = auth.user.id;
  if (userId.length === 0) {
    throw AppError.unauthorized();
  }

  // 2. Load an existing conversation (ownership enforced) to inherit its
  //    round bound; otherwise the input/default bound applies. In resume mode
  //    (Phase 10.30) the conversation is the approved approval's OWN one: the
  //    approval is resolved with ownership enforced, its stored operation is
  //    asserted executable NOW (rejected/expired/foreign/consumed never run),
  //    and its conversation's persisted bound becomes this turn's bound.
  let bound: number | undefined;
  let resumeRecord: ToolApprovalRecord | undefined;
  let hostResume: ResolvedHostResume | undefined;
  let history: readonly AgentHistoryMessage[] | undefined;
  if (input.resumeApprovalId !== undefined) {
    const record = await getToolApproval(userId, input.resumeApprovalId);
    if (record === null) {
      throw new ToolApprovalNotFoundError();
    }
    if (input.conversationId !== undefined && record.conversationId !== input.conversationId) {
      throw AppError.badRequest("The approval belongs to a different conversation.");
    }
    assertToolApprovalExecutable(record, new Date());
    const resumedConversation = await loadAgentConversationState(userId, record.conversationId);
    if (resumedConversation === null) {
      throw new ToolApprovalNotFoundError();
    }
    bound = resumedConversation.maxToolRounds;
    history = await loadConversationHistory(userId, record.conversationId);
    resumeRecord = record;
  } else if (input.resumeHostExecutions !== undefined && input.resumeHostExecutions.length > 0) {
    // Phase 10.39: resume the PAUSED turn. Every submitted execution is
    // asserted executable + SEALED (once) before anything else runs. A
    // failure here throws and leaves every record unsealed. The executions
    // must share one conversation (matching an optional supplied id), whose
    // persisted round bound becomes this turn's bound. This branch runs
    // BEFORE the generic `conversationId` resume so the desktop driver's
    // payload (which always includes `conversationId` alongside
    // `resumeExecutions`) reaches the seal path.
    const resolved = await resolveHostExecutionsResume(
      userId,
      input.resumeHostExecutions,
      new Date(),
    );
    if (input.conversationId !== undefined && input.conversationId !== resolved.conversationId) {
      throw AppError.badRequest("The submitted host executions belong to a different conversation.");
    }
    const resumedConversation = await loadAgentConversationState(userId, resolved.conversationId);
    if (resumedConversation === null) {
      throw new AgentConversationNotFoundError();
    }
    bound = resumedConversation.maxToolRounds;
    history = await loadConversationHistory(userId, resolved.conversationId);
    hostResume = resolved;
    // The executions' own conversation is authoritative for the resumed
    // turn — the caller need not repeat it (but may, and it must match).
    input.conversationId = resolved.conversationId;
  } else if (input.conversationId !== undefined) {
    const loaded = await loadAgentConversationState(userId, input.conversationId);
    if (loaded === null) {
      throw new AgentConversationNotFoundError();
    }
    bound = loaded.maxToolRounds;
    history = await loadConversationHistory(userId, input.conversationId);
  }
  const maxToolRounds = bound ?? options.maxToolRounds ?? 1;

  // Eager-persistence state (Phase 10.28C-prep). `engaged` turns true once
  // the FIRST tool round is committed; from then on every failure path
  // compensates so no partial turn state survives.
  let engaged = false;
  let conversationId: string | undefined;
  let created = false;
  let instructionMessageId: string | undefined;
  let currentSlot: { messageId: string; toolResults?: readonly AgentToolResult[] } | undefined;
  const roundSlots: { messageId: string; toolResults?: readonly AgentToolResult[] }[] = [];

  try {
    // 3. Resume mode (Phase 10.30): BEFORE the loop, execute the approved
    //    approval exactly once, consume it so it can never be replayed, and
    //    record it as this turn's first (pre-run) tool round. Execution stays
    //    in the unchanged `invokeTool` gate → policy → handler → executor
    //    pipeline; ONLY the approval's exact stored arguments run (the caller
    //    supplies none here). The result is fed to the provider as seeded
    //    context and counted against the conversation's round bound.
    const observed: AgentLoopRound[] = [];
    let resumeSeeded: { toolResult: AgentToolResult; approvedCall: AgentToolCall } | undefined;
    if (resumeRecord !== undefined) {
      // §6.9 — APPROVED HOST WRITE (today only move_file): the approved
      // operation does NOT resume through the Phase 10.28 executor (in this
      // process that executor is the read-only host-delegated harness — it can
      // never move files). Instead the turn PAUSES with one host execution
      // bound 1:1 to this approval; the DESKTOP HOST then executes the exact
      // approved arguments against the real filesystem. The approval is NOT
      // consumed here — it is consumed only AFTER that execution SEALS on the
      // later host-execution resume (§6.9), so "approved once" becomes
      // "executed exactly once" atomically with the execution.
      if (HOST_DELEGATED_APPROVED_WRITE_TOOLS.has(resumeRecord.toolName)) {
        if (input.resumeHostExecutions !== undefined && input.resumeHostExecutions.length > 0) {
          throw AppError.badRequest(
            "Cannot submit host executions at the same time as an approval resume.",
          );
        }
        const now = new Date();
        let execution: HostExecutionRecord;
        const existing = await getPendingHostExecutionByApproval(userId, resumeRecord.id);
        if (existing !== null) {
          // A RE-SUBMITTED approval resume is IDEMPOTENT: surface the FIRST
          // pending execution instead of writing a second row (the DB partial
          // unique index on the pending approval is the backstop, §6.9).
          execution = existing;
        } else {
          const begun = await beginAgentTurn({
            userId,
            conversationId: resumeRecord.conversationId,
            instruction: context.instruction,
            maxToolRounds,
            toolCalls: [
              {
                id: resumeRecord.id,
                toolName: resumeRecord.toolName,
                input: resumeRecord.arguments as RawToolInput,
              },
            ],
          });
          conversationId = begun.conversationId;
          created = begun.created;
          instructionMessageId = begun.instructionMessageId;
          engaged = true;
          roundSlots.push({ messageId: begun.messageId });
          try {
            execution = await createAiHostExecution(
              {
                userId,
                conversationId: begun.conversationId,
                messageId: begun.messageId,
                toolName: resumeRecord.toolName,
                callId: resumeRecord.id,
                round: 1,
                arguments: resumeRecord.arguments,
                approvalId: resumeRecord.id,
                expiresAt: new Date(now.getTime() + HOST_EXECUTION_WINDOW_MS),
                now,
              },
              { registry: options.registry },
            );
          } catch (error) {
            if (error instanceof HostExecutionDuplicateError) {
              // A racing resume created the execution first — reuse it.
              const raced = await getPendingHostExecutionByApproval(userId, resumeRecord.id);
              if (raced === null) throw error;
              execution = raced;
            } else {
              throw error;
            }
          }
        }
        // PAUSE, like the read-gate: the eager rows (conversation, and this
        // round's persisted message when created above) are committed BY
        // DESIGN and never compensated — there is simply no final reply yet.
        // The AI resumes when the host's sealed result is submitted.
        return {
          conversationId: execution.conversationId,
          created,
          state: createConversationState({ instruction: context.instruction, maxToolRounds }),
          pendingApprovals: [],
          pendingExecutions: [toHostExecutionRequestInfo(execution)],
        };
      }
      const executed = await invokeTool(
        c,
        resumeRecord.toolName,
        {},
        {
          registry: options.registry,
          filesystem: options.filesystem,
          ...(options.policy !== undefined ? { policy: options.policy } : {}),
          turnContext: {
            conversationId: resumeRecord.conversationId,
            messageId: resumeRecord.messageId,
          },
          approvalId: resumeRecord.id,
        },
      );
      const toolResult: AgentToolResult = executed.ok
        ? {
            ok: true,
            callId: resumeRecord.id,
            toolName: resumeRecord.toolName,
            toolInput: resumeRecord.arguments as Record<string, unknown>,
            data: executed.data,
          }
        : {
            ok: false,
            callId: resumeRecord.id,
            toolName: resumeRecord.toolName,
            toolInput: resumeRecord.arguments as Record<string, unknown>,
            error: executed.error,
          };
      const approvedCall: AgentToolCall = {
        id: resumeRecord.id,
        toolName: resumeRecord.toolName,
        input: resumeRecord.arguments as RawToolInput,
      };
      // Seal the spent approval so it can never authorize a second execution.
      // Best-effort: the execution has already happened, so a consume failure
      // must not mask the executed turn (single-request semantics — the same
      // non-transactional caveat the Phase 10.28C approval gate has).
      try {
        await consumeToolApproval(userId, resumeRecord.id, new Date());
      } catch {
        // A concurrent decision cannot undo an execution that already ran.
      }
      const begun = await beginAgentTurn({
        userId,
        conversationId: resumeRecord.conversationId,
        instruction: context.instruction,
        maxToolRounds,
        toolCalls: [approvedCall],
      });
      conversationId = begun.conversationId;
      created = begun.created;
      instructionMessageId = begun.instructionMessageId;
      engaged = true;
      currentSlot = { messageId: begun.messageId, toolResults: [toolResult] };
      roundSlots.push(currentSlot);
      observed.push({
        text: undefined,
        toolCalls: [approvedCall],
        results: [toolResult],
        toolRounds: 1,
      });
      resumeSeeded = { toolResult, approvedCall };
    }

    const output = await runAgentLoop(c, context.instruction, {
      provider,
      tools: context.tools,
      registry: options.registry,
      filesystem: options.filesystem,
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      maxToolRounds,
      ...(history !== undefined ? { initialHistory: history } : {}),
      ...(resumeSeeded !== undefined
        ? { initialToolResults: [resumeSeeded.toolResult], initialToolRounds: 1 }
        : {}),
      ...(hostResume !== undefined
        ? { initialToolResults: hostResume.seeds, initialToolRounds: hostResume.initialRounds }
        : {}),
      onRound: (round) => {
        observed.push(round);
        // The loop calls prepareRound → execute → onRound in strict order,
        // so `currentSlot` is exactly the round just executed.
        if (currentSlot !== undefined) currentSlot.toolResults = round.results;
        currentSlot = undefined;
      },
      prepareRound: async (response) => {
        if (engaged) {
          const appended = await appendAgentTurnRoundMessage({
            userId,
            conversationId: conversationId as string,
            ...(response.text !== undefined ? { text: response.text } : {}),
            toolCalls: response.toolCalls ?? [],
          });
          currentSlot = { messageId: appended.messageId };
          roundSlots.push(currentSlot);
          return {
            conversationId: conversationId as string,
            messageId: appended.messageId,
          };
        }
        const begun = await beginAgentTurn({
          userId,
          ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
          instruction: context.instruction,
          maxToolRounds,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(response.text !== undefined ? { text: response.text } : {}),
          toolCalls: response.toolCalls ?? [],
        });
        conversationId = begun.conversationId;
        created = begun.created;
        instructionMessageId = begun.instructionMessageId;
        engaged = true;
        currentSlot = { messageId: begun.messageId };
        roundSlots.push(currentSlot);
        return {
          conversationId: begun.conversationId,
          messageId: begun.messageId,
        };
      },
    });
    const rounds = observed.map(toTurnRecord);

    // Phase 10.39 PAUSE: the loop stopped WITHOUT executing its round's
    // intents (host executions are pending on the desktop host). This is a
    // PAUSE, not a failure: the eager rows — the conversation and this
    // round's assistant/tool-call message — were committed by
    // beginAgentTurn/appendAgentTurnRoundMessage BEFORE the intents ran and
    // persist BY DESIGN; no compensation runs and nothing is finalized (there
    // is no final reply yet). The partial state replays ONLY the executed
    // rounds — the deferred round is not an executed turn — so it yields an
    // awaiting-host-execution, unfinalized conversation.
    if (output.pendingExecutions.length > 0) {
      let pausedState = createConversationState({
        instruction: context.instruction,
        maxToolRounds,
      });
      for (const round of rounds.slice(0, -1)) {
        pausedState = recordProviderTurn(pausedState, {
          text: round.text,
          toolCalls: round.toolCalls,
        });
        if (round.toolResults !== undefined) {
          pausedState = recordToolResults(pausedState, round.toolResults);
        }
      }
      return {
        conversationId: conversationId as string,
        created,
        state: pausedState,
        pendingApprovals: output.pendingApprovals,
        pendingExecutions: output.pendingExecutions,
      };
    }

    // Phase 10.29: collect pending approval metadata from the agent loop.
    // This is safe metadata only — approval id, tool name, validated args,
    // and expiry — no raw file contents or provider output.
    const turnPendingApprovals = output.pendingApprovals;

    // 4. Replay the transcript through the Phase 10.6 transitions. This both
    //    validates (reusing the same guards persistence uses) and produces the
    //    updated state returned to the caller.
    let state = createConversationState({
      instruction: context.instruction,
      maxToolRounds,
    });
    for (const round of rounds) {
      state = recordProviderTurn(state, {
        text: round.text,
        toolCalls: round.toolCalls,
      });
      if (round.toolResults !== undefined) {
        state = recordToolResults(state, round.toolResults);
      }
    }
    state = finalizeConversation(state, output.text ?? undefined);

    // 5. Persist the final result. Tool turns: attach each round's
    //    tool_results to its eager message and append the is_final reply in
    //    ONE transaction (ownership re-verified inside). Text-only turns keep
    //    the original all-or-nothing `persistAgentTurn` write.
    if (engaged) {
      await completeAgentTurn({
        userId,
        conversationId: conversationId as string,
        rounds: roundSlots.map((slot) => ({
          messageId: slot.messageId,
          toolResults: slot.toolResults ?? [],
        })),
        finalText: state.finalText ?? "",
      });
      return {
        conversationId: conversationId as string,
        created,
        state,
        pendingApprovals: turnPendingApprovals,
        pendingExecutions: [],
      };
    }

    const persisted = await persistAgentTurn({
      userId,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      instruction: context.instruction,
      maxToolRounds,
      ...(input.title !== undefined ? { title: input.title } : {}),
      rounds,
      finalText: state.finalText ?? "",
    });

    return {
      conversationId: persisted.id,
      created: persisted.created,
      state,
      pendingApprovals: turnPendingApprovals,
      pendingExecutions: [],
    };
  } catch (error) {
    // 6. Compensation: a failed turn that already committed eager rows must
    //    not leave partial state. A new conversation is deleted (cascade); a
    //    resumed conversation loses exactly this turn's messages. The
    //    compensation is best-effort so the ORIGINAL error always governs.
    if (engaged) {
      try {
        await cancelAgentTurn({
          userId,
          conversationId: conversationId as string,
          created,
          messageIds: [
            ...(instructionMessageId !== undefined ? [instructionMessageId] : []),
            ...roundSlots.map((slot) => slot.messageId),
          ],
        });
      } catch {
        // A failed compensation (e.g. the database is down) cannot mask the
        // original failure. The rows left behind are valid-but-incomplete
        // transcript entries — never corrupt — and a later successful turn
        // appends to the conversation normally.
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Composed-stack runtime binding (Phase 10.20)
// ---------------------------------------------------------------------------

/**
 * Persistent-turn runtime options bound to a COMPOSED provider stack. The
 * stack is created once at startup (via `composeDefaultProviderStack()`) and
 * drives every turn; setting `provider` is intentionally disallowed here so
 * production wiring cannot bypass the multi-provider system.
 */
export type PersistentTurnStackOptions = Omit<PersistentTurnOptions, "provider" | "stack"> & {
  /** The composed provider stack whose facade runs each turn's rounds. */
  stack: ComposedProviderStack;
};

/**
 * A persistent-turn runtime pre-bound to one composed provider stack. This is
 * the production integration point (Phase 10.20): the app composes the
 * configured multi-provider stack ONCE and routes every authenticated turn
 * through it. Fallback, credential rotation, and health/cooldown then run
 * inside the stack, transparently to the Agent.
 */
export interface PersistentAgentTurnRuntime {
  /**
   * Run one durable, authenticated turn through the bound composed stack.
   * @throws `AppError.unauthorized()` / `AgentConversationNotFoundError` /
   *         `ProviderError` / `AgentLoopError` exactly as `runPersistentTurn`.
   */
  run(
    c: { get: (key: string) => unknown },
    input: PersistentTurnInput,
  ): Promise<PersistentTurnResult>;
}

/**
 * Bind a composed provider stack to the persistent-turn service. The stack's
 * `provider` facade is obtained at runtime by the service itself — the caller
 * never hands it a bare single-provider construction.
 *
 * @throws `TypeError` when the caller accidentally supplies `provider` as well
 *         (the stack is the only allowed source here).
 */
export function createPersistentTurnRuntime(
  options: PersistentTurnStackOptions,
): PersistentAgentTurnRuntime {
  const { stack } = options;
  if ((options as PersistentTurnOptions).provider !== undefined) {
    throw new TypeError(
      "createPersistentTurnRuntime only accepts a composed `stack`; " +
        "a bare `provider` cannot be combined with it.",
    );
  }
  return {
    async run(c, input) {
      // Phase 10.39: consult the per-request filesystem resolver (when
      // present). A non-undefined return replaces the base executor for THIS
      // turn only — e.g. the desktop host's `x-desktop-host: 1` header swaps
      // in the host-delegated executor so AI filesystem tool calls are
      // recorded for the desktop instead of failing against the Tauri bridge
      // this Node process cannot reach.
      const filesystem = options.resolveFilesystem?.(c) ?? options.filesystem;

      // Phase 10.40: consult the per-request tool-round-bound resolver (when
      // present). A non-undefined return replaces the base `maxToolRounds`
      // for THIS turn only, so NEW conversations are persisted with the
      // user's chosen AI Quality bound (Low 3 / Medium 5 / High 8). Resumed
      // conversations always keep their persisted bound, so the override
      // cannot raise an existing conversation's bound.
      const resolvedMaxToolRounds = options.resolveMaxToolRounds?.(c);
      return runPersistentTurn(c, input, {
        ...options,
        stack,
        filesystem,
        ...(resolvedMaxToolRounds !== undefined ? { maxToolRounds: resolvedMaxToolRounds } : {}),
      });
    },
  };
}
