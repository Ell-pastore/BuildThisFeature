/**
 * AI conversation history service (Phase 10.23) — the safe, typed read surface
 * that backs `GET /api/ai/conversations[/:conversationId]`.
 *
 * This module is THIN and provider-independent: it calls the existing Phase
 * 10.7 repository (`agentConversations`) for ownership-scoped reads and
 * shapes ONLY. Identity is exclusively the authenticated session user passed
 * in by the route — never read from the request.
 *
 * Security / presentation rules:
 *
 *   - OWNERSHIP is enforced by the repository (`where: { userId }`); a
 *     foreign conversation is indistinguishable from a missing one and both
 *     collapse to the existing 404 `common/not-found` envelope here.
 *   - conversationId is validated through the SHARED UUID convention
 *     (`validateConversationId`) before any query; malformed ids get the
 *     existing 400 `common/bad-request` envelope.
 *   - RETURNED SHAPES are stable and explicit. Persisted message text is the
 *     transcript itself; structured tool data is projected SAFELY:
 *     tool-call intents keep `callId`/`toolName`/`input`; tool results keep
 *     `callId`, status, and any structured metadata (names, sizes, exact
 *     `fileId`/`versionId` REFERENCES), while every content-bearing field
 *     (`data`, `encoding`, `content`, `text`, `raw`, `body`, `payload`,
 *     `base64`, `snippet`, `line`, `lines`, …) is dropped at any depth — so
 *     RAW FILE CONTENTS could never be echoed even if a persisted result
 *     carried them. Failed results expose only the structured `code` +
 *     `category` (never the message, which can embed internals). `path`
 *     fields in persisted intents are the authenticated user's own
 *     conversational references and are kept as references only.
 *   - ORDERING is deterministic: conversations newest-first (by `updatedAt`
 *     desc), persisted messages chronological (by `createdAt` asc).
 *   - Provider keys, credential handles, environment variables, provider
 *     internals, stack traces, and DB internals never enter these shapes.
 *   - NO NETWORK: this module performs no provider or filesystem calls.
 */
import { AppError } from "../core/errors.js";
import {
  getAgentConversation,
  listAgentConversations,
  type StoredConversation,
  type StoredMessageRecord,
} from "../database/repositories/agentConversations.js";
import { validateConversationId } from "./conversationId.js";

// ---------------------------------------------------------------------------
// Safe response types
// ---------------------------------------------------------------------------

/** One owned conversation, newest-first (metadata only — no messages). */
export interface AiConversationSummary {
  id: string;
  title: string | null;
  maxToolRounds: number;
  createdAt: string;
  updatedAt: string;
}

/** A persisted tool-call intent for one provider round. */
export interface AiHistoryToolCall {
  /** Correlates with `AiHistoryToolResult.callId`. */
  callId: string;
  /** Name of a REGISTERED tool. */
  toolName: string;
  /** The untrusted intent input as it was validated at execution time. */
  input: unknown;
}

/** Structured error attribution for a FAILED tool result (message excluded). */
export interface AiStoredToolError {
  code: string;
  category: string;
}

/**
 * Safe projection of one persisted tool result. Success keeps structured
 * metadata with content-bearing fields stripped (raw contents can never be
 * echoed). Failure keeps only the structured code/category.
 */
export type AiHistoryToolResult =
  | { ok: true; callId: string; data?: unknown }
  | { ok: false; callId: string; error: AiStoredToolError };

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

/** One owned conversation with its persisted transcript. */
export interface AiConversationDetail {
  id: string;
  title: string | null;
  maxToolRounds: number;
  createdAt: string;
  updatedAt: string;
  messages: readonly AiHistoryMessage[];
}

// ---------------------------------------------------------------------------
// Safe projection of stored tool data
// ---------------------------------------------------------------------------

/**
 * Structured field names that can carry file/message contents, secrets, or
 * provider internals and are NEVER projected into the API response, at any
 * nesting depth. Kept deliberately permissive so a persisted result can
 * never be a content or secret vector — even if a malicious or future tool
 * result stored one.
 */
