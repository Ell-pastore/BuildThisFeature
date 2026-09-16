/**
 * Production AI instruction runtime assembly tests (Phase 10.38).
 *
 * These tests drive the REAL production composition (`composeProductionAiRuntime`)
 * and the REAL startup binding seam (`bindProductionAiInstructionRuntime`):
 *
 *   1. The production runtime is assembled from the configured provider stack,
 *      the registered read+write tool surface, and a filesystem executor.
 *   2. Binding a runtime OWNS the `POST /api/ai/instructions` entry — once
 *      bound, the existing 503 "filesystem executor not configured" condition
 *      no longer occurs.
 *   3. Provider misconfiguration FAILS LOUDLY at startup: a
 *      `ProviderCompositionError` propagates synchronously out of the
 *      composition and out of `createApp()` — it is never swallowed into a
 *      silent 503.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import { AppError } from "../core/errors.js";
import {
  bindAiInstructionFilesystem,
  bindAiInstructionRuntime,
  runAiInstruction,
} from "./aiInstructions.js";
import {
  createConversationState,
  finalizeConversation,
} from "./conversation.js";
import {
  bindProductionAiInstructionRuntime,
  composeProductionAiRuntime,
  PRODUCTION_AI_MAX_TOOL_ROUNDS,
} from "./productionAiRuntime.js";
import { ProviderId } from "./providerSelection.js";
import {
  composeProviderStack,
  ProviderCompositionError,
} from "./providerComposition.js";
import type { ComposedProviderStack } from "./providerComposition.js";
import type { PersistentAgentTurnRuntime, PersistentTurnResult } from "./persistentAgentTurn.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { AgentProvider } from "./provider.js";

// ---------------------------------------------------------------------------
// Composition failure seam (deterministic, env-independent)
// ---------------------------------------------------------------------------

const compositionFailures = vi.hoisted(() => ({
  composeDefaultProviderStack: vi.fn(),
}));

vi.mock("./providerComposition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providerComposition.js")>();
  return {
    ...actual,
    // Only the DEFAULT composition is overridable in tests; the explicit
    // `composeProviderStack` path stays REAL.
    composeDefaultProviderStack: compositionFailures.composeDefaultProviderStack,
  };
});

// ---------------------------------------------------------------------------
// Repository seam for the phase 10.40 wire-through tests (the production
// resolver is exercised through the REAL persistent-agent-turn pipeline).
// ---------------------------------------------------------------------------

const repoMocks = vi.hoisted(() => ({
  loadAgentConversationState: vi.fn(),
  loadAgentConversationMessages: vi.fn(),
  persistAgentTurn: vi.fn(),
  beginAgentTurn: vi.fn(),
  appendAgentTurnRoundMessage: vi.fn(),
  completeAgentTurn: vi.fn(),
  cancelAgentTurn: vi.fn(),
}));

vi.mock("../database/repositories/agentConversations.js", () => ({
  loadAgentConversationState: repoMocks.loadAgentConversationState,
  loadAgentConversationMessages: repoMocks.loadAgentConversationMessages,
  persistAgentTurn: repoMocks.persistAgentTurn,
  beginAgentTurn: repoMocks.beginAgentTurn,
  appendAgentTurnRoundMessage: repoMocks.appendAgentTurnRoundMessage,
  completeAgentTurn: repoMocks.completeAgentTurn,
  cancelAgentTurn: repoMocks.cancelAgentTurn,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";

const ACTIVE_USER = {
  id: USER_ID,
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};

const VALID_INSTRUCTION = "List my home directory.";

function sessionContext(user: unknown = ACTIVE_USER): { get: (key: string) => unknown } {
  return { get: (key) => (key === "user" ? user : undefined) };
}

/** A scripted, credential-free composed stack (no env keys needed). */
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
      throw new Error("not used in this test");
    },
    async readFile() {
      throw new Error("not used in this test");
    },
    async moveFile() {
      throw new Error("not used in this test");
    },
    async copyFile() {
      throw new Error("not used in this test");
    },
  };
}

function makeResult(): PersistentTurnResult {
  let state = createConversationState({
    instruction: VALID_INSTRUCTION,
    maxToolRounds: 3,
  });
  state = finalizeConversation(state, "Everything listed.");
  return {
    conversationId: CONVERSATION_ID,
    created: true,
    state,
    pendingApprovals: [],
    pendingExecutions: [],
  };
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  bindAiInstructionRuntime(undefined);
  bindAiInstructionFilesystem(undefined);
  compositionFailures.composeDefaultProviderStack.mockReset();
});

afterEach(() => {
  bindAiInstructionRuntime(undefined);
  bindAiInstructionFilesystem(undefined);
});

