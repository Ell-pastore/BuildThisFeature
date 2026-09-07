/**
 * Session → Tool Execution Context bridge (Phase 9.7).
 *
 * Single integration point that converts the authenticated session
 * user (established by `requireAuth` in `core/auth.ts`) into a
 * `ToolExecutionContext` the tool layer can dispatch against.
 *
 * Flow:
 *
 *   Authenticated request
 *   → requireAuth middleware (Phase 7)
 *   → AuthUser on Hono context
 *   → createSessionExecutionContext(c)  ← THIS MODULE
 *   → ToolExecutionContext
 *   → dispatchTool() → policy → handler
 *
 * Trust model:
 *
 *   The identity fields (`userId`, `email`, `displayName`, `status`)
 *   come from the database via `requireAuth`. They are NOT read from
 *   the incoming request body. A caller cannot supply fake identity
 *   data through this function.
 */
import { getCurrentUser, type AuthUser } from "../core/auth.js";
import { createToolExecutionContext, type ToolExecutionContext } from "./policy.js";

/**
 * Convert the authenticated session user on the current Hono request
 * into a `ToolExecutionContext` suitable for `dispatchTool()`.
 *
 * Reads the `AuthUser` established by `requireAuth` (Phase 7) from
 * the Hono context. Throws `AppError.unauthorized()` if no session
 * is present (i.e. `requireAuth` was not applied or the token is
 * invalid).
 *
 * The resulting context carries the session identity as an `ai-agent`
 * actor. The policy layer (Phase 9.5) validates the identity at
 * dispatch time — inactive users are denied there.
 *
 * @param c — a Hono request context that has been through `requireAuth`.
 * @returns a `ToolExecutionContext` with the authenticated session identity.
 */
export function createSessionExecutionContext(
  c: { get: (key: string) => unknown },
): ToolExecutionContext {
  const user: AuthUser = getCurrentUser(c);
  return createToolExecutionContext(user);
}