const CONTENT_BEARING_FIELDS: ReadonlySet<string> = new Set([
  "base64",
  "body",
  "content",
  "contents",
  "data",
  "encoding",
  "line",
  "lines",
  "payload",
  "raw",
  "snippet",
  "text",
  // Secrets / credentials / provider internals (defense in depth).
  "accessToken",
  "apiKey",
  "apikey",
  "authorization",
  "credentialId",
  "credentials",
  "env",
  "envFile",
  "envVar",
  "environment",
  "handle",
  "key",
  "password",
  "passwd",
  "providerConfig",
  "secret",
  "stack",
  "stackTrace",
  "token",
  "trace",
  "traced",
]);

/**
 * Deep-project a stored structured value to its SAFE representation: arrays
 * and scalars pass through; object values keep every key EXCEPT
 * content-bearing fields (recursively). Structured references (`fileId`,
 * `versionId`, names, sizes, timestamps) survive as references only.
 */
export function projectStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectStructuredValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (CONTENT_BEARING_FIELDS.has(key)) continue;
      out[key] = projectStructuredValue(child);
    }
    return out;
  }
  return value;
}

function isPopulated(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function toSafeToolResult(raw: unknown): AiHistoryToolResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, callId: "", error: { code: "history/malformed", category: "stored" } };
  }
  const record = raw as Record<string, unknown>;
  const callId = typeof record.callId === "string" ? record.callId : "";
  if (record.ok === false) {
    return {
      ok: false,
      callId,
      error: toSafeToolError(record.error),
    };
  }
  const data = projectStructuredValue(record.data);
  return {
    ok: true,
    callId,
    ...(isPopulated(data) ? { data } : {}),
  };
}

function toSafeToolError(raw: unknown): AiStoredToolError {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { code: "history/malformed", category: "stored" };
  }
  const record = raw as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : "history/malformed",
    category: typeof record.category === "string" ? record.category : "stored",
  };
}

function toSafeToolCall(raw: unknown): AiHistoryToolCall {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { callId: "", toolName: "unknown", input: {} };
  }
  const record = raw as Record<string, unknown>;
  return {
    callId: typeof record.id === "string" ? record.id : "",
    toolName: typeof record.toolName === "string" ? record.toolName : "unknown",
    input: projectStructuredValue(record.input ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toSummary(conversation: StoredConversation): AiConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    maxToolRounds: conversation.maxToolRounds,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

function toMessage(message: StoredMessageRecord): AiHistoryMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    isFinal: message.isFinal,
    ...(message.toolCalls !== undefined
      ? { toolCalls: (Array.isArray(message.toolCalls) ? message.toolCalls : []).map(toSafeToolCall) }
      : {}),
    ...(message.toolResults !== undefined
      ? {
          toolResults: (Array.isArray(message.toolResults) ? message.toolResults : []).map(
            toSafeToolResult,
          ),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * List the authenticated user's conversations, newest-first (deterministic:
 * `updatedAt` desc, then `createdAt` desc, then stable id). Empty history
 * returns a valid empty array.
 */
export async function listAiConversations(userId: string): Promise<AiConversationSummary[]> {
  const conversations = await listAgentConversations(userId);
  return conversations.map(toSummary);
}

/**
 * Retrieve ONE conversation owned by `userId` with its persisted messages in
 * chronological order. A foreign OR missing conversation is indistinguishable
 * and both produce the existing 404 `common/not-found` envelope.
 *
 * @throws `AppError.badRequest` on a malformed conversationId (400
 *         `common/bad-request`); `AppError.notFound` (404 `common/not-found`)
 *         when the conversation does not exist for `userId`.
 */
export async function getAiConversation(
  userId: string,
  conversationIdParam: string,
): Promise<AiConversationDetail> {
  const conversationId = validateConversationId(conversationIdParam);
  const detail = await getAgentConversation(userId, conversationId);
  if (detail === null) {
    throw AppError.notFound("Agent conversation");
  }
  return {
    ...toSummary(detail.conversation),
    messages: detail.messages.map(toMessage),
  };
}