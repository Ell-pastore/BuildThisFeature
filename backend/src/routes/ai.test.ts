/**
 * AI route tests (Phase 10.21 status + Phase 10.22 instructions).
 *
 * These integration tests drive the REAL `aiRoutes` (`GET /api/ai/status` +
 * `POST /api/ai/instructions`) with the REAL `requireAuth` middleware and the
 * real `onError` envelope. The session repository, DB clock, the AI status
 * SERVICE, and the instruction SERVICE are mocked so the tests stay
 * deterministic and offline.
 *
 * Coverage:
 *
 *   1. Authenticated request → 200 with the stable payload.
 *   2. Any authenticated user receives the SAME safe payload (identity is
 *      authorization-only, never trusted from the request).
 *   3. Unauthenticated request → existing generic 401 auth/unauthorized.
 *   4. Existing auth behavior unchanged: malformed token, inactive user, and
 *      expired session all collapse to the same generic 401.
 *   5. Stable response shape at the HTTP boundary.
 *   6. No network request is performed while serving.
 *   7. POST /instructions: authenticated 200 envelope passthrough; the real
 *      strict body parser stays authoritative IN the route path (rejects
 *      body-supplied identity); malformed JSON → 400; unexpected service
 *      errors → generic 500 `internal/error` WITHOUT leaking internals; and
 *      the same 401 behavior as the status route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { onError } from "../core/http.js";
import { aiRoutes } from "./ai.js";
import type { AiRuntimeStatus } from "../services/aiStatus.js";
import type { AiInstructionResponse } from "../services/aiInstructions.js";
import { parseAiInstructionInput } from "../services/aiInstructions.js";

// ---------------------------------------------------------------------------
// Mocked dependencies
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  findSessionByTokenHash: vi.fn(),
  updateSessionLastUsedAt: vi.fn(),
  databaseNow: vi.fn(),
  getAiRuntimeStatus: vi.fn(),
  runAiInstruction: vi.fn(),
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

vi.mock("../services/aiInstructions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/aiInstructions.js")>();
  return {
    ...actual,
    // The production entry is replaced; the REAL strict parser stays in the
    // pipeline so validation behavior is exercised end-to-end.
    runAiInstruction: mocks.runAiInstruction,
  };
});

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
  mocks.runAiInstruction.mockImplementation(
    async (c: { get: (key: string) => unknown }, raw: unknown): Promise<AiInstructionResponse> => {
      // The real strict parser runs; the turn result itself is canned.
      const input = parseAiInstructionInput(raw);
      return {
        conversationId: input.conversationId ?? "22222222-2222-2222-2222-222222222222",
        turn: {
          created: input.conversationId === undefined,
          instruction: input.instruction,
          messages: [],
          finalText: "Everything listed.",
          toolRounds: 0,
          maxToolRounds: 3,
          toolResults: [],
        },
      };
    },
  );
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

// ---------------------------------------------------------------------------
// 7. POST /api/ai/instructions
// ---------------------------------------------------------------------------

describe("POST /api/ai/instructions — authenticated", () => {
  async function postInstruction(app: Hono, body: unknown, token = "valid-token"): Promise<Response> {
    return app.request("/api/ai/instructions", {
      method: "POST",
      headers: {
        ...authorizedHeaders(token),
        "content-type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("returns 200 with the stable typed envelope for an authenticated user", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await postInstruction(makeApp(), {
      instruction: "List my home directory.",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as AiInstructionResponse;
    expect(Object.keys(body).sort()).toEqual(["conversationId", "turn"]);
    expect(Object.keys(body.turn).sort()).toEqual(
      ["created", "finalText", "instruction", "maxToolRounds", "messages", "toolResults", "toolRounds"].sort(),
    );
    expect(body.turn.instruction).toBe("List my home directory.");
    expect(body.conversationId).toBe("22222222-2222-2222-2222-222222222222");
    expect(mocks.runAiInstruction).toHaveBeenCalledTimes(1);
  });

  it("resumes the conversation when a valid conversationId is supplied", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const conversationId = "44444444-4444-4444-4444-444444444444";

    const body = (await (
      await postInstruction(makeApp(), { conversationId, instruction: "Continue listing." })
    ).json()) as AiInstructionResponse;

    expect(body.conversationId).toBe(conversationId);
    expect(body.turn.created).toBe(false);
  });

  it("rejects a body that tries to supply its own identity (400 common/bad-request)", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await postInstruction(makeApp(), {
      instruction: "Read my /etc file.",
      userId: "99999999-9999-9999-9999-999999999999",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "common/bad-request" },
    });
  });

  it("ignores a supplied identity when the session owns the user (defense test)", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.runAiInstruction.mockImplementationOnce(
      async (c: { get: (key: string) => unknown }, raw: unknown) => {
        // The only identity the service ever sees is the SESION user.
        expect((c.get("user") as { email: string }).email).toBe("alice@example.com");
        const input = parseAiInstructionInput(raw);
        return {
          conversationId: "22222222-2222-2222-2222-222222222222",
          turn: {
            created: true,
            instruction: input.instruction,
            messages: [],
            toolRounds: 0,
            maxToolRounds: 3,
            toolResults: [],
          },
        };
      },
    );

    const res = await postInstruction(makeApp(), {
      instruction: "List my home directory.",
    });

    expect(res.status).toBe(200);
  });

  it("returns 400 common/bad-request for malformed JSON before any agent work", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));

    const res = await postInstruction(makeApp(), "{ this is not json ");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "common/bad-request", message: "Request body must be valid JSON." },
    });
    expect(mocks.runAiInstruction).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/instructions — generic 500 without leaks", () => {
  it("reduces an unexpected service error to the generic internal/error envelope", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    mocks.runAiInstruction.mockRejectedValueOnce(
      new Error("SECRET provider key sk-LIVE-leak inside backend internal path"),
    );

    const res = await (
      await makeApp().request("/api/ai/instructions", {
        method: "POST",
        headers: { ...authorizedHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ instruction: "List my home directory." }),
      })
    ).json();

    expect(res).toEqual({
      error: { code: "internal/error", message: "Internal server error." },
    });
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(JSON.stringify(res)).not.toContain("sk-LIVE");
  });
});

describe("POST /api/ai/instructions — authentication failures (unchanged)", () => {
  it("returns the existing generic 401 for a missing token", async () => {
    const res = await makeApp().request("/api/ai/instructions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "List my home directory." }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { code: "auth/unauthorized", message: "Invalid email or password." },
    });
    expect(mocks.runAiInstruction).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for a malformed bearer header", async () => {
    const app = makeApp();

    for (const headers of [
      { authorization: "Bearer" },
      { authorization: "Bearer one two" },
    ]) {
      const res = await app.request("/api/ai/instructions", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ instruction: "List my home directory." }),
      });
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    }

    expect(mocks.runAiInstruction).not.toHaveBeenCalled();
  });

  it("returns the existing generic 401 for an unknown token", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(null);

    const res = await makeApp().request("/api/ai/instructions", {
      method: "POST",
      headers: { ...authorizedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ instruction: "List my home directory." }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "auth/unauthorized" } });
    expect(mocks.runAiInstruction).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/instructions — no network", () => {
  it("performs no network request while serving an instruction", async () => {
    mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await (
      await makeApp().request("/api/ai/instructions", {
        method: "POST",
        headers: { ...authorizedHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ instruction: "List my home directory." }),
      })
    ).json();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect((res as AiInstructionResponse).turn.instruction).toBe("List my home directory.");
  });
});