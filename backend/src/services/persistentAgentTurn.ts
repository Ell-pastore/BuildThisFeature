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
 * Design rules:
 *
 *   - OWNERSHIP EVERYWHERE: load and persist are keyed by the authenticated
 *     user derived from the session, never from provider/request data. A
 *     foreign conversation looks identical to a missing one.
 *   - NO DUPLICATED LOOP: this service does not re-implement the bounded loop;
 *     it observes it and persists what it records.
 *   - NO PROVIDER COUPLING: the provider is injected — either as a ready
 *     `AgentProvider`, or (preferred, Phase 10.20) as the composed provider
 *     stack whose `provider` facade this service obtains. No API keys, no
 *     network, no real AI provider decisions here.
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
}

export interface PersistentTurnResult {
  /** The conversation id (existing or newly created). */
  conversationId: string;
  /** True when a new conversation was created for this turn. */
  created: boolean;
  /** The updated, fully persisted conversation state (Phase 10.6). */
  state: ConversationState;
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
    provider,
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

// ---------------------------------------------------------------------------
// Composed-stack runtime binding (Phase 10.20)
// ---------------------------------------------------------------------------

/**
 * Persistent-turn runtime options bound to a COMPOSED provider stack. The
 * stack is created once at startup (via `composeDefaultProviderStack()`) and
 * drives every turn; setting `provider` is intentionally disallowed here so
 * production wiring cannot bypass the multi-provider system.
 */
export type PersistentTurnStackOptions = Omit<
  PersistentTurnOptions,
  "provider" | "stack"
> & {
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
      return runPersistentTurn(c, input, { ...options, stack });
    },
  };
}