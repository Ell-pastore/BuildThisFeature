/**
 * Typed client for the backend's authenticated AI instruction API (`POST
 * /api/ai/instructions`).
 *
 * Mirrors the existing history client: the bearer token is pulled from the
 * centralized session store at call time (`requireSessionToken`) — components
 * never pass or hold a token, and no unauthenticated request is ever issued.
 *
 * The body is STRICT and mirrors the backend validation: only
 * `conversationId` (optional — omitted to start a NEW conversation),
 * `instruction` (required), `approvalId` (optional — resume after an approved
 * approval), and `resumeExecutions` (optional — resume after the desktop host
 * executed the pending operations) are ever sent. Identity always comes from
 * the session, never the body. Ownership, execution, tool policy, turn state,
 * and errors all stay authoritative on the backend.
 */
import { apiRequest } from "./client";
import { requireSessionToken } from "../session";
import { isTauriEnv } from "../desktopEnv";
import { readSettings } from "../settings";
import type {
  AiHostExecutionSubmission,
  AiInstructionResponse,
} from "../../types/ai";

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
  /**
   * Resume the interrupted turn after the desktop host executed the pending
   * operations (Phase 10.39): one submission per pending execution. The
   * backend validates each id, ownership, pending status, and expiry, then
   * seals the executions and replays their results into the SAME bounded turn.
   */
  resumeExecutions?: readonly AiHostExecutionSubmission[];
}

/**
 * Submit one instruction to the agent runtime. A foreign or missing
 * conversation surfaces as the backend's 404 envelope; provider failures as
 * 503; the tool-loop bound as 502 (all typed `ApiClientError`).
 *
 * When this app is running inside the Tauri desktop webview, the
 * `x-desktop-host: 1` header is sent so the backend swaps the host-delegated
 * filesystem executor in for THIS request and records AI filesystem tool
 * calls as host executions instead of failing against a Tauri bridge this
 * Node process cannot reach. Plain browsers never send it — the backend stays
 * fail-closed there.
 *
 * The user's AI Quality preference is sent as the `x-ai-quality` header so the
 * backend can bound NEW conversations' tool rounds (Low 3 / Medium 5 / High
 * 8). It is a preference for new conversations only: the backend still honors
 * a resumed conversation's persisted bound, and validates/maps the value
 * server-side (unknown values fail closed to its default). The header is
 * always sent, so the backend never has to guess the current preference.
 */
export async function submitAiInstruction(
  input: SubmitAiInstructionInput,
): Promise<AiInstructionResponse> {
  const token = requireSessionToken();
  return apiRequest<AiInstructionResponse>("/api/ai/instructions", {
    method: "POST",
    body: input,
    token,
    headers: {
      "x-ai-quality": readSettings().aiQuality.toLowerCase(),
      ...(isTauriEnv() ? { "x-desktop-host": "1" } : {}),
    },
  });
}