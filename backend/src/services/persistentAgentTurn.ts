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
 *      memory — the loop's execution, routing, policy, and `invokeTool()`
 *      pipeline are untouched. The provider stays a pure abstraction.
 *   4. STATE (Phase 10.6): the transcript is replayed through the immutable
 *      `ConversationState` transitions — the same validators persistence
 *      uses — to produce the updated state (and to reject malformed rounds
 *      before anything is written).
 *   5. PERSIST (Phase 10.7 repository): the ENTIRE turn — instruction,
 *      provider rounds, terminal reply — is committed in ONE transaction via
 *      `persistAgentTurn`. The instruction and the whole transcript are
 *      all-or-nothing: a provider failure, loop error, or validation failure
 *      leaves NO partial or corrupt state behind.
 *
 * Design rules:
 *
 *   - OWNERSHIP EVERYWHERE: load and persist are keyed by the authenticated
 *     user derived from the session, never from provider/request data. A
 *     foreign conversation looks identical to a missing one.
 *   - NO DUPLICATED LOOP: this service does not re-implement the bounded loop;
 *     it observes it and persists what it records.
 *   - NO PROVIDER COUPLING: the provider is injected (`AgentProvider`). No API
 *     keys, no network, no real AI provider here.
 *   - NO POLICY BYPASS: tool execution stays in the Phase 10.2/9.8
 *     `invokeTool()` pipeline on every round.
 *   - NO I/O OUTSIDE THE REPOSITORY: the service performs no direct Prisma
 *     access; it goes through the Phase 10.7 repository functions.
 */
import { AppError } from "../core/errors.js";
import type { AgentProvider } from "./provider.js";
import type { ToolDefinition } from "../tools/types.js";
import type { InvokeToolOptions } from "./tools.js";
import { buildAgentContext } from "./agentContext.js";
import { runAgentLoop, type AgentLoopRound } from "./agentLoop.js";
import {
  createConversationState,
  finalizeConversation,
  recordProviderTurn,
  recordToolResults,
  type ConversationState,
} from "./conversation.js";
import {
  AgentConversationNotFoundError,
  loadAgentConversationState,
  persistAgentTurn,
  type AgentTurnRecord,
} from "../database/repositories/agentConversations.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistentTurnInput {
  /** Resume this conversation (ownership enforced). Omit to create a new one. */
  conversationId?: string;
  /** The user's instruction for this turn. */
  instruction: string;
  /** Optional display title for newly created conversations. */
  title?: string;
}

export interface PersistentTurnOptions extends InvokeToolOptions {
  /** The provider adapter that produces the turn's replies / intents. */
  provider: AgentProvider;
  /** Candidate tool metadata; filtered to registered tools before use. */
  tools: readonly ToolDefinition[];
  /** Loop bound used when creating a new conversation. Default 1. */
  maxToolRounds?: number;
}

export interface PersistentTurnResult {
  /** The conversation id (existing or newly created). */
  conversationId: string;
  /** True when a new conversation was created for this turn. */
  created: boolean;
  /** The updated, fully persisted conversation state (Phase 10.6). */
  state: ConversationState;
}

/** Map a loop-observed round into the repository's persist shape. */
function toTurnRecord(round: AgentLoopRound): AgentTurnRecord {
  return {
    ...(round.text !== undefined ? { text: round.text } : {}),
    toolCalls: round.toolCalls,
    toolResults: round.results,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Run one durable agent turn for the authenticated session user.
 *
 * @throws `AppError.unauthorized()` when `c` has no valid session (fail
 *         closed before the provider is contacted).
 * @throws `AgentConversationNotFoundError` when `conversationId` is not
 *         owned by the authenticated user (or does not exist).
 * @throws `ProviderError` when the provider fails — nothing is persisted for
 *         the failed turn (no conversation, no partial transcript).
 * @throws `AgentLoopError` when the provider requests tools past the bound —
 *         the skipped tools are never executed and nothing is persisted.
 * @throws `TypeError` on malformed provider rounds / missing final text —
 *         nothing is persisted.
 */
export async function runPersistentTurn(
  c: { get: (key: string) => unknown },
  input: PersistentTurnInput,
  options: PersistentTurnOptions,
): Promise<PersistentTurnResult> {
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
  //    round bound; otherwise the input/default bound applies.
  let bound: number | undefined;
  if (input.conversationId !== undefined) {
    const loaded = await loadAgentConversationState(userId, input.conversationId);
    if (loaded === null) {
      throw new AgentConversationNotFoundError();
    }
    bound = loaded.maxToolRounds;
  }
  const maxToolRounds = bound ?? options.maxToolRounds ?? 1;

  // 3. Run the existing bounded loop (Phase 10.4), recording the transcript
  //    of each executed round via the observer. Nothing is persisted yet.
  const observed: AgentLoopRound[] = [];
  const output = await runAgentLoop(c, context.instruction, {
    provider: options.provider,
    tools: context.tools,
    registry: options.registry,
    filesystem: options.filesystem,
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
    maxToolRounds,
    onRound: (round) => observed.push(round),
  });
  const rounds = observed.map(toTurnRecord);

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

  // 5. Persist the complete turn atomically (instruction → rounds → final) in
  //    one transaction. Ownership is re-verified inside the transaction.
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
  };
}