/**
 * Typed client for the backend's authenticated AI runtime status endpoint
 * (`GET /api/ai/status`).
 *
 * Every request pulls the bearer token from the centralized session store at
 * call time (`requireSessionToken`) — components never pass or hold a token.
 * When no session is active the call fails fast with
 * `SessionNotAuthenticatedError` instead of issuing an unauthenticated
 * request. The payload is secret-free by construction (credential counts, no
 * values/handles/base URLs), so it is safe to render.
 */
import { apiRequest } from "./client";
import { requireSessionToken } from "../session";
import type { AiRuntimeStatus } from "../../types/ai";

/** Resolve the current safe AI runtime status (never network-probing). */
export async function getAiRuntimeStatus(): Promise<AiRuntimeStatus> {
  const token = requireSessionToken();
  return apiRequest<AiRuntimeStatus>("/api/ai/status", { token });
}