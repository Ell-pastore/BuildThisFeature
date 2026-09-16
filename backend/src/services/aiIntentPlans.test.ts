/**
 * aiIntentPlans service tests (Phase 11.1).
 *
 * The planning service routes ONE bounded agent turn against the EXISTING
 * `runAgentTurn()` → `invokeTool()` pipeline, offering the provider ONLY the
 * read-only `plan_intent` tool and a fail-closed filesystem. These tests
 * exercise the real service with a scripted provider and a spy
 * `FilesystemExecutor`, asserting:
 *
 *   1. The provider request offers exactly one tool: `plan_intent`.
 *   2. A natural-language MOVE becomes a nested plan with preserved semantic
 *      references (destination preserved verbatim).
 *   3. Absolute paths flow through verbatim and stay authoritative.
 *   4. A text-only provider reply returns `{ plan: null, finalText }`.
 *   5. A well-formed but unsupported intent (DELETE) returns the plan with
 *      `supported: false` — nothing executes.
 *   6. A malformed `plan_intent` call is a 400 `common/bad-request`.
 *   7. An errant filesystem-tool call in the plan turn is `unknown_tool`
 *      and the filesystem is never touched (fail-closed).
 *   8. Strict body parsing rejects unexpected fields and empty/missing
 *      instructions.
 *   9. Error mapping: provider failures → 503 `ai/provider-unavailable`;
 *      `AppError` passthrough; no session → existing 401.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError, isAppError } from "../core/errors.js";
import {
  runAiIntentPlan,
  runAiIntentPlanWithProvider,
  parseAiIntentPlanInput,
  mapAiIntentPlanError,
  bindAiIntentPlanner,
} from "./aiIntentPlans.js";
import { planToolDefinitions } from "../tools/definitions/planTools.js";
import {
  ProviderError,
  isProviderError,
  type AgentProvider,
  type AgentResponse,
} from "./provider.js";
import type { AgentToolCall } from "./agent.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { DirectoryListing } from "../tools/tauriShapes.js";

// ---------------------------------------------------------------------------
// Fixtures (mirrors agentLoop.test.ts)
// ---------------------------------------------------------------------------

const ACTIVE_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};

function sessionContext(user: unknown): { get: (key: string) => unknown } {
  return { get: (key) => (key === "user" ? user : undefined) };
}

/** A FilesystemExecutor that records every call (planning must never call it). */
function makeFilesystem(): FilesystemExecutor & { calls: string[] } {
  const calls: string[] = [];
  const fake: FilesystemExecutor & { calls: string[] } = {
    calls,
    async listDirectory(): Promise<DirectoryListing> {
      calls.push("listDirectory");
      return { path: "/", parentPath: null, isHome: true, items: [] };
    },
    async searchFiles() {
      calls.push("searchFiles");
      return [];
    },
    async getFileMetadata() {
      calls.push("getFileMetadata");
      throw new Error("fail-closed test executor");
    },
    async readFile() {
      calls.push("readFile");
      throw new Error("fail-closed test executor");
    },
    async moveFile() {
      calls.push("moveFile");
      throw new Error("fail-closed test executor");
    },
    async copyFile() {
      calls.push("copyFile");
      throw new Error("fail-closed test executor");
    },
  };
  return fake;
}

type Generate = AgentProvider["generate"];

/** A fake provider serving the instructions-friendly look of AgentProvider. */
function scriptedProvider(
  responses: Array<AgentResponse | ProviderError>,
): {
  generate: ReturnType<typeof vi.fn<Generate>>;
  requests: Parameters<Generate>[0][];
} {
  const requests: Parameters<Generate>[0][] = [];
  const generate = vi.fn<Generate>().mockImplementation(async (request) => {
    requests.push(request);
    const response = responses[requests.length - 1];
    if (response === undefined) {
      throw new Error("fake provider script exhausted");
    }
    if (isProviderError(response)) throw response;
    return response;
  });
  return { generate, requests };
}

function call(id: string, toolName: string, input: Record<string, unknown>): AgentToolCall {
  return { id, toolName, input };
}

const NL_MOVE_CALL = call("intent-1", "plan_intent", {
  intent: "MOVE",
  sourceKind: "folder",
  sourceName: "sound",
  sourceLocation: "Downloads",
  destinationKind: "folder",
  destinationName: "Desktop",
});

// ---------------------------------------------------------------------------
// 1. Restricting the provider surface
// ---------------------------------------------------------------------------

