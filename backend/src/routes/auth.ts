/**
 * Authentication routes (Phase 7) — registration and login only.
 *
 * Thin: parse request → delegate to the service → respond. Other auth
 * endpoints (logout, /me) arrive in later steps.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { AppError } from "../core/errors.js";
import { getCurrentUser, type AppVariables, requireAuth } from "../core/auth.js";
import { loginUser, registerUser } from "../services/auth.js";

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw AppError.badRequest("Request body must be valid JSON.");
  }
}

/** Auth router typed so requireAuth's `c.set("user")` is known to /me. */
export const authRoutes = new Hono<AppVariables>()
  .post("/register", async (c) => {
    const body: unknown = await readJsonBody(c);
    if (typeof body !== "object" || body === null) {
      throw AppError.badRequest("Request body must be a JSON object.");
    }
    const { email, displayName, password } = body as Record<string, unknown>;
    const user = await registerUser({ email, displayName, password });
    return c.json({ user }, 201);
  })
  .post("/login", async (c) => {
    const body: unknown = await readJsonBody(c);
    if (typeof body !== "object" || body === null) {
      throw AppError.badRequest("Request body must be a JSON object.");
    }
    const { email, password } = body as Record<string, unknown>;
    const userAgent = c.req.header("user-agent") ?? null;
    const { user, token } = await loginUser({ email, password, userAgent });
    return c.json({ user, token }, 200);
  })
  .get("/me", requireAuth, (c) => c.json({ user: getCurrentUser(c) }, 200));