describe("composeProductionAiRuntime (Phase 10.38)", () => {
  it("assembles a persistent agent-turn runtime from the stack + tool surface + filesystem", () => {
    const generate = vi.fn<AgentProvider["generate"]>();
    const stack = makeStack(generate);
    const filesystem = makeFilesystem();

    const runtime = composeProductionAiRuntime({ stack, filesystem });

    expect(runtime).toBeDefined();
    expect(typeof runtime.run).toBe("function");
  });

  it("fails LOUDLY on provider misconfiguration instead of swallowing it", () => {
    const misconfig = new ProviderCompositionError(
      "provider-composition/missing-credentials",
      "Provider \"grok\" requires at least one credential.",
      "grok",
    );
    compositionFailures.composeDefaultProviderStack.mockImplementation(() => {
      throw misconfig;
    });

    // Synchronous rethrow: startup is loud, never a silent 503.
    expect(() => composeProductionAiRuntime()).toThrow(misconfig);
  });
});

describe("bindProductionAiInstructionRuntime (Phase 10.38)", () => {
  it("binds the pre-composed production runtime and returns the same instance", () => {
    const generate = vi.fn<AgentProvider["generate"]>();
    const runtime = composeProductionAiRuntime({
      stack: makeStack(generate),
      filesystem: makeFilesystem(),
    });

    expect(bindProductionAiInstructionRuntime(runtime)).toBe(runtime);
  });

  it("runs instructions through the bound runtime — the 503 filesystem-executor condition no longer occurs", async () => {
    const run = vi.fn().mockResolvedValue(makeResult());
    const runtime: PersistentAgentTurnRuntime = { run };
    bindProductionAiInstructionRuntime(runtime);

    const response = await runAiInstruction(sessionContext(), {
      instruction: VALID_INSTRUCTION,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(response.conversationId).toBe(CONVERSATION_ID);
  });

  it("keeps the existing 503 common/not-configured when NO runtime is bound (guard intact)", async () => {
    await expect(
      runAiInstruction(sessionContext(), { instruction: VALID_INSTRUCTION }),
    ).rejects.toMatchObject({
      status: 503,
      code: "common/not-configured",
      message: expect.stringContaining("filesystem executor"),
    });
  });
});

describe("createApp startup binding (Phase 10.38)", () => {
  it("fails startup loudly on provider misconfiguration (no options swallowed)", () => {
    const misconfig = new ProviderCompositionError(
      "provider-composition/missing-credentials",
      "Provider \"grok\" requires at least one credential.",
      "grok",
    );
    compositionFailures.composeDefaultProviderStack.mockImplementation(() => {
      throw misconfig;
    });

    expect(() => createApp()).toThrow(misconfig);
  });

  it("accepts an injected runtime so the app can be built without composing", () => {
    const run = vi.fn().mockResolvedValue(makeResult());
    const runtime: PersistentAgentTurnRuntime = { run };

    const app = createApp({ aiRuntime: runtime });

    expect(app).toBeDefined();
    expect(typeof app.request).toBe("function");
  });
});

describe("production runtime — per-request AI Quality bound (Phase 10.40)", () => {
  beforeEach(() => {
    bindAiInstructionRuntime(undefined);
    bindAiInstructionFilesystem(undefined);
    repoMocks.loadAgentConversationState.mockReset();
    repoMocks.loadAgentConversationMessages.mockReset();
    repoMocks.persistAgentTurn.mockReset().mockResolvedValue({ id: "conv-1", created: true });
    repoMocks.beginAgentTurn.mockReset().mockResolvedValue({
      conversationId: "conv-1",
      created: true,
      instructionMessageId: "inst-1",
      messageId: "msg-r1",
    });
    repoMocks.appendAgentTurnRoundMessage.mockReset().mockResolvedValue({ messageId: "msg-r2" });
    repoMocks.completeAgentTurn.mockReset().mockResolvedValue(undefined);
    repoMocks.cancelAgentTurn.mockReset().mockResolvedValue(undefined);
  });

  it("maps the request's AI Quality tier to the bound of a NEW conversation", async () => {
    const generate = vi
      .fn<AgentProvider["generate"]>()
      .mockResolvedValueOnce({ text: "Everything listed." });
    const runtime = composeProductionAiRuntime({
      stack: makeStack(generate),
      filesystem: makeFilesystem(),
    });

    const result = await runtime.run(
      {
        get: (key) =>
          key === "aiQuality" ? "high" : key === "user" ? ACTIVE_USER : undefined,
      },
      { instruction: VALID_INSTRUCTION },
    );

    expect(result.state.maxToolRounds).toBe(8);
    expect(repoMocks.persistAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ maxToolRounds: 8 }),
    );
  });

  it("fails closed to the default bound when no tier is present on the request", async () => {
    const generate = vi
      .fn<AgentProvider["generate"]>()
      .mockResolvedValueOnce({ text: "Everything listed." });
    const runtime = composeProductionAiRuntime({
      stack: makeStack(generate),
      filesystem: makeFilesystem(),
    });

    const result = await runtime.run(sessionContext(ACTIVE_USER), {
      instruction: VALID_INSTRUCTION,
    });

    // The no-override default is 5 tool rounds (Phase B regression lock):
    // a raised default must not fall back to the previous cap of 3.
    expect(PRODUCTION_AI_MAX_TOOL_ROUNDS).toBe(5);
    expect(result.state.maxToolRounds).toBe(5);
    expect(repoMocks.persistAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        maxToolRounds: 5,
      }),
    );
  });
});