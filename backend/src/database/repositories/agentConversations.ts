/**
 * Agent conversation repository — the ONLY place agent-conversation state
 * persistence touches Prisma (Phase 10.7).
 *
 * Boundary rules (database/README): no HTTP semantics, no Hono deps, no
 * filesystem access, no provider calls, no network. It persists the Phase
 * 10.6 `ConversationState` contract provider-independently, keyed under an
 * authenticated user's ownership. Ownership is enforced on every load and
 * modify: a `conversationId` that is not owned by `userId` is
 * indistinguishable from one that does not exist (returns `null` / throws
 * `AgentConversationNotFoundError`). Only raw structured tool data is
 * stored — never file contents.
 *
 * Storage shape (one `ai_messages` row per recorded step, order =
 * `(created_at, id)`):
 *
 *   - user instruction          -> role 'user'
 *   - a provider round          -> role 'assistant' with `tool_calls` JSONB
 *                                  and the round's `tool_results` JSONB
 *   - the terminal agent reply  -> role 'assistant' with `is_final = true`
 *
 * The conversation row's `max_tool_rounds` is the loop bound so turn
 * progress (`toolRounds`, `remainingToolRounds`) is reconstructible without
 * re-implementing the bounded loop.
 */
import { getDatabase } from "../client.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { AgentToolCall, AgentToolResult } from "../../services/agent.js";
import {
  createConversationState,
  finalizeConversation,
  recordProviderTurn,
  recordToolResults,
  validateToolCalls,
  validateToolResults,
  type ConversationState,
} from "../../services/conversation.js";
import { ToolError, type ToolErrorCategory } from "../../tools/errors.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a conversation id is unknown OR belongs to another user
 *  (both are deliberately indistinguishable). */
export class AgentConversationNotFoundError extends Error {
  readonly code = "agent-conversation/not-found-or-not-owned";
  constructor() {
    super("Agent conversation not found for this user.");
    this.name = "AgentConversationNotFoundError";
  }
}

