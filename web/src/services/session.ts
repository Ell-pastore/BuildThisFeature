/**
 * Frontend session store (Phase 10.32) — the single, centralized owner of the
 * authenticated bearer token for the desktop UI.
 *
 * Rules established for this foundation phase:
 *
 *   - The token lives ONLY in this module's memory. Nothing else in the app
 *     reads, stores, passes, or logs it: it is never put in component state,
 *     never put in URL/query parameters, and never persisted to
 *     localStorage/sessionStorage (no secure OS-backed credential vault
 *     exists in the surrounding Tauri architecture yet).
 *   - Authentication reuses ONLY the existing backend auth endpoints via the
 *     existing `authApi` abstraction (`login` / `me` / `logout`). No second
 *     authentication system is invented, and the backend stays authoritative
 *     for ownership/permission. This store only proves "this UI has an active
 *     session".
 *   - After a page reload the in-memory session is gone by design; the UI
 *     shows the sign-in state again rather than reconstructing a session
 *     without credentials.
 *
 * This module is framework-free so it can be unit-tested directly; the React
 * binding lives in `useSession.ts`.
 */
import { authApi, type SafeUserRemote } from "./api";

export interface SessionState {
  user: SafeUserRemote | null;
  token: string | null;
}

/** Thrown when a caller needs an authenticated session but none is active. */
export class SessionNotAuthenticatedError extends Error {
  readonly code = "auth/not-authenticated";
  constructor(message = "You must be signed in to view your conversations.") {
    super(message);
    this.name = "SessionNotAuthenticatedError";
  }
}

let currentState: SessionState = { user: null, token: null };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** React external-store subscription (from `useSession`). */
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot of the current session. Returns the same reference until mutated. */
export function getSessionSnapshot(): SessionState {
  return currentState;
}

/**
 * The raw token for API clients. Throws `SessionNotAuthenticatedError` when
 * there is no active session, so authenticated requests fail fast and cleanly
 * instead of firing unauthenticated requests.
 */
export function requireSessionToken(): string {
  if (currentState.token === null || currentState.user === null) {
    throw new SessionNotAuthenticatedError();
  }
  return currentState.token;
}

/**
 * Sign in through the existing backend login endpoint. On success the session
 * holds the returned token in memory only; the resolved user is returned so
 * callers can surface identity without ever handling the token.
 */
export async function login(email: string, password: string): Promise<SafeUserRemote> {
  const { token, user } = await authApi.login({ email, password });
  currentState = { user, token };
  emit();
  return user;
}

/**
 * End the local session. Best-effort revokes the session server-side via the
 * existing logout endpoint FIRST on the captured token, then clears in-memory
 * state regardless of the network result — the UI must never be stuck "logged
 * in" because a revoke request failed.
 */
export async function logout(): Promise<void> {
  const token = currentState.token;
  currentState = { user: null, token: null };
  emit();
  if (token !== null) {
    try {
      await authApi.logout(token);
    } catch {
      // Best-effort: the local session is already cleared. A failed revoke
      // must not throw into the UI.
    }
  }
}