/**
 * AI route (Phase 10.21) — authenticated application-level AI runtime status.
 *
 * `GET /api/ai/status`
 *
 *   - Uses the EXISTING per-route `requireAuth` middleware; unauthenticated
 *     requests get the existing generic 401 `auth/unauthorized` envelope.
 *   - This is application-level runtime status, NOT an admin endpoint: every
 *     authenticated user receives the same safe provider capability
 *     information. The request body / headers / user-supplied identity are
 *     never trusted — only the authenticated session user is consulted.
 *   - Returns ONLY the safe, non-secret `AiRuntimeStatus` payload derived
 *     from the provider configuration diagnostics source. No credential
 *     values, credential handles, base URLs, env values, or network/health
 *     checks.
 */
import { Hono } from "hono";
import { getCurrentUser, requireAuth } from "../core/auth.js";
import type { AppVariables } from "../core/auth.js";
import { getAiRuntimeStatus } from "../services/aiStatus.js";

export const aiRoutes = new Hono<AppVariables>().get(
  "/status",
  requireAuth,
  (c) => {
    // The authenticated identity is required (defense in depth on top of
    // requireAuth) and is used ONLY to authorize the request — the payload
    // itself is identity-independent safe provider capability status.
    getCurrentUser(c);
    return c.json(getAiRuntimeStatus(), 200);
  },
);