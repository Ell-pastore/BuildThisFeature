/**
 * AI routes (Phase 10.21 + 10.22) — authenticated application-level AI APIs.
 *
 * `GET  /api/ai/status`         — safe provider capability status.
 * `POST /api/ai/instructions`   — submit one instruction to the agent runtime.
 *
 *   - Both use the EXISTING per-route `requireAuth` middleware; unauthenticated
 *     requests receive the existing generic 401 `auth/unauthorized` envelope.
 *   - This is application-level AI access, NOT an admin endpoint: every
 *     authenticated user gets the same safe capabilities. The request body /
 *     headers / user-supplied identity are never trusted — only the
 *     authenticated session user is consulted. `/instructions` strictly
 *     rejects any body-supplied identity field.
 *   - `/status` returns only safe, non-secret `AiRuntimeStatus`; it never
 *     performs network or health checks.
 *   - `/instructions` is a THIN wrapper: it parses JSON (malformed → 400) and
 *     delegates to the existing persistent agent-turn service, which owns the
 *     bounded loop, provider fallback/rotation/cooldown, conversation
 *     ownership, and the tool policy/`invokeTool()` pipeline. It returns the
 *     stable, typed `AiInstructionResponse` and maps known agent/provider
 *     errors into the existing JSON error envelope; unexpected errors are
 *     reduced by the global `internal/error` handler (nothing leaks).
 */
import { Hono } from "hono";
import { getCurrentUser, requireAuth } from "../core/auth.js";
import type { AppVariables } from "../core/auth.js";
import { AppError } from "../core/errors.js";
import { getAiRuntimeStatus } from "../services/aiStatus.js";
import { runAiInstruction } from "../services/aiInstructions.js";

export const aiRoutes = new Hono<AppVariables>()
  .get("/status", requireAuth, (c) => {
    // The authenticated identity is required (defense in depth on top of
    // requireAuth); the payload itself is identity-independent.
    getCurrentUser(c);
    return c.json(getAiRuntimeStatus(), 200);
  })
  .post("/instructions", requireAuth, async (c) => {
    // The authenticated identity is required and CONSULTED ONLY via the
    // session — a body-supplied user id is rejected by the service's strict
    // parser and is never passed to the agent runtime.
    getCurrentUser(c);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw AppError.badRequest("Request body must be valid JSON.");
    }

    return c.json(await runAiInstruction(c, raw), 200);
  });