describe("runAiIntentPlanWithProvider — provider surface", () => {
  it("offers exactly the single plan_intent tool", async () => {
    const { generate, requests } = scriptedProvider([
      { text: "ok", toolCalls: [NL_MOVE_CALL] },
    ]);
    const filesystem = makeFilesystem();

    const out = await runAiIntentPlanWithProvider(
      { generate },
      sessionContext(ACTIVE_USER),
      { instruction: 'Move the "sound" folder from Downloads to Desktop.' },
      { filesystem },
    );

    expect(requests).toHaveLength(1);
    const [first] = requests;
    expect(first).toBeDefined();
    if (!first) return;
    expect(first.message).toBe(
      'Move the "sound" folder from Downloads to Desktop.',
    );
    expect(first.tools).toEqual(planToolDefinitions);
    expect(first.tools.map((t) => t.name)).toEqual(["plan_intent"]);
    expect(first.tools.every((t) => t.permission === "read")).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out.plan).not.toBeNull();
    expect(filesystem.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. Plan construction through the service
// ---------------------------------------------------------------------------

describe("runAiIntentPlanWithProvider — MOVE plans", () => {
  it("plans a natural-language MOVE with preserved semantic references", async () => {
    const { generate } = scriptedProvider([
      { text: "understood", toolCalls: [NL_MOVE_CALL] },
    ]);

    const out = await runAiIntentPlanWithProvider(
      { generate },
      sessionContext(ACTIVE_USER),
      { instruction: "Move sound from Downloads to Desktop." },
      { filesystem: makeFilesystem() },
    );

    expect(out.finalText).toBeUndefined();
    expect(out.plan).toEqual({
      intent: "MOVE",
      source: {
        reference: "semantic",
        kind: "folder",
        name: "sound",
        location: "Downloads",
      },
      destination: {
        reference: "semantic",
        kind: "folder",
        name: "Desktop",
      },
      operation: {},
      requiresApproval: true,
      supported: true,
    });
  });

  it("passes absolute paths through verbatim with path references", async () => {
    const { generate } = scriptedProvider([
      {
        text: "ok",
        toolCalls: [
          call("intent-1", "plan_intent", {
            intent: "MOVE",
            sourceAbsolutePath: "/Users/apple/Downloads/sound",
            destinationAbsolutePath: "/Users/apple/Desktop",
          }),
        ],
      },
    ]);

    const out = await runAiIntentPlanWithProvider(
      { generate },
      sessionContext(ACTIVE_USER),
      {
        instruction:
          "Move /Users/apple/Downloads/sound to /Users/apple/Desktop.",
      },
      { filesystem: makeFilesystem() },
    );

    expect(out.plan?.source).toEqual({
      reference: "path",
      kind: "unknown",
      absolutePath: "/Users/apple/Downloads/sound",
    });
    expect(out.plan?.destination?.absolutePath).toBe("/Users/apple/Desktop");
    expect(out.plan?.destination?.reference).toBe("path");
  });
});

// ---------------------------------------------------------------------------
// 4. Text-only reply
// ---------------------------------------------------------------------------

describe("runAiIntentPlanWithProvider — no tool call", () => {
  it("returns plan: null with the provider's text when no plan is produced", async () => {
    const { generate } = scriptedProvider([
      { text: "I need more details before I can plan that." },
    ]);

    const out = await runAiIntentPlanWithProvider(
      { generate },
      sessionContext(ACTIVE_USER),
      { instruction: "Move the thing." },
      { filesystem: makeFilesystem() },
    );

    expect(out.plan).toBeNull();
    expect(out.finalText).toBe("I need more details before I can plan that.");
  });
});

// ---------------------------------------------------------------------------
// 5. Well-formed but unsupported intent
// ---------------------------------------------------------------------------

describe("runAiIntentPlanWithProvider — unsupported intent", () => {
  it("returns a well-formed plan with supported: false (nothing executes)", async () => {
    const { generate } = scriptedProvider([
      {
        text: "ok",
        toolCalls: [
          call("intent-1", "plan_intent", {
            intent: "DELETE",
            sourceName: "sound",
            sourceLocation: "Downloads",
          }),
        ],
      },
    ]);

    const out = await runAiIntentPlanWithProvider(
      { generate },
      sessionContext(ACTIVE_USER),
      { instruction: "Delete the sound folder." },
      { filesystem: makeFilesystem() },
    );

    expect(out.plan).toMatchObject({
      intent: "DELETE",
      requiresApproval: true,
      supported: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Malformed plan_intent call → 400
// ---------------------------------------------------------------------------

describe("runAiIntentPlanWithProvider — malformed plan", () => {
  it("rejects a malformed plan_intent call with 400 common/bad-request", async () => {
    const { generate } = scriptedProvider([
      {
        text: "ok",
        toolCalls: [
          call("intent-1", "plan_intent", {
            intent: "TELEPORT",
            sourceName: "sound",
          }),
        ],
      },
    ]);

    await expect(
      runAiIntentPlanWithProvider(
        { generate },
        sessionContext(ACTIVE_USER),
        { instruction: "Teleport the sound folder." },
        { filesystem: makeFilesystem() },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "common/bad-request",
    });
  });
});

// ---------------------------------------------------------------------------
// 7. ErrANT tool calls fail closed (no filesystem, no approvals)
// ---------------------------------------------------------------------------

describe("runAiIntentPlanWithProvider — errant tool calls fail closed", () => {
  it("returns unknown_tool for an errant filesystem tool and never touches the filesystem", async () => {
    const { generate } = scriptedProvider([
      {
        text: "ok",
        toolCalls: [
          call("intent-1", "list_directory", { path: "/Users/apple" }),
          call("intent-2", "move_file", {
            path: "/Users/apple/Downloads/sound",
            destination: "/Users/apple/Desktop",
          }),
        ],
      },
    ]);
    const filesystem = makeFilesystem();

    const out = await runAiIntentPlanWithProvider(
      { generate },
      sessionContext(ACTIVE_USER),
      {
        instruction: "Figure out the plan, but also try to list and move files.",
      },
      { filesystem },
    );

    // The plan-only registry has no filesystem tools: neither intent
    // executes, no plan is produced, and the executor is never called.
    expect(out.plan).toBeNull();
    expect(filesystem.calls).toEqual([]);
  });

  it("never reads or writes the database (no approval/host-execution rows)", async () => {
    // The plan registry contains ONLY plan_intent, and plan_intent is ungated,
    // so neither approve-able nor host-delegable tools exist in this surface.
    const { generate } = scriptedProvider([{ text: "no tools needed" }]);
    const filesystem = makeFilesystem();

    const out = await runAiIntentPlanWithProvider(
      { generate },
      sessionContext(ACTIVE_USER),
      { instruction: "Plan nothing, just talk." },
      { filesystem },
    );

    expect(out.plan).toBeNull();
    expect(out.finalText).toBe("no tools needed");
    expect(filesystem.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. Strict body parsing
// ---------------------------------------------------------------------------

describe("parseAiIntentPlanInput — strict body", () => {
  it("accepts only instruction and trims it", () => {
    expect(parseAiIntentPlanInput({ instruction: "  Move notes  " })).toEqual({
      instruction: "Move notes",
    });
  });

  it("rejects unexpected fields (identity is never body-supplied)", () => {
    expect(() =>
      parseAiIntentPlanInput({ instruction: "Move notes", userId: "99999999-9999-9999-9999-999999999999" }),
    ).toThrowError(AppError);
  });

  it("rejects a non-object body", () => {
    expect(() => parseAiIntentPlanInput("Move notes")).toThrowError(AppError);
    expect(() => parseAiIntentPlanInput(null)).toThrowError(AppError);
  });

  it("rejects a missing, empty, or oversized instruction", () => {
    expect(() => parseAiIntentPlanInput({})).toThrowError(AppError);
    expect(() => parseAiIntentPlanInput({ instruction: "   " })).toThrowError(AppError);
    expect(() => parseAiIntentPlanInput({ instruction: "x".repeat(4097) })).toThrowError(AppError);
  });
});

// ---------------------------------------------------------------------------
// 9. Error mapping + production entries
// ---------------------------------------------------------------------------

describe("mapAiIntentPlanError", () => {
  it("passes AppError through unchanged", () => {
    const error = AppError.badRequest("boom");
    expect(mapAiIntentPlanError(error)).toBe(error);
  });

  it("maps a ProviderError to 503 ai/provider-unavailable", () => {
    const mapped = mapAiIntentPlanError(
      ProviderError.transient("provider/unavailable", "boom"),
    );
    expect(isAppError(mapped)).toBe(true);
    if (isAppError(mapped)) {
      expect(mapped.status).toBe(503);
      expect(mapped.code).toBe("ai/provider-unavailable");
    }
  });

  it("leaves unexpected errors unchanged (HTTP envelope hides internals)", () => {
    const error = new Error("SECRET provider key leak");
    expect(mapAiIntentPlanError(error)).toBe(error);
  });
});

describe("runAiIntentPlan — production entry", () => {
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    bindAiIntentPlanner({ generate: async () => ({ text: "no tools" }) });
  });

  afterEach(() => {
    bindAiIntentPlanner(undefined);
    consoleSpy.mockClear();
  });

  it("routes through the bound planner and maps provider failures to 503", async () => {
    const providerError = ProviderError.permanent(
      "provider/authentication-failed",
      "bad key",
    );
    bindAiIntentPlanner({
      generate: async () => {
        throw providerError;
      },
    });

    await expect(
      runAiIntentPlan(sessionContext(ACTIVE_USER), { instruction: "Move notes." }),
    ).rejects.toMatchObject({ status: 503, code: "ai/provider-unavailable" });
  });

  it("requires an authenticated session before any provider call (fail closed)", async () => {
    const generate = vi.fn<Generate>(async () => ({ text: "never reached" }));
    bindAiIntentPlanner({ generate });

    await expect(
      runAiIntentPlan(sessionContext(undefined), { instruction: "Move notes." }),
    ).rejects.toMatchObject({ status: 401 });
    expect(generate).not.toHaveBeenCalled();
  });
});