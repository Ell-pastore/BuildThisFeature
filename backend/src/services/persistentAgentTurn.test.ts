/**
 * Persistent agent turn orchestration tests (Phase 10.8).
 *
 * The repository persistence functions are mocked; everything else is real:
 * the Phase 10.5 auth/context builder, the Phase 10.4 bounded loop with a
 * scripted FAKE provider (no real AI, no keys, no network), the Phase 10.6
 * state transitions, and the tool policy / `invokeTool()` pipeline.
 *
 * Coverage:
 *
 *   1. Create: a new conversation is created for the authenticated user, the
 *      loop runs, and the full turn (instruction → rounds → final) is
 *      persisted atomically.
 *   2. Resume: an owned conversation is loaded, its round bound is inherited,
 *      and the new turn appends to it (created = false).
 *   3. Successful tool loop: per-round transcript is recorded and persisted.
 *   4. Final response: a text-only turn persists the instruction + final.
 *   5. Ownership denial: a foreign/missing conversation (load → null) throws
 *      `AgentConversationNotFoundError` before anything runs or persists.
 *   6. Provider failure: nothing is persisted for the failed turn.
 *   7. No final text / auth denial: reject before persisting anything.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { AppError } from "../core/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerReadTools, readToolDefinitions } from "../tools/definitions/readTools.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { DirectoryListing } from "../tools/tauriShapes.js";
import type { AgentToolCall } from "./agent.js";
import type { AgentProvider, AgentProviderRequest, AgentResponse } from "./provider.js";
import { ProviderError, ProviderErrorCode } from "./provider.js";
import {
  AgentConversationNotFoundError,
} from "../database/repositories/agentConversations.js";
import {
  createConversationState,
  finalizeConversation,
} from "./conversation.js";
import { runPersistentTurn, type PersistentTurnOptions } from "./persistentAgentTurn.js";

const mocks = vi.hoisted(() => ({
  loadAgentConversationState: vi.fn(),
  persistAgentTurn: vi.fn(),
}));

vi.mock("../database/repositories/agentConversations.js", () => ({
  loadAgentConversationState: mocks.loadAgentConversationState,
  persistAgentTurn: mocks.persistAgentTurn,
  AgentConversationNotFoundError: class AgentConversationNotFoundError extends Error {
    readonly code = "agent-conversation/not-found-or-not-owned";
    constructor() {
      super("Agent conversation not found for this user.");
      this.name = "AgentConversationNotFoundError";
    }
  },
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
const USER_ID = ACTIVE_USER.id;

function sessionContext(user: unknown): { get: (key: string) => unknown } {
  return { get: (key) => (key === "user" ? user : undefined) };
}

function makeFilesystem(): FilesystemExecutor {
  return {
    async listDirectory(path: string): Promise<DirectoryListing> {
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
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerReadTools(registry);
  return registry;
}

type Generate = AgentProvider["generate"];

function scriptedProvider(
  responses: Array<AgentResponse | ProviderError>,
): { generate: Mock<Generate>; requests: AgentProviderRequest[] } {
  const requests: AgentProviderRequest[] = [];
  const generate = vi.fn<Generate>().mockImplementation(async (request) => {
    requests.push(request);
    const response = responses[requests.length - 1];
    if (response === undefined) {
      throw new Error("fake provider script exhausted");
    }
    if (response instanceof ProviderError) throw response;
    return response;
  });
  return { generate, requests };
}

function makeOptions(
  provider: AgentProvider,
  override?: { registry?: ToolRegistry; maxToolRounds?: number },
): PersistentTurnOptions {
  return {
    provider,
    tools: readToolDefinitions,
    registry: override?.registry ?? makeRegistry(),
    filesystem: makeFilesystem(),
    maxToolRounds: override?.maxToolRounds,
  };
}

function call(id: string, toolName: string, input: Record<string, unknown>): AgentToolCall {
  return { id, toolName, input };
}

function homeListing(path = "/home"): DirectoryListing {
  return { path, parentPath: null, isHome: false, items: [] };
}

function expectComplete(state: { finalText?: string; toolRounds: number }) {
  expect(state.finalText).toBeDefined();
  expect(state.toolRounds).toBeGreaterThanOrEqual(0);
}

// ---------------------------------------------------------------------------
// 1. Create a new conversation
// ---------------------------------------------------------------------------

describe("runPersistentTurn — create", () => {
  beforeEach(() => {
    mocks.persistAgentTurn.mockReset().mockResolvedValue({ id: "conv-1", created: true });
  });

  it("creates a conversation, runs the loop, and persists the whole turn", async () => {
    const { generate, requests } = scriptedProvider([
      { toolCalls: [call("c1", "list_directory", { path: "/home" })] },
      { text: "Everything listed." },
    ]);

    const result = await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { instruction: "List my files.", title: "Listing turn" },
      makeOptions({ generate }, { maxToolRounds: 2 }),
    );

    expect(result.conversationId).toBe("conv-1");
    expect(result.created).toBe(true);
    expectComplete(result.state);
    expect(result.state.instruction).toBe("List my files.");
    expect(result.state.finalText).toBe("Everything listed.");
    expect(result.state.toolRounds).toBe(1);
    expect(result.state.toolResults).toEqual([{ ok: true, callId: "c1", data: homeListing() }]);

    // The provider saw only REGISTERED tool metadata.
    expect(requests[0]).toEqual({ message: "List my files.", tools: readToolDefinitions });

    expect(mocks.persistAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.persistAgentTurn).toHaveBeenCalledWith({
      userId: USER_ID,
      instruction: "List my files.",
      maxToolRounds: 2,
      title: "Listing turn",
      rounds: [
        {
          toolCalls: [call("c1", "list_directory", { path: "/home" })],
          toolResults: [{ ok: true, callId: "c1", data: homeListing() }],
        },
      ],
      finalText: "Everything listed.",
    });
  });

  it("persists rounds with free-form text when the provider returns both", async () => {
    const { generate } = scriptedProvider([
      { text: "Working on it…", toolCalls: [call("s", "search_files", { query: "notes" })] },
      { text: "Found them." },
    ]);

    await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { instruction: "Find notes." },
      makeOptions({ generate }, { maxToolRounds: 2 }),
    );

    expect(mocks.persistAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        rounds: [
          {
            text: "Working on it…",
            toolCalls: [call("s", "search_files", { query: "notes" })],
            toolResults: [{ ok: true, callId: "s", data: [] }],
          },
        ],
      }),
    );
  });

  it("rejects an unauthenticated session before contacting the provider or persisting", async () => {
    const { generate } = scriptedProvider([{ text: "never asked" }]);

    await expect(
      runPersistentTurn(
        sessionContext(undefined),
        { instruction: "hi" },
        makeOptions({ generate }),
      ),
    ).rejects.toThrow(AppError);

    expect(generate).not.toHaveBeenCalled();
    expect(mocks.loadAgentConversationState).not.toHaveBeenCalled();
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Resume an existing conversation
// ---------------------------------------------------------------------------

describe("runPersistentTurn — resume", () => {
  beforeEach(() => {
    mocks.loadAgentConversationState.mockReset();
    mocks.persistAgentTurn.mockReset();
  });

  it("loads the owned conversation and inherits its round bound", async () => {
    let previous = createConversationState({ instruction: "First turn", maxToolRounds: 3 });
    previous = finalizeConversation(previous, "First reply.");
    mocks.loadAgentConversationState.mockResolvedValue(previous);
    mocks.persistAgentTurn.mockResolvedValue({ id: "conv-9", created: false });

    const { generate } = scriptedProvider([{ text: "Second reply." }]);

    const result = await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { conversationId: "conv-9", instruction: "Second turn." },
      makeOptions({ generate }),
    );

    expect(mocks.loadAgentConversationState).toHaveBeenCalledWith(USER_ID, "conv-9");
    expect(result.conversationId).toBe("conv-9");
    expect(result.created).toBe(false);
    expect(result.state.instruction).toBe("Second turn.");
    expect(result.state.finalText).toBe("Second reply.");

    // The persisted bound comes from the loaded conversation, not the input.
    expect(mocks.persistAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        conversationId: "conv-9",
        maxToolRounds: 3,
      }),
    );
  });

  it("rejects a foreign or missing conversation before running anything", async () => {
    mocks.loadAgentConversationState.mockResolvedValue(null);
    const { generate } = scriptedProvider([{ text: "never asked" }]);

    await expect(
      runPersistentTurn(
        sessionContext(ACTIVE_USER),
        { conversationId: "conv-foreign", instruction: "sneak" },
        makeOptions({ generate }),
      ),
    ).rejects.toThrow(AgentConversationNotFoundError);

    expect(generate).not.toHaveBeenCalled();
    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. Successful tool loop and text-only final
// ---------------------------------------------------------------------------

describe("runPersistentTurn — loop outcomes", () => {
  beforeEach(() => {
    mocks.persistAgentTurn.mockReset().mockResolvedValue({ id: "conv-1", created: true });
  });

  it("persists a multi-round tool transcript in order", async () => {
    const { generate } = scriptedProvider([
      { toolCalls: [call("s", "search_files", { query: "notes" })] },
      { toolCalls: [call("t", "list_directory", { path: "/tmp" })] },
      { text: "Search and listing done." },
    ]);

    const result = await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { instruction: "Search then list." },
      makeOptions({ generate }, { maxToolRounds: 2 }),
    );

    expect(result.state.toolRounds).toBe(2);
    expect(result.state.toolResults).toEqual([
      { ok: true, callId: "s", data: [] },
      { ok: true, callId: "t", data: homeListing("/tmp") },
    ]);
    expect(result.state.messages).toHaveLength(3);

    expect(mocks.persistAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        rounds: [
          {
            toolCalls: [call("s", "search_files", { query: "notes" })],
            toolResults: [{ ok: true, callId: "s", data: [] }],
          },
          {
            toolCalls: [call("t", "list_directory", { path: "/tmp" })],
            toolResults: [{ ok: true, callId: "t", data: homeListing("/tmp") }],
          },
        ],
      }),
    );
  });

  it("persists a text-only turn with no tool rounds", async () => {
    const { generate } = scriptedProvider([{ text: "No tools needed." }]);

    const result = await runPersistentTurn(
      sessionContext(ACTIVE_USER),
      { instruction: "Hello." },
      makeOptions({ generate }),
    );

    expect(result.state.toolRounds).toBe(0);
    expect(result.state.finalText).toBe("No tools needed.");
    expect(result.state.messages).toEqual([{ kind: "final", text: "No tools needed." }]);

    expect(mocks.persistAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        rounds: [],
        finalText: "No tools needed.",
        maxToolRounds: 1,
      }),
    );
  });

  it("stops at the round limit with a typed loop error and persists nothing", async () => {
    const { generate } = scriptedProvider([
      { toolCalls: [call("a", "search_files", { query: "x" })] },
      { toolCalls: [call("b", "search_files", { query: "y" })] },
      { toolCalls: [call("c", "search_files", { query: "z" })] },
    ]);

    await expect(
      runPersistentTurn(
        sessionContext(ACTIVE_USER),
        { instruction: "keep going" },
        makeOptions({ generate }, { maxToolRounds: 2 }),
      ),
    ).rejects.toMatchObject({
      name: "AgentLoopError",
      code: "agent/max-tool-rounds-reached",
    });

    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5 & 6. Ownership and provider failure
// ---------------------------------------------------------------------------

describe("runPersistentTurn — failures persist nothing", () => {
  beforeEach(() => {
    mocks.loadAgentConversationState.mockReset();
    mocks.persistAgentTurn.mockReset();
  });

  it("propagates a typed provider failure and persists nothing", async () => {
    const { generate } = scriptedProvider([
      ProviderError.transient(ProviderErrorCode.RateLimited, "slow down"),
    ]);

    await expect(
      runPersistentTurn(
        sessionContext(ACTIVE_USER),
        { instruction: "do something" },
        makeOptions({ generate }),
      ),
    ).rejects.toThrow(ProviderError);

    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });

  it("rejects a degraded provider with no final text and persists nothing", async () => {
    const { generate } = scriptedProvider([{}] as AgentResponse[]);

    await expect(
      runPersistentTurn(
        sessionContext(ACTIVE_USER),
        { instruction: "say something" },
        makeOptions({ generate }),
      ),
    ).rejects.toThrow(TypeError);

    expect(mocks.persistAgentTurn).not.toHaveBeenCalled();
  });
});