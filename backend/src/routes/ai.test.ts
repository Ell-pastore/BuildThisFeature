/**
 * AI status route tests (Phase 10.21).
 *
 * These integration tests drive the REAL `aiRoutes` (`GET /api/ai/status`)
 * with the REAL `requireAuth` middleware and the real `onError` envelope.
 * The session repository, DB clock, and the AI status SERVICE are mocked so
 * the tests stay deterministic and offline.
 *
 * Coverage:
 *
 *   1. Authenticated request → 200 with the stable status payload.
 *   2. Any authenticated user receives the SAME safe payload (identity is
 *      authorization-only, never trusted from the request).
 *   3. Unauthenticated request → existing generic 401 auth/unauthorized.
 *   4. Existing auth behavior unchanged: malformed token, inactive user, and
 *      expired session all collapse to the same generic 401.
 *   5. Stable response shape at the HTTP boundary.
 *   6. No network request is performed while serving status.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { onError } from "../core/http.js";
import { aiRoutes } from "./ai.js";
import type { AiRuntimeStatus } from "../services/aiStatus.js";

// ---------------------------------------------------------------------------
// Mocked dependencies
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  findSessionByTokenHash: vi.fn(),
  updateSessionLastUsedAt: vi.fn(),
  databaseNow: vi.fn(),
  getAiRuntimeStatus: vi.fn(),
}));

vi.mock("../database/repositories/sessions.js", () => ({
  createSession: vi.fn(),
  findSessionByTokenHash: mocks.findSessionByTokenHash,
  updateSessionLastUsedAt: mocks.updateSessionLastUsedAt,
  deleteSessionByTokenHash: vi.fn(),
}));

vi.mock("../database/client.js", () => ({
  databaseNow: mocks.databaseNow,
}));

vi.mock("../services/aiStatus.js", () => ({
  getAiRuntimeStatus: mocks.getAiRuntimeStatus,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};

const OTHER_ACTIVE_USER = {
  id: "33333333-3333-3333-3333-333333333333",
  email: "carol@example.com",
  displayName: "Carol Example",
  status: "active",
};

const PENDING_USER = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "bob@example.com",
  displayName: "Bob Example",
  status: "pending",
};

function sessionFor(user: { id: string; email: string; displayName: string; status: string }): unknown {
  return {
    id: "session-1",
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    user,
  };
}

const CANNED_STATUS: AiRuntimeStatus = {
  status: "ok",
  providers: [
    {
      provider: "grok",
      order: 0,
      enabled: true,
      validationStatus: "valid",
      model: "grok-3",
      credentialCount: 2,
      credentialFree: false,
      issues: [],
    },
    {
      provider: "ollama",
      order: 1,
      enabled: true,
      validationStatus: "valid",
      model: "qwen3",
      credentialCount: 0,
      credentialFree: true,
      issues: [],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateSessionLastUsedAt.mockResolvedValue(undefined);
  mocks.databaseNow.mockResolvedValue(new Date("2026-01-01T00:00:00Z"));
  mocks.getAiRuntimeStatus.mockReturnValue(CANNED_STATUS);
});

/** Mount the REAL aiRoutes (as under `/api/ai`) + auth + error envelope. */
function makeApp(): Hono {
  const app = new Hono();
  app.onError(onError);
  app.route("/api/ai", aiRoutes);
  return app;
}

function authorizedHeaders(token = "valid-token"): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// 1 & 2. Authenticated access
// ---------------------------------------------------------------------------

describe("GET /api/ai/status — authenticated", () => {
  it("returns 200 with the stable status payload for an authenticated user", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await makeApp().request("/api/ai/status", {
      method: "GET",
      headers: authorizedHeaders(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(CANNED_STATUS);
    expect(mocks.getAiRuntimeStatus).toHaveBeenCalledTimes(1);
  });

  it("gives every authenticated user the same safe payload", async () => {
    mocks.findSessionByTokenHash.mockResolvedValueOnce(sessionFor(ACTIVE_USER));
    mocks.findSessionByTokenHash.mockResolvedValueOnce(sessionFor(OTHER_ACTIVE_USER));

    const app = makeApp();
    const first = await (await app.request("/api/ai/status", { headers: authorizedHeaders("a") })).json();
    const second = await (await app.request("/api/ai/status", { headers: authorizedHeaders("b") })).json();

    expect(second).toEqual(first);
    // The payload is identity-independent: it never echoes the session user.
    expect(JSON.stringify(first)).not.toContain(ACTIVE_USER.id);
    expect(JSON.stringify(first)).not.toContain(OTHER_ACTIVE_USER.id);
    expect(JSON.stringify(first)).not.toContain("alice@example.com");
    expect(JSON.stringify(first)).not.toContain("carol@example.com");
  });

  it("returns a stable, explicitly typed response shape", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const body = (await (await makeApp().request("/api/ai/status", { headers: authorizedHeaders() })).json()) as AiRuntimeStatus;

    expect(Object.keys(body).sort()).toEqual(["providers", "status"]);
    expect(body.providers).toHaveLength(2);
    for (const provider of body.providers) {
      expect(typeof provider.provider).toBe("string");
      expect(Number.isInteger(provider.order)).toBe(true);
      expect(typeof provider.enabled).toBe("boolean");
      expect(["valid", "disabled"]).toContain(provider.validationStatus);
      expect(typeof provider.credentialCount).toBe("number");
      expect(typeof provider.credentialFree).toBe("boolean");
      expect(Array.isArray(provider.issues)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. Existing auth behavior unchanged (generic 401)
// ---------------------------------------------------------------------------

describe("GET /api/ai/status — authentication failures", () => {
  it("returns the existing generic 401 for a missing token", async () => {
    const res = await makeApp().request("/api/ai/status", { method: "GET" });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { code: "auth/unauthorized", message: "Invalid email or password." },
    });
    expect(mocks.getAiRuntimeStatus).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for a malformed bearer header", async () => {
    const app = makeApp();

    for (const headers of [
      { authorization: "Basic abc123" },
      { authorization: "Bearer" },
      { authorization: "Bearer one two" },
    ]) {
      const res = await app.request("/api/ai/status", { headers });
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "auth/unauthorized" },
      });
    }

    expect(mocks.getAiRuntimeStatus).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for an inactive user", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(PENDING_USER));

    const res = await makeApp().request("/api/ai/status", { headers: authorizedHeaders() });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    expect(mocks.getAiRuntimeStatus).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for an expired session", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue({
      id: "session-expired",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      user: ACTIVE_USER,
    });

    const res = await makeApp().request("/api/ai/status", { headers: authorizedHeaders() });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    expect(mocks.getAiRuntimeStatus).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for an unknown token", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(null);

    const res = await makeApp().request("/api/ai/status", { headers: authorizedHeaders() });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    expect(mocks.getAiRuntimeStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. No network
// ---------------------------------------------------------------------------

describe("GET /api/ai/status — no network", () => {
  it("performs no network request while serving status", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await makeApp().request("/api/ai/status", { headers: authorizedHeaders() });

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
  });
});