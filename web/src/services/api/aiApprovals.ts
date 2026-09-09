/**
 * Typed client for the backend's authenticated AI approval decision API (`POST
 * /api/ai/approvals/:approvalId/approve` and `/reject`).
 *
 * Mirrors the other authenticated AI clients: the bearer token is pulled from
 * the centralized session store at call time (`requireSessionToken`) —
 * components never pass or hold a token, and no unauthenticated request is
 * ever issued.
 *
 * Contract (backend, Phase 10.28D):
 *
 *   - A decision is explicit and terminal: `approve` → `status: "approved"`
 *     (the stored operation is NOT executed here — execution stays behind the
 *     approved-tool invocation of the agent runtime); `reject` → `status:
 *     "rejected"`.
 *   - Both are idempotent (a repeated decision returns the existing terminal
 *     record), ownership-scoped (a foreign/missing approval is a clean 404),
 *     and refuse an expired approval (400).
 *   - The response is the safe `AiToolApproval` projection — validated
 *     arguments and timestamps only, never raw file contents or secrets.
 */
import { apiRequest } from "./client";
import { requireSessionToken } from "../session";
import type { AiToolApproval } from "../../types/ai";

/**
 * The canonical resume instruction sent when an approval is approved (Phase
 * 10.30). Continuing an interrupted turn happens through the EXISTING `POST
 * /api/ai/instructions` endpoint with the owned `approvalId`; the backend
 * executes the approval's EXACT stored arguments — the frontend never supplies
 * tool arguments or runs a tool.
 */
export const RESUME_AFTER_APPROVAL_INSTRUCTION = "Continue after approval.";

/** Approve one owned pending approval (idempotent; 400 when expired). */
export async function approveAiApproval(approvalId: string): Promise<AiToolApproval> {
  const token = requireSessionToken();
  return apiRequest<AiToolApproval>(
    `/api/ai/approvals/${encodeURIComponent(approvalId)}/approve`,
    { method: "POST", token },
  );
}

/** Reject one owned pending approval (idempotent; 400 when expired). */
export async function rejectAiApproval(approvalId: string): Promise<AiToolApproval> {
  const token = requireSessionToken();
  return apiRequest<AiToolApproval>(
    `/api/ai/approvals/${encodeURIComponent(approvalId)}/reject`,
    { method: "POST", token },
  );
}