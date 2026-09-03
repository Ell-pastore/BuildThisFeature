/**
 * Authentication routes (Phase 7) — registration only.
 *
 * Thin: parse request → delegate to the service → respond. Other auth
 * endpoints (login, logout, /me) arrive in later steps.
 */
import { Hono } from "hono";
import { AppError } from "../core/errors.js";
import { registerUser } from "../services/auth.js";

export const authRoutes = new Hono().post("/register", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw AppError.badRequest("Request body must be valid JSON.");
  }

  if (typeof body !== "object" || body === null) {
    throw AppError.badRequest("Request body must be a JSON object.");
  }

  const { email, displayName, password } = body as Record<string, unknown>;
  const user = await registerUser({ email, displayName, password });
  return c.json({ user }, 201);
});