/** Thrown when stored rows cannot form a valid `ConversationState`. */
export class AgentConversationCorruptError extends Error {
  readonly code = "agent-conversation/corrupt";
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentConversationCorruptError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredConversation {
  id: string;
  userId: string;
  title: string | null;
  maxToolRounds: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAgentConversationInput {
  /** Owning (authenticated) user. */
  userId: string;
  /** The user's instruction — persisted as the conversation's first message. */
  instruction: string;
  /** Strict loop bound (mirrors Phase 10.6 `maxToolRounds`). */
  maxToolRounds: number;
  /** Optional display title. */
  title?: string;
}

/** One recorded provider round: free-form text, its tool-call intents, and
 *  the structured results of executing those intents. */
export interface AgentTurnInput {
  text?: string;
  toolCalls?: readonly AgentToolCall[];
  toolResults?: readonly AgentToolResult[];
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function assertStoredText(text: unknown, label: string): string | undefined {
  if (text === undefined) return undefined;
  if (typeof text !== "string" || text.length === 0) {
    throw new TypeError(`${label} must be a non-empty string when present.`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Create / append
// ---------------------------------------------------------------------------

/**
 * Create a conversation and persist the user's instruction as its first
 * message, atomically. The given instruction/bound are validated by the
 * Phase 10.6 `createConversationState` before anything is written.
 */
export async function createAgentConversation(
  input: CreateAgentConversationInput,
): Promise<StoredConversation> {
  const state = createConversationState({
    instruction: input.instruction,
    maxToolRounds: input.maxToolRounds,
  });
  const db = getDatabase();
  const created = await db.$transaction(async (tx) => {
    const conversation = await tx.aiConversation.create({
      data: {
        userId: input.userId,
        maxToolRounds: state.maxToolRounds,
        title: input.title ?? null,
      },
    });
    await tx.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        content: state.instruction,
      },
    });
    return conversation;
  });
  return {
    id: created.id,
    userId: created.userId,
    title: created.title,
    maxToolRounds: created.maxToolRounds,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  };
}

/**
 * Append a provider round to a user-owned conversation: an `assistant`
 * message carrying the round's free-form text, its tool-call intents
 * (`tool_calls`), and the round's structured results (`tool_results`).
 * Ownership is verified inside the same transaction that writes, so a
 * foreign owner cannot modify a conversation. Invalid intents/results throw
 * `TypeError` before anything is written.
 */
export async function appendAgentTurn(
  userId: string,
  conversationId: string,
  input: AgentTurnInput,
): Promise<void> {
  const text = assertStoredText(input.text, "provider text");
  const toolCalls = input.toolCalls === undefined ? undefined : validateToolCalls(input.toolCalls);
  if (text === undefined && toolCalls === undefined) {
    throw new TypeError("A provider turn must include text or toolCalls.");
  }
  const toolResults =
    input.toolResults === undefined ? undefined : validateToolResults(input.toolResults);

  const db = getDatabase();
  await db.$transaction(async (tx) => {
    const owned = await tx.aiConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (owned === null) throw new AgentConversationNotFoundError();
    await tx.aiMessage.create({
      data: {
        conversationId,
        role: "assistant",
        content: text ?? "",
        ...(toolCalls !== undefined ? { toolCalls: asJson(toolCalls) } : {}),
        ...(toolResults !== undefined ? { toolResults: asJson(toolResults) } : {}),
      },
    });
    await bumpUpdatedAt(tx, conversationId);
  });
}

/**
 * Append the terminal agent reply to a user-owned conversation (`is_final =
 * true`). Ownership is verified inside the same transaction as the write.
 */
export async function appendAgentFinal(
  userId: string,
  conversationId: string,
  text: string,
): Promise<void> {
  const finalText = assertStoredText(text, "final text");
  if (finalText === undefined) {
    throw new TypeError("final text must be a non-empty string.");
  }
  const db = getDatabase();
  await db.$transaction(async (tx) => {
    const owned = await tx.aiConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (owned === null) throw new AgentConversationNotFoundError();
    await tx.aiMessage.create({
      data: { conversationId, role: "assistant", content: finalText, isFinal: true },
    });
    await bumpUpdatedAt(tx, conversationId);
  });
}

/** Bump `updated_at` (the schema promises it bumps on new messages). */
async function bumpUpdatedAt(
  tx: Prisma.TransactionClient,
  conversationId: string,
): Promise<void> {
  await tx.aiConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export interface StoredMessage {
  role: string;
  content: string;
  toolCalls?: unknown;
  toolResults?: unknown;
  isFinal: boolean;
  createdAt: Date;
}

/**
 * Load a user-owned conversation back into a live Phase 10.6 state, or
 * `null` when the conversation does not exist for `userId` (ownership
 * enforced — a foreign conversation is indistinguishable from a missing
 * one). Reconstructs the state by replaying stored rows through the 10.6
 * transitions, which re-validates every stored value and rejects
 * malformed/corrupt rows with `AgentConversationCorruptError`.
 */
export async function loadAgentConversationState(
  userId: string,
  conversationId: string,
): Promise<ConversationState | null> {
  const db = getDatabase();
  const conversation = await db.aiConversation.findFirst({
    where: { id: conversationId, userId },
    select: { maxToolRounds: true },
  });
  if (conversation === null) return null;
  const stored = await db.aiMessage.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return reconstructConversationState(conversation.maxToolRounds, stored);
}

/**
 * Replay stored transcript rows into a `ConversationState`. Pure — no I/O —
 * so it is directly unit-testable. A stored `user` row starts a new turn, a
 * stored `assistant` row without `is_final` is replaying `recordProviderTurn`
 * (+ its `tool_results` as `recordToolResults`), and an `is_final` row ends
 * the transcript. Each step runs through the Phase 10.6 validation, so
 * malformed stored data throws `AgentConversationCorruptError`.
 */
export function reconstructConversationState(
  maxToolRounds: number,
  stored: readonly StoredMessage[],
): ConversationState {
  let state: ConversationState | undefined;
  for (const message of [...stored].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (message.role === "user") {
      state = createConversationState({ instruction: message.content, maxToolRounds });
      continue;
    }
    if (message.role !== "assistant") continue;
    if (state === undefined) {
      throw new AgentConversationCorruptError(
        "Assistant message recorded before any user instruction.",
      );
    }
    state = replayAssistantMessage(state, message);
  }
  if (state === undefined) {
    throw new AgentConversationCorruptError(
      "Stored transcript has no user instruction to start the turn.",
    );
  }
  return state;
}

function replayAssistantMessage(state: ConversationState, message: StoredMessage): ConversationState {
  try {
    if (message.isFinal) {
      return finalizeConversation(state, message.content);
    }
    const toolCalls = message.toolCalls ?? undefined;
    const next = recordProviderTurn(state, {
      text: message.content.length > 0 ? message.content : undefined,
      toolCalls,
    });
    if (message.toolResults !== null && message.toolResults !== undefined) {
      if (!Array.isArray(message.toolResults)) {
        throw new TypeError("Stored tool results must be an array.");
      }
      const restored = message.toolResults.map(restoreToolResultError);
      return recordToolResults(next, restored);
    }
    return next;
  } catch (error) {
    if (error instanceof AgentConversationCorruptError) throw error;
    throw new AgentConversationCorruptError(
      "Stored conversation data is malformed or inconsistent.",
      error,
    );
  }
}

/**
 * Promote a serialized `ToolError` (`ok: false` results) back to a real
 * `ToolError` instance so loaded results match the Phase 10.6 contract.
 * Leaves every other value untouched.
 */
function restoreToolResultError(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (record.ok !== false) return raw;
  const error = record.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return raw;
  const serialized = error as Record<string, unknown>;
  if (typeof serialized.code !== "string" || typeof serialized.category !== "string") return raw;
  return {
    ...record,
    error: new ToolError(
      serialized.category as ToolErrorCategory,
      serialized.code,
      typeof serialized.message === "string" ? serialized.message : "",
    ),
  };
}