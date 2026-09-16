/**
 * Tool invocation service tests (Phase 9.8).
 *
 * These tests prove the complete invocation API end to end through the
 * production pipeline:
 *
 *   Authenticated request (session identity)
 *   → createSessionExecutionContext   (Phase 9.7)
 *   → ToolRegistry                    (Phase 9.1, real)
 *   → policy gate                    (Phase 9.5, real)
 *   → handler                         (Phase 9.3, real)
 *   → FilesystemExecutor              (fake — no Tauri/Rust)
 *
 * Coverage:
 *
 *   1. Authenticated successful invocation.
 *   2. Unknown tool → structured unknown_tool error.
 *   3. Invalid input → structured validation error.
 *   4. Permission denial → structured security error (handler never runs).
 *   5. Unauthenticated request → rejected (AppError.unauthorized).
 *   6. Request-supplied identity in the input is ignored.
 *   7. Inactive session user → denied (defense in depth).
 *   8. Persistent-turn context (Phase 10.28C-prep): a supplied `turnContext`
 *      binds the persisted conversation/message ids to the execution context,
 *      while direct invocations carry none (behavior unchanged).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { AppError } from "../core/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  ToolPermission,
  type ToolDefinition,
} from "../tools/types.js";
import { registerReadTools } from "../tools/definitions/readTools.js";
import { ToolErrorCode } from "../tools/errors.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import { hostDelegatedFilesystemExecutor } from "../tools/executor.js";
import type { DirectoryListing } from "../tools/tauriShapes.js";
import type { ToolExecutionContext, ToolPolicy } from "../tools/policy.js";
import { defaultToolPolicy } from "../tools/policy.js";
import {
  invokeTool,
  isHostExecutionRequiredResult,
  type InvokeToolOptions,
} from "./tools.js";
import {
  HostExecutionDuplicateError,
  HostExecutionStatus,
  type HostExecutionRecord,
} from "./aiHostExecutions.js";

// ---------------------------------------------------------------------------
// Host-execution service seam (Phase 10.39): repo-touching functions stubbed,
// error classes + executable assertions stay REAL.
// ---------------------------------------------------------------------------
const hostMocks = vi.hoisted(() => ({
  createAiHostExecution: vi.fn(),
  getPendingHostExecution: vi.fn(),
  getAiHostExecution: vi.fn(),
  submitHostExecution: vi.fn(),
}));

vi.mock("./aiHostExecutions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./aiHostExecutions.js")>();
  return {
    ...actual,
    createAiHostExecution: hostMocks.createAiHostExecution,
    getPendingHostExecution: hostMocks.getPendingHostExecution,
    getAiHostExecution: hostMocks.getAiHostExecution,
    submitHostExecution: hostMocks.submitHostExecution,
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

const PENDING_USER = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "bob@example.com",
  displayName: "Bob Example",
  status: "pending",
};

/** A session-shaped context: `requireAuth` would have stamped the user. */
function sessionContext(user: unknown): { get: (key: string) => unknown } {
  return { get: (key) => (key === "user" ? user : undefined) };
}

