/**
 * Application startup binding regression tests (Phase 10.38).
 *
 * Drive the REAL `createApp()` through a REAL HTTP request to prove the
 * production AI instruction runtime is bound at startup — and that the old
 * 503 "filesystem executor not configured" condition no longer occurs when
 * the runtime is correctly configured.
 *
 * The app wiring, the createApp binding seam, the auth middleware, the Hono
 * route, the strict body parser, and the `/api/ai/instructions` handler all
 * run for real. The ONLY seam replaced is the scripted persistent turn runtime
 * (injected via `createApp({ aiRuntime })`) — the same composition order a
 * production `createApp()` exercises, minus live provider/filesystem I/O. This
 * is the smallest offline slice that proves "createApp has a bound AI runtime".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import type { PersistentAgentTurnRuntime, PersistentTurnResult } from "./services/persistentAgentTurn.js";
import {
  createConversationState,
  finalizeConversation,
} from "./services/conversation.js";
import { composeProductionAiRuntime } from "./services/productionAiRuntime.js";
import { composeProviderStack } from "./services/providerComposition.js";
import type { ComposedProviderStack } from "./services/providerComposition.js";
import { ProviderId } from "./services/providerSelection.js";
import type { AgentProvider } from "./services/provider.js";
import type { FilesystemExecutor } from "./tools/executor.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};

const VALID_INSTRUCTION = "List my home directory.";

function sessionFor(user: { id: string; email: string; displayName: string; status: string }): unknown {
  return {
    id: "session-1",
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    user,
  };
}

function makeResult(): PersistentTurnResult {
  let state = createConversationState({
    instruction: VALID_INSTRUCTION,
    maxToolRounds: 3,
  });
  state = finalizeConversation(state, "Everything listed.");
  return {
    conversationId: "22222222-2222-2222-2222-222222222222",
    created: true,
    state,
    pendingApprovals: [],
    pendingExecutions: [],
  };
}

function authorizedHeaders(token = "valid-token"): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * A credential-free composed stack (uses Ollama — no keys needed for tests).
 */
function makeStack(generate: AgentProvider["generate"]): ComposedProviderStack {
  return composeProviderStack({
    chain: [ProviderId.Ollama],
    settings: {
      [ProviderId.Ollama]: {
        model: "qwen3",
        baseUrl: "http://localhost:11434/api",
        timeoutMs: 5_000,
      },
    },
    credentials: {},
    adapterFactory: () => ({ generate }),
  });
}

/** A recording fake executor that never touches Tauri/Rust. */
function makeFilesystem(): FilesystemExecutor {
  return {
    async listDirectory(path: string) {
      return { path, parentPath: null, isHome: false, items: [] };
    },
    async searchFiles() {
      return [];
    },
    async getFileMetadata() {
      throw new Error("not used");
    },
    async readFile() {
      throw new Error("not used");
    },
    async moveFile() {
      throw new Error("not used");
    },
  };
}

// ---------------------------------------------------------------------------
// Mocks: auth + persistence stay offline; the composition is real
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  findSessionByTokenHash: vi.fn(),
  updateSessionLastUsedAt: vi.fn(),
  databaseNow: vi.fn(),
  loadAgentConversationState: vi.fn(),
  persistAgentTurn: vi.fn(),
  beginAgentTurn: vi.fn(),
  appendAgentTurnRoundMessage: vi.fn(),
  completeAgentTurn: vi.fn(),
  cancelAgentTurn: vi.fn(),
}));

vi.mock("./database/repositories/sessions.js", () => ({
  createSession: vi.fn(),
  findSessionByTokenHash: mocks.findSessionByTokenHash,
  updateSessionLastUsedAt: mocks.updateSessionLastUsedAt,
  deleteSessionByTokenHash: vi.fn(),
}));

vi.mock("./database/client.js", () => ({
  databaseNow: mocks.databaseNow,
}));

vi.mock("./database/repositories/agentConversations.js", () => ({
  loadAgentConversationState: mocks.loadAgentConversationState,
  persistAgentTurn: mocks.persistAgentTurn,
  beginAgentTurn: mocks.beginAgentTurn,
  appendAgentTurnRoundMessage: mocks.appendAgentTurnRoundMessage,
  completeAgentTurn: mocks.completeAgentTurn,
  cancelAgentTurn: mocks.cancelAgentTurn,
  AgentConversationNotFoundError: class AgentConversationNotFoundError extends Error {
    readonly code = "agent-conversation/not-found-or-not-owned";
    constructor() {
      super("Agent conversation not found for this user.");
      this.name = "AgentConversationNotFoundError";
    }
  },
}));

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSessionByTokenHash.mockReset();
  mocks.updateSessionLastUsedAt.mockResolvedValue(undefined);
  mocks.databaseNow.mockResolvedValue(new Date("2026-01-01T00:00:00Z"));
  mocks.findSessionByTokenHash.mockResolvedValue(sessionFor(ACTIVE_USER));
  mocks.persistAgentTurn.mockResolvedValue({ id: "conv-app", created: true });
});

describe("createApp — bound production AI runtime (Phase 10.38)", () => {
  it("serves an authenticated instruction through the runtime bound at startup", async () => {
    const run = vi.fn().mockResolvedValue(makeResult());
    const runtime: PersistentAgentTurnRuntime = { run };

    const app = createApp({ aiRuntime: runtime });

    const res = await app.request("/api/ai/instructions", {
      method: "POST",
      headers: { ...authorizedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ instruction: VALID_INSTRUCTION }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversationId: string;
      turn: { finalText: string; instruction: string };
    };
    expect(body.conversationId).toBe("22222222-2222-2222-2222-222222222222");
    expect(body.turn.finalText).toBe("Everything listed.");
    expect(body.turn.instruction).toBe(VALID_INSTRUCTION);
    // The bound runtime was consulted — the entry is owned by the startup
    // binding, not a lazily reconstructed default.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not reproduce the 503 filesystem-executor error when the runtime is configured", async () => {
    const run = vi.fn().mockResolvedValue(makeResult());
    const app = createApp({ aiRuntime: { run } });

    const res = await app.request("/api/ai/instructions", {
      method: "POST",
      headers: { ...authorizedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ instruction: VALID_INSTRUCTION }),
    });

    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(200);
    expect(body.error?.code).toBeUndefined();
  });

  it("binds a real composed production runtime via HTTP (proves startup binding reaches the route)", async () => {
    const generate = vi.fn<AgentProvider["generate"]>().mockResolvedValue({ text: "All done." });
    const stack = makeStack(generate);
    const runtime = composeProductionAiRuntime({ stack, filesystem: makeFilesystem() });

    const app = createApp({ aiRuntime: runtime });

    const res = await app.request("/api/ai/instructions", {
      method: "POST",
      headers: { ...authorizedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ instruction: VALID_INSTRUCTION }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversationId: string;
      turn: { finalText: string };
    };
    expect(body.turn.finalText).toBe("All done.");
    // The production binding was used — no lazy "filesystem executor" path.
    expect(generate).toHaveBeenCalledTimes(1);
  });
});