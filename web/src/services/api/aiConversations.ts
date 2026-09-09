/**
 * Typed client for the backend's authenticated AI conversation history API
 * (`GET /api/ai/conversations` and `GET /api/ai/conversations/:id`).
 *
 * Every request pulls the bearer token from the centralized session store at
 * call time (`requireSessionToken`) — components never pass or hold a token.
 * When no session is active the call fails fast with
 * `SessionNotAuthenticatedError` instead of issuing an unauthenticated
 * request. Ownership, turn-state derivation, and what is decidable all stay
 * authoritative on the backend.
 */
import { apiRequest } from "./client";
import { requireSessionToken } from "../session";
import type { AiConversationDetail, AiConversationSummary } from "../../types/ai";

/** List the signed-in user's conversations, newest-first. */
export async function listAiConversations(): Promise<AiConversationSummary[]> {
  const token = requireSessionToken();
  return apiRequest<AiConversationSummary[]>("/api/ai/conversations", { token });
}

/**
 * Retrieve one owned conversation with its persisted transcript. A foreign or
 * missing conversation surfaces as the backend's 404 envelope (the client
 * throws the typed `ApiClientError`).
 */
export async function getAiConversation(conversationId: string): Promise<AiConversationDetail> {
  const token = requireSessionToken();
  return apiRequest<AiConversationDetail>(
    `/api/ai/conversations/${encodeURIComponent(conversationId)}`,
    { token },
  );
}