/** A fake FilesystemExecutor that records calls (no Tauri/Rust). */
function makeFilesystem(): FilesystemExecutor & { calls: string[] } {
  const calls: string[] = [];
  const fake: FilesystemExecutor & { calls: string[] } = {
    calls,
    async listDirectory(path): Promise<DirectoryListing> {
      calls.push(`listDirectory:${path}`);
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
  return fake;
}

/** A registered, read-only tool registry wired like the app's would be. */
function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerReadTools(registry);
  return registry;
}

function makeOptions(
  registry: ToolRegistry,
  filesystem: FilesystemExecutor,
  policy?: ToolPolicy,
): InvokeToolOptions {
  return { registry, filesystem, policy };
}

// ---------------------------------------------------------------------------
// 1. Authenticated successful invocation
// ---------------------------------------------------------------------------

describe("invokeTool — authenticated successful invocation", () => {
  it("dispatches a registered read tool and returns the executor result", async () => {
    const filesystem = makeFilesystem();
    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "list_directory",
      { path: "/home" },
      makeOptions(makeRegistry(), filesystem),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ path: "/home", parentPath: null, isHome: false, items: [] });
    expect(filesystem.calls).toEqual(["listDirectory:/home"]);
  });

  it("accepts untyped-true input bags (the untrusted RawToolInput contract)", async () => {
    const filesystem = makeFilesystem();
    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "search_files",
      { query: "report" },
      makeOptions(makeRegistry(), filesystem),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Unknown tool
// ---------------------------------------------------------------------------

describe("invokeTool — unknown tool", () => {
  it("returns a structured unknown_tool error", async () => {
    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "not_a_tool",
      {},
      makeOptions(makeRegistry(), makeFilesystem()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("unknown_tool");
    expect(result.error.code).toBe(ToolErrorCode.UnknownTool);
    expect(result.error.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 3. Invalid input
// ---------------------------------------------------------------------------

describe("invokeTool — invalid input", () => {
  it("returns a structured validation error for a malformed input", async () => {
    const filesystem = makeFilesystem();
    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "list_directory",
      // path must be a non-empty string; a number must be rejected.
      { path: 42 },
      makeOptions(makeRegistry(), filesystem),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
    expect(result.error.code).toBe(ToolErrorCode.InvalidInput);
    expect(filesystem.calls).toEqual([]);
  });

  it("returns a validation error for a missing required field", async () => {
    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "list_directory",
      {},
      makeOptions(makeRegistry(), makeFilesystem()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// 4. Permission denial
// ---------------------------------------------------------------------------

describe("invokeTool — permission denial", () => {
  it("denies a non-read tool before it can reach any handler", async () => {
    const registry = new ToolRegistry();
    registerReadTools(registry);
    registry.register(writeTool("create_file"));
    const filesystem = makeFilesystem();

    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "create_file",
      { path: "/home/new.txt" },
      makeOptions(registry, filesystem),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.PermissionDenied);
    expect(result.error.status).toBe(403);
    // The security gate is before the handler: nothing hit the executor.
    expect(filesystem.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Unauthenticated request
// ---------------------------------------------------------------------------

describe("invokeTool — unauthenticated request", () => {
  it("throws AppError.unauthorized when no session identity is present", async () => {
    await expect(
      invokeTool(
        sessionContext(undefined),
        "list_directory",
        { path: "/home" },
        makeOptions(makeRegistry(), makeFilesystem()),
      ),
    ).rejects.toThrow(AppError);

    try {
      await invokeTool(
        sessionContext(undefined),
        "list_directory",
        { path: "/home" },
        makeOptions(makeRegistry(), makeFilesystem()),
      );
      expect.unreachable("unauthenticated invocation must throw");
    } catch (error) {
      const err = error as AppError;
      expect(err.status).toBe(401);
      expect(err.code).toBe("auth/unauthorized");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Request-supplied identity is ignored
// ---------------------------------------------------------------------------

describe("invokeTool — request-supplied identity is ignored", () => {
  it("builds the actor from the session even when the input carries identity fields", async () => {
    // A policy that captures the identity the dispatcher used. The
    // invocation must have stamped the SESSION identity (Alice), never
    // the attacker fields smuggled through the input.
    const seen: ToolExecutionContext[] = [];
    const capturingPolicy: ToolPolicy = (definition, context) => {
      seen.push(context);
      return defaultToolPolicy()(definition, context);
    };

    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "list_directory",
      {
        path: "/home",
        userId: "attacker-id",
        email: "mallory@example.com",
        displayName: "Mallory",
        status: "active",
      },
      makeOptions(makeRegistry(), makeFilesystem(), capturingPolicy),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(seen).toHaveLength(1);
    const context = seen[0];
    expect(context).toBeDefined();
    if (!context) return;
    const actor = context.actor;
    expect(actor.kind).toBe("ai-agent");
    if (actor.kind !== "ai-agent") return;
    expect(actor.identity.userId).toBe(ACTIVE_USER.id);
    expect(actor.identity.email).toBe(ACTIVE_USER.email);
    expect(actor.identity.userId).not.toBe("attacker-id");
  });
});

// ---------------------------------------------------------------------------
// 7. Inactive session user
// ---------------------------------------------------------------------------

describe("invokeTool — inactive session user", () => {
  it("is denied by the policy when a non-active identity reaches the pipeline", async () => {
    const result = await invokeTool(
      sessionContext(PENDING_USER),
      "list_directory",
      { path: "/home" },
      makeOptions(makeRegistry(), makeFilesystem()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("security");
    expect(result.error.code).toBe(ToolErrorCode.IdentityInvalid);
  });
});

// ---------------------------------------------------------------------------
// 8. Persistent-turn context at the invocation boundary (Phase 10.28C-prep)
// ---------------------------------------------------------------------------

describe("invokeTool — persistent turn context (Phase 10.28C-prep)", () => {
  it("binds the persisted conversationId + messageId to the execution context when turnContext is supplied", async () => {
    const seen: ToolExecutionContext[] = [];
    const capturingPolicy: ToolPolicy = (definition, context) => {
      seen.push(context);
      return defaultToolPolicy()(definition, context);
    };

    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "list_directory",
      { path: "/home" },
      {
        registry: makeRegistry(),
        filesystem: makeFilesystem(),
        policy: capturingPolicy,
        turnContext: {
          conversationId: "conv-1",
          messageId: "msg-r1",
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const context = seen[0];
    expect(context).toBeDefined();
    if (!context) return;
    // The REAL persisted turn context reached the invocation boundary.
    expect(context.conversationId).toBe("conv-1");
    expect(context.messageId).toBe("msg-r1");
    // Authenticated identity is preserved, never replaced by the ids.
    expect(context.actor.kind).toBe("ai-agent");
    if (context.actor.kind === "ai-agent") {
      expect(context.actor.identity.userId).toBe(ACTIVE_USER.id);
    }
  });

  it("carries no conversation/message ids for direct (non-persistent) invocations", async () => {
    const seen: ToolExecutionContext[] = [];
    const capturingPolicy: ToolPolicy = (definition, context) => {
      seen.push(context);
      return defaultToolPolicy()(definition, context);
    };

    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "search_files",
      { query: "notes" },
      { registry: makeRegistry(), filesystem: makeFilesystem(), policy: capturingPolicy },
    );

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const context = seen[0];
    expect(context).toBeDefined();
    if (!context) return;
    // Existing non-persistent behavior is unchanged: no turn ids, no policy
    // change — the default policy evaluates exactly as before.
    expect(context.conversationId).toBeUndefined();
    expect(context.messageId).toBeUndefined();
    expect(context.actor.kind).toBe("ai-agent");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTool(name: string): ToolDefinition {
  return {
    name,
    description: `The ${name} tool (synthetic test fixture only).`,
    inputSchema: { type: "object" },
    permission: ToolPermission.Write,
  };
}

// ---------------------------------------------------------------------------
// Phase 10.39 — host-execution gate (invokeTool, hereby the proof)
// ---------------------------------------------------------------------------

describe("invokeTool — host-execution gate (Phase 10.39)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostMocks.createAiHostExecution.mockReset();
    hostMocks.getPendingHostExecution.mockReset().mockResolvedValue(null);
  });

  function pendingRecord(): HostExecutionRecord {
    return {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      userId: ACTIVE_USER.id,
      conversationId: "conv-1",
      messageId: "msg-1",
      toolName: "list_directory",
      callId: "c1",
      arguments: { path: "/home" },
      round: 1,
      status: HostExecutionStatus.Pending,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      executedAt: null,
      approvalId: null,
    };
  }

  function delegatedOptions(): InvokeToolOptions {
    return {
      registry: makeRegistry(),
      filesystem: hostDelegatedFilesystemExecutor(),
      turnContext: { conversationId: "conv-1", messageId: "msg-1" },
      callId: "c1",
      toolRounds: 1,
    };
  }

  it("records a scoped pending execution for a delegated read tool and NEVER executes it here", async () => {
    const record = pendingRecord();
    hostMocks.createAiHostExecution.mockResolvedValue(record);
    const filesystem = hostDelegatedFilesystemExecutor();
    await expect(filesystem.listDirectory("/")).rejects.toThrow();

    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "list_directory",
      { path: "/home" },
      delegatedOptions(),
    );

    // The gate wrote the execution and returned the typed pending result —
    // the doomed executor's call never happened.
    expect(hostMocks.createAiHostExecution).toHaveBeenCalledWith(
      {
        userId: ACTIVE_USER.id,
        conversationId: "conv-1",
        messageId: "msg-1",
        toolName: "list_directory",
        callId: "c1",
        arguments: { path: "/home" },
        round: 1,
        expiresAt: expect.any(Date),
      },
      { registry: expect.any(Object) },
    );
    expect(isHostExecutionRequiredResult(result)).toBe(true);
    if (!isHostExecutionRequiredResult(result)) return;
    expect(result.executionRequired).toBe(true);
    expect(result.error).toMatchObject({
      category: "security",
      code: ToolErrorCode.HostExecutionRequired,
    });
    expect(result.execution).toEqual({
      executionId: record.id,
      toolName: "list_directory",
      arguments: { path: "/home" },
      expiresAt: record.expiresAt,
    });
  });

  it("fails closed with security when the delegated executor lacks turn context", async () => {
    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "list_directory",
      { path: "/home" },
      { registry: makeRegistry(), filesystem: hostDelegatedFilesystemExecutor() },
    );

    expect(hostMocks.createAiHostExecution).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      category: "security",
      code: ToolErrorCode.HostExecutionContextMissing,
    });
  });

  it("fails closed with security when the delegated executor lacks a callId/toolRounds", async () => {
    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "list_directory",
      { path: "/home" },
      {
        registry: makeRegistry(),
        filesystem: hostDelegatedFilesystemExecutor(),
        turnContext: { conversationId: "conv-1", messageId: "msg-1" },
      },
    );

    expect(hostMocks.createAiHostExecution).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      category: "security",
      code: ToolErrorCode.HostExecutionContextMissing,
    });
  });

  it("dispatches a non-delegated executor exactly as before (gate declines)", async () => {
    hostMocks.createAiHostExecution.mockResolvedValue(pendingRecord());
    const filesystem = makeFilesystem();
    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "list_directory",
      { path: "/home" },
      {
        registry: makeRegistry(),
        filesystem,
        turnContext: { conversationId: "conv-1", messageId: "msg-1" },
        callId: "c1",
        toolRounds: 1,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeDefined();
    expect(hostMocks.createAiHostExecution).not.toHaveBeenCalled();
    expect(filesystem.calls).toEqual(["listDirectory:/home"]);
  });

  it("handles an idempotent duplicate by returning the existing pending execution", async () => {
    const record = pendingRecord();
    hostMocks.createAiHostExecution.mockRejectedValue(
      new HostExecutionDuplicateError("msg-1", "list_directory", "c1"),
    );
    hostMocks.getPendingHostExecution.mockResolvedValue(record);

    const result = await invokeTool(
      sessionContext(ACTIVE_USER),
      "list_directory",
      { path: "/home" },
      delegatedOptions(),
    );

    expect(isHostExecutionRequiredResult(result)).toBe(true);
    if (!isHostExecutionRequiredResult(result)) return;
    expect(result.execution.executionId).toBe(record.id);
  });
});