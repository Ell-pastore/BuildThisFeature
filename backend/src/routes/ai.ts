/**
 * AI routes (Phase 10.21 + 10.22 + 10.23) — authenticated application-level
 * AI APIs.
 *
 * `GET  /api/ai/status`                     — safe provider capability status.
 * `POST /api/ai/instructions`               — submit one instruction to the agent runtime.
 * `GET  /api/ai/conversations`              — list the user's conversations, newest-first.
 * `GET  /api/ai/conversations/:conversationId` — retrieve one owned conversation
 *                                              + its chronological transcript.
 *
 *   - All use the EXISTING per-route `requireAuth` middleware; unauthenticated
 *     requests receive the existing generic 401 `auth/unauthorized` envelope.
 *   - This is application-level AI access, NOT an admin endpoint: every
 *     authenticated user gets the same safe capabilities. The request body /
 *     headers / path params / user-supplied identity are never trusted — only
 *     the authenticated session user is consulted. `/instructions` rejects
 *     any body-supplied identity field; the history routes never read a user
 *     id from the request at all.
 *   - `/status` returns only safe, non-secret `AiRuntimeStatus`; it never
 *     performs network or health checks.
 *   - `/instructions` is a THIN wrapper: it parses JSON (malformed → 400) and
 *     delegates to the existing persistent agent-turn service, which owns the
 *     bounded loop, provider fallback/rotation/cooldown, conversation
 *     ownership, and the tool policy/`invokeTool()` pipeline.
 *   - The history endpoints are THIN wrappers around the Phase 10.23
 *     `aiConversations` service (which in turn only calls the existing Phase
 *     10.7 repository): ownership scoping, connection-id validation, safe
 *     structured projection, and the 404/400 envelopes all live there — no
 *     conversation/database logic is duplicated here.
 *   - Returned data is safe by construction: persisted transcript text and
 *     structured tool metadata (with exact `fileId`/`versionId` REFERENCES
 *     kept as references only) — never raw file contents, provider secrets,
 *     or internal paths.
 */
import { Hono } from "hono";
import { getCurrentUser, requireAuth } from "../core/auth.js";
import type { AppVariables } from "../core/auth.js";
import { AppError } from "../core/errors.js";
import { getAiRuntimeStatus } from "../services/aiStatus.js";
import { runAiInstruction } from "../services/aiInstructions.js";
import { getAiConversation, listAiConversations } from "../services/aiConversations.js";

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
  })
  .get("/conversations", requireAuth, async (c) => {
    // Identity comes EXCLUSIVELY from the authenticated session. The list
    // service scopes every read to this user; the request carries no identity.
    const user = getCurrentUser(c);
    return c.json(await listAiConversations(user.id), 200);
  })
  .get("/conversations/:conversationId", requireAuth, async (c) => {
    // Ownership is enforced server-side: the service reads the conversation
    // scoped to the session user, so a foreign conversation is
    // indistinguishable from a missing one (existing 404 envelope).
    const user = getCurrentUser(c);
    const conversationId = c.req.param("conversationId");
    return c.json(await getAiConversation(user.id, conversationId), 200);
  });