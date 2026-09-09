/**
 * Typed client for the backend's authenticated AI instruction API (`POST
 * /api/ai/instructions`).
 *
 * Mirrors the existing history client: the bearer token is pulled from the
 * centralized session store at call time (`requireSessionToken`) — components
 * never pass or hold a token, and no unauthenticated request is ever issued.
 *
 * The body is STRICT and mirrors the backend validation: only
 * `conversationId` (optional — omitted to start a NEW conversation) and
 * `instruction` (required) are ever sent. Identity always comes from the
 * session, never the body. Ownership, execution, tool policy, turn state, and
 * errors all stay authoritative on the backend.
 */
import { apiRequest } from "./client";
import { requireSessionToken } from "../session";
import type { AiInstructionResponse } from "../../types/ai";

/** The ONLY fields ever sent to `POST /api/ai/instructions`. */
export interface SubmitAiInstructionInput {
  /** Resume this conversation (ownership enforced). Omit to create a new one. */
  conversationId?: string;
  /**
   * Resume the interrupted turn for an approved tool approval (Phase 10.30).
   * The backend honors the approval's exact stored arguments; the conversation
   * is bound from the approval record, so `conversationId` is not needed.
   */
  approvalId?: string;
  /** The user's instruction (required; server-truncated at 4096 characters). */
  instruction: string;
}

/**
 * Submit one instruction to the agent runtime. A foreign or missing
 * conversation surfaces as the backend's 404 envelope; provider failures as
 * 503; the tool-loop bound as 502 (all typed `ApiClientError`).
 */
export async function submitAiInstruction(
  input: SubmitAiInstructionInput,
): Promise<AiInstructionResponse> {
  const token = requireSessionToken();
  return apiRequest<AiInstructionResponse>("/api/ai/instructions", {
    method: "POST",
    body: input,
    token,
  });
}