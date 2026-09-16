/**
 * Phase 10.30 — the authenticated AI instruction flow resumes an interrupted
 * turn after an approval decision.
 *
 * The instruction flow (`runAiInstructionWithRuntime` → `runPersistentTurn`
 * with `resumeApprovalId`) runs REAL, with a scripted FAKE provider (no AI, no
 * keys, no network) and a real registry + handlers + recording fake executor.
 * Both repository seams are mocked: the approval persistence (in-memory,
 * faithfully mirroring produce → resolve → consume, so the REAL contract
 * validation and executable guard run) and the agent-conversation persistence
 * used for the eager turn transcript.
 *
 * Coverage:
 *
 *   1. HAPPY RESUME: an owned, `approved` approval resumes — ONLY its EXACT
 *      stored arguments execute through policy → handler → executor (the
 *      turn body carries no tool arguments), the result is recorded as this
 *      turn's first round, the approval is CONSUMED (window backdated so it
 *      can never authorize again), and the terminated loop reports one round
 *      with the executed result as the only feedback the provider ever saw.
 *   2. DECISION GUARDS: rejected and expired approvals are 400s and never
 *      execute.
 *   3. OWNERSHIP: a foreign approval is a 404 indistinguishable from missing;
 *      a supplied conversationId that does not match the approval's own
 *      conversation is a 400.
 *   4. REPLAY PREVENTION: a consumed approval cannot be resumed a second time
 *      and refuses on the invocation boundary too — the executor runs once.
 *   5. BOUND: the approval's conversation's persisted `maxToolRounds` is the
 *      resumed loop's budget — the approved execution counts as round one, so
 *      a provider asking for more is refused (502 + cancelAgentTurn).
 *   6. REGRESSION: a malformed `approvalId` body is rejected before the
 *      runtime is contacted, and `approvalId` never substitutes for the
 *      required `instruction`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../core/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolPermission } from "../tools/types.js";
import { ToolErrorCode } from "../tools/errors.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { DirectoryListing } from "../tools/tauriShapes.js";
import { readToolDefinitions } from "../tools/definitions/readTools.js";
import type { AgentToolCall } from "./agent.js";
import type { AgentProvider, AgentProviderRequest, AgentResponse } from "./provider.js";
import { approveAiToolApproval } from "./aiToolApprovals.js";
import { invokeTool, isToolApprovalRequiredResult, type InvokeToolOptions } from "./tools.js";
import { runAiInstructionWithRuntime } from "./aiInstructions.js";
import {
  runPersistentTurn,
  type PersistentAgentTurnRuntime,
  type PersistentTurnOptions,
} from "./persistentAgentTurn.js";
import { createConversationState, finalizeConversation } from "./conversation.js";

// ---------------------------------------------------------------------------
// In-memory approval repository (mirrors produce → resolve → CONSUME; the REAL
// contract validation and executable guard run).
// ---------------------------------------------------------------------------

const approvalRepo = vi.hoisted(() => {
  type Row = {
    id: string;
    userId: string;
    conversationId: string;
    messageId: string;
    toolName: string;
    arguments: unknown;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
    decidedAt: Date | null;
  };
  const Status = {
    Pending: "pending",
    Approved: "approved",
    Rejected: "rejected",
    Expired: "expired",
  } as const;
  const Decision = { Approve: "approved", Reject: "rejected" } as const;

  class NotFoundError extends Error {
    constructor() {
      super("Tool approval not found for this user.");
      this.name = "ToolApprovalNotFoundError";
    }
  }
  class DuplicateError extends Error {
    constructor(messageId: string, toolName: string) {
      super(
        `A pending tool approval already exists for tool "${toolName}" in message "${messageId}".`,
      );
      this.name = "ToolApprovalDuplicateError";
    }
  }
  class AlreadyResolvedError extends Error {
    readonly status: string;
    constructor(status: string) {
      super(`This tool approval is already ${status}.`);
      this.name = "ToolApprovalAlreadyResolvedError";
      this.status = status;
    }
  }
  class ExpiredError extends Error {
    constructor() {
      super("This tool approval has expired.");
      this.name = "ToolApprovalExpiredError";
    }
  }

  const rows: Row[] = [];
  let seq = 0;
  function reset(): void {
    rows.length = 0;
    seq = 0;
  }

  async function createToolApproval(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    toolName: string;
    arguments: unknown;
    expiresAt: Date;
    now: Date;
  }): Promise<Row> {
    const duplicate = rows.find(
      (r) =>
        r.messageId === input.messageId &&
        r.toolName === input.toolName &&
        r.status === Status.Pending,
    );
    if (duplicate !== undefined) {
      throw new DuplicateError(input.messageId, input.toolName);
    }
    seq += 1;
    const created: Row = {
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      toolName: input.toolName,
      arguments: input.arguments,
      status: Status.Pending,
      createdAt: input.now,
      updatedAt: input.now,
      expiresAt: input.expiresAt,
      decidedAt: null,
    };
    rows.push(created);
    return created;
  }

  async function getToolApproval(userId: string, approvalId: string): Promise<Row | null> {
    return rows.find((r) => r.id === approvalId && r.userId === userId) ?? null;
  }

  async function getPendingToolApproval(
    userId: string,
    messageId: string,
    toolName: string,
  ): Promise<Row | null> {
    return (
      rows.find(
        (r) =>
          r.userId === userId &&
          r.messageId === messageId &&
          r.toolName === toolName &&
          r.status === Status.Pending,
      ) ?? null
    );
  }

  async function resolveToolApproval(
    userId: string,
    approvalId: string,
    decision: string,
    now: Date,
  ): Promise<Row> {
    const target = rows.find((r) => r.id === approvalId && r.userId === userId);
    if (target === undefined) throw new NotFoundError();
    if (target.status !== Status.Pending) throw new AlreadyResolvedError(target.status);
    if (now.getTime() >= target.expiresAt.getTime()) {
      target.status = Status.Expired;
      target.decidedAt = now;
      target.updatedAt = now;
      throw new ExpiredError();
    }
    target.status = decision;
    target.decidedAt = now;
    target.updatedAt = now;
    return target;
  }

  async function consumeToolApproval(userId: string, approvalId: string, now: Date): Promise<Row> {
    const target = rows.find((r) => r.id === approvalId && r.userId === userId);
    if (target === undefined) throw new NotFoundError();
    if (target.status !== Status.Approved) throw new AlreadyResolvedError(target.status);
    if (now.getTime() >= target.expiresAt.getTime()) {
      target.status = Status.Expired;
      target.decidedAt = now;
      target.updatedAt = now;
      throw new ExpiredError();
    }
    // The real semantics: the approval stays `approved` but its window is
    // backdated to `now`, so every later executable guard treats it expired.
    target.expiresAt = now;
    target.updatedAt = now;
    return target;
  }

  return {
    rows,
    reset,
    Status,
    Decision,
    NotFoundError,
    DuplicateError,
    AlreadyResolvedError,
    ExpiredError,
    createToolApproval,
    getToolApproval,
    getPendingToolApproval,
    resolveToolApproval,
    consumeToolApproval,
  };
});

vi.mock("../database/repositories/aiToolApprovals.js", () => ({
  ToolApprovalStatus: approvalRepo.Status,
  ToolApprovalDecision: approvalRepo.Decision,
  ToolApprovalNotFoundError: approvalRepo.NotFoundError,
  ToolApprovalDuplicateError: approvalRepo.DuplicateError,
  ToolApprovalAlreadyResolvedError: approvalRepo.AlreadyResolvedError,
  ToolApprovalExpiredError: approvalRepo.ExpiredError,
  createToolApproval: approvalRepo.createToolApproval,
  getToolApproval: approvalRepo.getToolApproval,
  getPendingToolApproval: approvalRepo.getPendingToolApproval,
  listPendingToolApprovals: vi.fn(),
  resolveToolApproval: approvalRepo.resolveToolApproval,
  consumeToolApproval: approvalRepo.consumeToolApproval,
}));

// ---------------------------------------------------------------------------
// In-memory host-execution service seam (§6.9 approved host writes). The
// service-level functions persistentAgentTurn calls are scripted against a
// small row store that mirrors create → get-pending-by-approval → seal
// (single-use). The REAL contract classes and executable assertions stay real.
// ---------------------------------------------------------------------------

const hostStore = vi.hoisted(() => {
  type Row = {
    id: string;
    userId: string;
    conversationId: string;
    messageId: string;
    toolName: string;
    callId: string;
    arguments: unknown;
    round: number;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
    executedAt: Date | null;
    approvalId: string | null;
  };
  const Status = {
    Pending: "pending",
    Executed: "executed",
    Expired: "expired",
  } as const;

  class NotFoundError extends Error {
    constructor() {
      super("Host execution not found for this user.");
      this.name = "HostExecutionNotFoundError";
    }
  }
  class DuplicateError extends Error {
    constructor() {
      super("A pending host execution already exists for this approval.");
      this.name = "HostExecutionDuplicateError";
    }
  }
  class AlreadyExecutedError extends Error {
    readonly status: string;
    constructor(status: string) {
      super(`This host execution is already ${status}.`);
      this.name = "HostExecutionAlreadyExecutedError";
      this.status = status;
    }
  }
  class ExpiredError extends Error {
    constructor() {
      super("This host execution has expired.");
      this.name = "HostExecutionExpiredError";
    }
  }

  const rows: Row[] = [];
  let seq = 0;
  function reset(): void {
    rows.length = 0;
    seq = 0;
  }

  async function createAiHostExecution(req: {
    userId: string;
    conversationId: string;
    messageId: string;
    toolName: string;
    callId: string;
    arguments: unknown;
    round: number;
    expiresAt: Date;
    now: Date;
    approvalId?: string;
  }): Promise<Row> {
    const duplicate = rows.find(
      (r) =>
        r.approvalId !== null &&
        r.approvalId === req.approvalId &&
        r.status === Status.Pending,
    );
    if (duplicate !== undefined) throw new DuplicateError();
    seq += 1;
    const created: Row = {
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(seq).padStart(12, "0")}`,
      userId: req.userId,
      conversationId: req.conversationId,
      messageId: req.messageId,
      toolName: req.toolName,
      callId: req.callId,
      arguments: req.arguments,
      round: req.round,
      status: Status.Pending,
      createdAt: req.now,
      updatedAt: req.now,
      expiresAt: req.expiresAt,
      executedAt: null,
      approvalId: req.approvalId ?? null,
    };
    rows.push(created);
    return created;
  }

  async function getPendingHostExecutionByApproval(
    userId: string,
    approvalId: string,
  ): Promise<Row | null> {
    return (
      rows.find(
        (r) => r.userId === userId && r.approvalId === approvalId && r.status === Status.Pending,
      ) ?? null
    );
  }

  async function getAiHostExecution(userId: string, executionId: string): Promise<Row | null> {
    return rows.find((r) => r.userId === userId && r.id === executionId) ?? null;
  }

  async function submitHostExecution(userId: string, executionId: string, now: Date): Promise<Row> {
    const target = rows.find((r) => r.userId === userId && r.id === executionId);
    if (target === undefined) throw new NotFoundError();
    if (target.status !== Status.Pending) throw new AlreadyExecutedError(target.status);
    if (now.getTime() >= target.expiresAt.getTime()) {
      target.status = Status.Expired;
      target.updatedAt = now;
      throw new ExpiredError();
    }
    target.status = Status.Executed;
    target.executedAt = now;
    target.updatedAt = now;
    return target;
  }

  return {
    rows,
    reset,
    Status,
    createAiHostExecution,
    getPendingHostExecutionByApproval,
    getAiHostExecution,
    submitHostExecution,
  };
});

vi.mock("./aiHostExecutions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./aiHostExecutions.js")>();
  return {
    ...actual,
    createAiHostExecution: hostStore.createAiHostExecution,
    getPendingHostExecutionByApproval: hostStore.getPendingHostExecutionByApproval,
    getAiHostExecution: hostStore.getAiHostExecution,
    submitHostExecution: hostStore.submitHostExecution,
  };
});

// ---------------------------------------------------------------------------
// Agent-conversation persistence (the eager turn transcript), as Phase 10.8.
// ---------------------------------------------------------------------------

const conversationMocks = vi.hoisted(() => ({
  loadAgentConversationState: vi.fn(),
  loadAgentConversationMessages: vi.fn(),
  persistAgentTurn: vi.fn(),
  beginAgentTurn: vi.fn(),
  appendAgentTurnRoundMessage: vi.fn(),
  completeAgentTurn: vi.fn(),
  cancelAgentTurn: vi.fn(),
  attachAgentMessageToolResult: vi.fn(),
}));

vi.mock("../database/repositories/agentConversations.js", () => ({
  loadAgentConversationState: conversationMocks.loadAgentConversationState,
  loadAgentConversationMessages: conversationMocks.loadAgentConversationMessages,
  persistAgentTurn: conversationMocks.persistAgentTurn,
  beginAgentTurn: conversationMocks.beginAgentTurn,
  appendAgentTurnRoundMessage: conversationMocks.appendAgentTurnRoundMessage,
  completeAgentTurn: conversationMocks.completeAgentTurn,
  cancelAgentTurn: conversationMocks.cancelAgentTurn,
  attachAgentMessageToolResult: conversationMocks.attachAgentMessageToolResult,
  AgentConversationNotFoundError: class AgentConversationNotFoundError extends Error {
    constructor() {
      super("Agent conversation not found for this user.");
      this.name = "AgentConversationNotFoundError";
    }
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};
const BOB = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "bob@example.com",
  displayName: "Bob Example",
  status: "active",
};
const USER_ID = ALICE.id;

// Persisted ids matching the mocked eager-turn transcript AND the approval
// fixture. The approval contract validates that conversation/message ids are
// UUID-shaped, so every fixture uses real-looking UUIDs.
const CONVERSATION_ID = "55555555-5555-5555-5555-555555555555";
const MESSAGE_ID = "66666666-6666-6666-6666-666666666666";
const INSTRUCTION_MESSAGE_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_CONVERSATION_ID = "99999999-9999-4999-8999-999999999999";

/** The approval's OWN conversation, finalized (ready for the resume turn). */
function ownedConversationState(maxToolRounds = 3) {
  return finalizeConversation(
    createConversationState({ instruction: "List /home with approval.", maxToolRounds }),
    "Approval requested.",
  );
}

function sessionContext(user: unknown): { get: (key: string) => unknown } {
  return { get: (key) => (key === "user" ? user : undefined) };
}

type Generate = AgentProvider["generate"];

function scriptedProvider(responses: Array<AgentResponse>): {
  generate: Generate;
  requests: AgentProviderRequest[];
} {
  const requests: AgentProviderRequest[] = [];
  const generate = vi.fn<Generate>().mockImplementation(async (request) => {
    requests.push(request);
    const response = responses[requests.length - 1];
    if (response === undefined) throw new Error("fake provider script exhausted");
    return response;
  });
  return { generate, requests };
}

function call(id: string, toolName: string, input: Record<string, unknown>): AgentToolCall {
  return { id, toolName, input };
}

function homeListing(path: string): DirectoryListing {
  return { path, parentPath: null, isHome: false, items: [] };
}

/** A recording fake executor — proves exactly what (if anything) executed. */
function makeFilesystem(): FilesystemExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listDirectory(path: string): Promise<DirectoryListing> {
      calls.push(`listDirectory:${path}`);
      return homeListing(path);
    },
    async searchFiles(query: string) {
      calls.push(`searchFiles:${query}`);
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

/** One approval-gated READ tool backed by a real handler, plus one ungated. */
function makeGatedRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "list_directory",
    description: "Approval-gated directory listing (test fixture).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    permission: ToolPermission.Read,
    requiresApproval: true,
  });
  registry.register({
    name: "search_files",
    description: "Ordinary read-only tool (not gated).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    permission: ToolPermission.Read,
  });
  return registry;
}

function makeInvokeOptions(overrides?: Partial<InvokeToolOptions>): InvokeToolOptions {
  return {
    registry: makeGatedRegistry(),
    filesystem: makeFilesystem(),
    turnContext: { conversationId: CONVERSATION_ID, messageId: MESSAGE_ID },
    ...overrides,
  };
}

function makeRuntimeOptions(
  provider: AgentProvider,
  override?: {
    registry?: ToolRegistry;
    filesystem?: FilesystemExecutor;
    maxToolRounds?: number;
  },
): PersistentTurnOptions {
  return {
    provider,
    tools: readToolDefinitions,
    registry: override?.registry ?? makeGatedRegistry(),
    filesystem: override?.filesystem ?? makeFilesystem(),
    maxToolRounds: override?.maxToolRounds ?? 3,
  };
}

/** A real persistent-turn runtime bound to the given options (Phase 10.20 seam). */
function makeInstructionRuntime(options: PersistentTurnOptions): PersistentAgentTurnRuntime {
  return {
    async run(c, input) {
      return runPersistentTurn(c, input, options);
    },
  };
}

/**
 * Produce an approved, owned approval for `list_directory:/home/docs` through
 * the REAL gate, then approve it through the existing contract.
 */
async function createApprovedApproval(
  filesystem: FilesystemExecutor,
): Promise<{ approvalId: string }> {
  const pending = await invokeTool(
    sessionContext(ALICE),
    "list_directory",
    { path: "/home/docs" },
    makeInvokeOptions({ filesystem }),
  );
  if (!isToolApprovalRequiredResult(pending)) {
    throw new Error("expected a pending approval");
  }
  await approveAiToolApproval(USER_ID, pending.approval.approvalId, new Date());
  return { approvalId: pending.approval.approvalId };
}

beforeEach(() => {
  approvalRepo.reset();
  hostStore.reset();
  vi.clearAllMocks();
  conversationMocks.loadAgentConversationState
    .mockReset()
    .mockResolvedValue(ownedConversationState());
  conversationMocks.loadAgentConversationMessages.mockReset().mockResolvedValue([]);
  conversationMocks.persistAgentTurn
    .mockReset()
    .mockResolvedValue({ id: CONVERSATION_ID, created: true });
  conversationMocks.beginAgentTurn.mockReset().mockResolvedValue({
    conversationId: CONVERSATION_ID,
    created: true,
    instructionMessageId: INSTRUCTION_MESSAGE_ID,
    messageId: MESSAGE_ID,
  });
  conversationMocks.appendAgentTurnRoundMessage.mockReset().mockResolvedValue({
    messageId: "88888888-8888-4888-8888-888888888888",
  });
  conversationMocks.completeAgentTurn.mockReset().mockResolvedValue(undefined);
  conversationMocks.cancelAgentTurn.mockReset().mockResolvedValue(undefined);
  conversationMocks.attachAgentMessageToolResult.mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. Happy resume: the approved approval executes exactly once, is consumed,
//    and the turn continues in the approval's own conversation.
// ---------------------------------------------------------------------------

describe("instruction flow — resuming an approved approval", () => {
  it("executes ONLY the approval's stored arguments, records round 1, and consumes the approval", async () => {
    const filesystem = makeFilesystem();
    const { approvalId } = await createApprovedApproval(filesystem);
    expect(filesystem.calls).toEqual([]);

    const { generate, requests } = scriptedProvider([{ text: "FYI: docs are listed." }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }, { filesystem }));

    const response = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Continue after approval.",
      approvalId,
    });

    // The EXACT stored arguments ran — the turn body supplied none.
    expect(filesystem.calls).toEqual(["listDirectory:/home/docs"]);

    // The turn is recorded against the approval's OWN conversation, resumed
    // with its persisted bound (3 here), as ONE already-spent round.
    expect(conversationMocks.loadAgentConversationState).toHaveBeenCalledWith(
      USER_ID,
      CONVERSATION_ID,
    );
    expect(conversationMocks.beginAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        maxToolRounds: 3,
        toolCalls: [{ id: approvalId, toolName: "list_directory", input: { path: "/home/docs" } }],
      }),
    );
    expect(conversationMocks.completeAgentTurn).toHaveBeenCalledTimes(1);
    expect(conversationMocks.persistAgentTurn).not.toHaveBeenCalled();
    expect(conversationMocks.cancelAgentTurn).not.toHaveBeenCalled();

    // The provider saw the executed result as its ONLY context (round one).
    expect(generate).toHaveBeenCalledTimes(1);
    expect(requests[0]).toBeDefined();
    if (requests[0] === undefined) return;
    expect(requests[0].message).toBe("Continue after approval.");
    // The loop serves the REGISTERED tool subset (this registry registers the
    // gated list_directory + search_files only) plus the executed result.
    expect(requests[0].tools.map((tool) => tool.name)).toEqual(["list_directory", "search_files"]);
    expect(requests[0].toolResults).toEqual([
      {
        ok: true,
        callId: approvalId,
        toolName: "list_directory",
        toolInput: { path: "/home/docs" },
        data: homeListing("/home/docs"),
      },
    ]);

    // Stable response: one round, safe tool-result synopsis, no new approvals.
    expect(response.conversationId).toBe(CONVERSATION_ID);
    expect(response.turn.toolRounds).toBe(1);
    expect(response.turn.finalText).toBe("FYI: docs are listed.");
    expect(response.turn.maxToolRounds).toBe(3);
    expect(response.turn.toolResults).toEqual([{ callId: approvalId, ok: true }]);
    expect(response.turn.pendingApprovals).toEqual([]);

    // Consumed: still `approved` (no consumed status exists) but its window
    // was backdated to the execution time — every later guard fails closed.
    expect(approvalRepo.rows[0]?.status).toBe("approved");
    if (approvalRepo.rows[0] === undefined) return;
    expect(approvalRepo.rows[0].expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

// ---------------------------------------------------------------------------
// 2. Decision guards: rejected / expired approvals are 400s, never executed
// ---------------------------------------------------------------------------

describe("instruction flow — rejected and expired approvals cannot resume", () => {
  it("rejects a REJECTED approval with 400 and executes nothing", async () => {
    const filesystem = makeFilesystem();
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home/docs" },
      makeInvokeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");
    const approvalId = pending.approval.approvalId;
    await approvalRepo.resolveToolApproval(
      USER_ID,
      approvalId,
      approvalRepo.Decision.Reject,
      new Date(),
    );
    expect(approvalRepo.rows[0]?.status).toBe("rejected");

    const { generate } = scriptedProvider([{ text: "must not run" }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }, { filesystem }));

    await expect(
      runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
        instruction: "Continue.",
        approvalId,
      }),
    ).rejects.toMatchObject({ status: 400, code: "common/bad-request" });

    expect(filesystem.calls).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    expect(conversationMocks.loadAgentConversationState).not.toHaveBeenCalled();
  });

  it("rejects an EXPIRED approval with 400 and executes nothing", async () => {
    const filesystem = makeFilesystem();
    const pending = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/home/docs" },
      makeInvokeOptions(),
    );
    if (!isToolApprovalRequiredResult(pending)) return expect.unreachable("pending expected");
    const approvalId = pending.approval.approvalId;
    await approveAiToolApproval(USER_ID, approvalId, new Date());
    // The window elapses after the decision.
    approvalRepo.rows[0]!.expiresAt = new Date(Date.now() - 1000);

    const { generate } = scriptedProvider([{ text: "must not run" }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }, { filesystem }));

    await expect(
      runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
        instruction: "Continue.",
        approvalId,
      }),
    ).rejects.toMatchObject({ status: 400, code: "common/bad-request" });

    expect(filesystem.calls).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    expect(conversationMocks.loadAgentConversationState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Ownership: foreign is 404; a mismatched conversationId is 400
// ---------------------------------------------------------------------------

describe("instruction flow — ownership and conversation binding on resume", () => {
  it("treats a FOREIGN approval as missing (404) and executes nothing", async () => {
    const filesystem = makeFilesystem();
    const { approvalId } = await createApprovedApproval(makeFilesystem());

    const { generate } = scriptedProvider([{ text: "must not run" }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }, { filesystem }));

    await expect(
      runAiInstructionWithRuntime(runtime, sessionContext(BOB), {
        instruction: "Continue.",
        approvalId,
      }),
    ).rejects.toMatchObject({ status: 404, code: "common/not-found" });

    expect(filesystem.calls).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    expect(conversationMocks.loadAgentConversationState).not.toHaveBeenCalled();
  });

  it("rejects a conversationId that is not the approval's own (400) and executes nothing", async () => {
    const filesystem = makeFilesystem();
    const { approvalId } = await createApprovedApproval(makeFilesystem());

    const { generate } = scriptedProvider([{ text: "must not run" }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }, { filesystem }));

    await expect(
      runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
        instruction: "Continue.",
        conversationId: OTHER_CONVERSATION_ID,
        approvalId,
      }),
    ).rejects.toMatchObject({ status: 400, code: "common/bad-request" });

    expect(filesystem.calls).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    expect(conversationMocks.beginAgentTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Replay prevention: a consumed approval never authorizes again
// ---------------------------------------------------------------------------

describe("instruction flow — a consumed approval cannot be replayed", () => {
  it("refuses a second resume AND the invocation boundary after the first execution", async () => {
    const filesystem = makeFilesystem();
    const { approvalId } = await createApprovedApproval(filesystem);
    const { generate } = scriptedProvider([{ text: "Done first run." }, { text: "must not run" }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }, { filesystem }));

    const first = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Continue.",
      approvalId,
    });
    expect(first.turn.toolRounds).toBe(1);
    expect(filesystem.calls).toEqual(["listDirectory:/home/docs"]);

    // Second resume: the record is still `approved` but its window was
    // backdated on consume, so the executable guard fails closed as expired.
    await expect(
      runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
        instruction: "Continue again.",
        approvalId,
      }),
    ).rejects.toMatchObject({ status: 400, code: "common/bad-request" });

    // Coincident invocation-boundary attempt is dead too.
    const retry = await invokeTool(
      sessionContext(ALICE),
      "list_directory",
      { path: "/etc/passwd" },
      makeInvokeOptions({ filesystem, approvalId }),
    );
    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.error.code).toBe(ToolErrorCode.ApprovalNotExecutable);
    expect(retry.error.message).toContain("expired");

    // Exactly ONE execution across every attempt.
    expect(filesystem.calls).toEqual(["listDirectory:/home/docs"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Bound: the approval's conversation budget applies from round one
// ---------------------------------------------------------------------------

describe("instruction flow — resumed turns are bounded by the approval's conversation", () => {
  it("refuses further tools past the persisted maxToolRounds with 502 and compensates", async () => {
    conversationMocks.loadAgentConversationState.mockResolvedValue(ownedConversationState(1));
    const filesystem = makeFilesystem();
    const { approvalId } = await createApprovedApproval(filesystem);

    // The approved execution already used the conversation's single round; the
    // provider asking for one more tool must be refused WITHOUT executing it.
    const { generate } = scriptedProvider([
      { toolCalls: [call("t2", "list_directory", { path: "/etc" })] },
    ]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }, { filesystem }));

    await expect(
      runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
        instruction: "Continue.",
        approvalId,
      }),
    ).rejects.toMatchObject({ status: 502, code: "ai/max-tool-rounds-reached" });

    expect(filesystem.calls).toEqual(["listDirectory:/home/docs"]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(conversationMocks.completeAgentTurn).not.toHaveBeenCalled();
    expect(conversationMocks.cancelAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        created: true,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Regression: parse still governs the body shape
// ---------------------------------------------------------------------------

describe("instruction flow — approvalId body validation", () => {
  it("rejects a malformed approvalId BEFORE the runtime is contacted", async () => {
    const runtime: PersistentAgentTurnRuntime = {
      async run() {
        throw new Error("runtime must not be contacted");
      },
    };
    await expect(
      runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
        instruction: "Continue.",
        approvalId: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ status: 400, code: "common/bad-request" });
  });

  it("rejects an approvalId without the required instruction", async () => {
    const runtime: PersistentAgentTurnRuntime = {
      async run() {
        throw new Error("runtime must not be contacted");
      },
    };
    await expect(
      runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
        approvalId: CONVERSATION_ID,
      }),
    ).rejects.toMatchObject({ status: 400, code: "common/bad-request" });
  });
});

// ---------------------------------------------------------------------------
// 7. Approved host writes (§6.9): an approved move_file DEFERS behind a host
//    execution (never runs through the executor here), and the approval is
//    consumed only on the subsequent host-execution resume — exactly once.
// ---------------------------------------------------------------------------

describe("instruction flow — approved host write (move_file) defers to the host (§6.9)", () => {
  const MOVED_ARGS = {
    sourcePath: "/home/receipt.pdf",
    destinationPath: "/home/docs/receipt.pdf",
  };

  /** Seed an approved, unexpired `move_file` approval directly into the repo. */
  async function seedApprovedMoveFileApproval(): Promise<string> {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const now = new Date();
    approvalRepo.rows.push({
      id,
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      toolName: "move_file",
      arguments: MOVED_ARGS,
      status: approvalRepo.Status.Approved,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: now,
    });
    return id;
  }

  it("DEFERS an approved move_file: pauses with a pending execution, nothing executes here, approval unconsumed", async () => {
    const approvalId = await seedApprovedMoveFileApproval();
    const filesystem = makeFilesystem();
    const { generate } = scriptedProvider([{ text: "must not run" }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }, { filesystem }));

    const response = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Continue after approval.",
      approvalId,
    });

    // The approved operation did NOT resume through the executor: the move was
    // recorded as ONE pending host execution for the desktop host instead.
    expect(filesystem.calls).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    expect(response.conversationId).toBe(CONVERSATION_ID);
    expect(response.turn.pendingApprovals).toEqual([]);
    expect(hostStore.rows).toHaveLength(1);
    const pending = response.turn.pendingExecutions;
    expect(pending).toHaveLength(1);
    if (pending[0] === undefined) return;
    expect(pending[0]).toMatchObject({
      executionId: hostStore.rows[0]!.id,
      toolName: "move_file",
      arguments: MOVED_ARGS,
    });
    // The eager transcript persisted THIS deferred round by design — no
    // finalize, nothing compensated (a pause, not a failure).
    expect(conversationMocks.beginAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        toolCalls: [{ id: approvalId, toolName: "move_file", input: MOVED_ARGS }],
      }),
    );
    expect(conversationMocks.completeAgentTurn).not.toHaveBeenCalled();
    expect(conversationMocks.cancelAgentTurn).not.toHaveBeenCalled();
    // The result is NOT attached at pause time — persistence happens on the
    // host-execution RESUME, after the execution seals.
    expect(conversationMocks.attachAgentMessageToolResult).not.toHaveBeenCalled();
    // The approval is NOT consumed at defer time — it stays decidable until
    // the execution actually SEALS on the host-execution resume.
    expect(approvalRepo.rows[0]?.status).toBe("approved");
    expect(approvalRepo.rows[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("SEALS the execution AND consumes the approval on host resume, then completes the turn", async () => {
    const approvalId = await seedApprovedMoveFileApproval();
    const filesystem = makeFilesystem();
    const { generate, requests } = scriptedProvider([{ text: "Moved." }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }, { filesystem }));

    // 1. The approved move pauses as a pending execution (real flow).
    const paused = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Continue after approval.",
      approvalId,
    });
    const executionId = paused.turn.pendingExecutions[0]!.executionId;
    expect(hostStore.rows[0]?.status).toBe("pending");

    // 2. The desktop host moves the file locally; its result is submitted.
    const response = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Continue after the requested operations have been executed.",
      resumeExecutions: [
        {
          executionId,
          ok: true,
          result: { movedFrom: MOVED_ARGS.sourcePath, movedTo: MOVED_ARGS.destinationPath },
        },
      ],
    });

    // Sealed exactly once and the loop seeded the host's result as context.
    expect(hostStore.rows[0]?.status).toBe("executed");
    expect(hostStore.rows[0]?.executedAt).not.toBeNull();
    expect(requests[0]?.toolResults).toEqual([
      {
        ok: true,
        callId: approvalId,
        toolName: "move_file",
        toolInput: MOVED_ARGS,
        data: { movedFrom: MOVED_ARGS.sourcePath, movedTo: MOVED_ARGS.destinationPath },
      },
    ]);
    // The completed result was PERSISTED onto the deferred round's message
    // (Phase A): a later turn reconstructs the actual result, not a bare call.
    expect(conversationMocks.attachAgentMessageToolResult).toHaveBeenCalledWith({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      toolResult: {
        ok: true,
        callId: approvalId,
        toolName: "move_file",
        toolInput: MOVED_ARGS,
        data: { movedFrom: MOVED_ARGS.sourcePath, movedTo: MOVED_ARGS.destinationPath },
      },
    });
    expect(response.turn.finalText).toBe("Moved.");
    expect(response.turn.pendingExecutions).toEqual([]);
    // The approval was consumed ONLY AFTER successful sealing.
    expect(approvalRepo.rows[0]?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("SEALS the execution AND consumes the approval when resuming with the DESKTOP DRIVER payload (conversationId + resumeExecutions)", async () => {
    const approvalId = await seedApprovedMoveFileApproval();
    const filesystem = makeFilesystem();
    const { generate, requests } = scriptedProvider([{ text: "Moved." }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }, { filesystem }));

    // 1. The approved move pauses as a pending execution (real flow).
    const paused = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Continue after approval.",
      approvalId,
    });
    const executionId = paused.turn.pendingExecutions[0]!.executionId;
    expect(hostStore.rows).toHaveLength(1);
    expect(hostStore.rows[0]?.status).toBe("pending");
    // The execution stays bound to the approval AND its conversation.
    expect(hostStore.rows[0]?.approvalId).toBe(approvalId);
    expect(hostStore.rows[0]?.conversationId).toBe(CONVERSATION_ID);

    // 2. The desktop driver submits the host's result using its EXACT payload
    //    shape: `{ conversationId, instruction, resumeExecutions }`.
    const response = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      conversationId: CONVERSATION_ID,
      instruction: "Continue after the requested operations have been executed.",
      resumeExecutions: [
        {
          executionId,
          ok: true,
          result: { movedFrom: MOVED_ARGS.sourcePath, movedTo: MOVED_ARGS.destinationPath },
        },
      ],
    });

    // The pending execution was resumed: sealed exactly once and its result
    // seeded into the loop as provider context.
    expect(hostStore.rows).toHaveLength(1);
    expect(hostStore.rows[0]?.status).toBe("executed");
    expect(hostStore.rows[0]?.executedAt).not.toBeNull();
    expect(hostStore.rows[0]?.approvalId).toBe(approvalId);
    expect(hostStore.rows[0]?.conversationId).toBe(CONVERSATION_ID);
    expect(requests[0]?.toolResults).toEqual([
      {
        ok: true,
        callId: approvalId,
        toolName: "move_file",
        toolInput: MOVED_ARGS,
        data: { movedFrom: MOVED_ARGS.sourcePath, movedTo: MOVED_ARGS.destinationPath },
      },
    ]);
    // The desktop-driver payload persists the completed result too (Phase A).
    expect(conversationMocks.attachAgentMessageToolResult).toHaveBeenCalledWith({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      toolResult: {
        ok: true,
        callId: approvalId,
        toolName: "move_file",
        toolInput: MOVED_ARGS,
        data: { movedFrom: MOVED_ARGS.sourcePath, movedTo: MOVED_ARGS.destinationPath },
      },
    });

    // The turn produced the expected final result.
    expect(response.conversationId).toBe(CONVERSATION_ID);
    expect(response.turn.finalText).toBe("Moved.");
    expect(response.turn.pendingExecutions).toEqual([]);
    expect(response.turn.pendingApprovals).toEqual([]);

    // The approval was consumed/sealed ONLY AFTER the execution sealed —
    // it is no longer usable (its decision window is closed).
    expect(approvalRepo.rows[0]?.status).toBe("approved");
    expect(approvalRepo.rows[0]?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("is IDEMPOTENT on a re-submitted approval resume: reuses the first pending execution", async () => {
    const approvalId = await seedApprovedMoveFileApproval();
    const { generate } = scriptedProvider([{ text: "must not run" }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }));

    const first = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Continue after approval.",
      approvalId,
    });
    const firstId = first.turn.pendingExecutions[0]!.executionId;
    expect(hostStore.rows).toHaveLength(1);

    const again = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Continue after approval.",
      approvalId,
    });

    expect(hostStore.rows).toHaveLength(1); // no second execution for the same approval
    expect(again.turn.pendingExecutions).toHaveLength(1);
    expect(again.turn.pendingExecutions[0]?.executionId).toBe(firstId);
    expect(conversationMocks.beginAgentTurn).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses a SECOND host-execution submission (single-use seal) with 400", async () => {
    const approvalId = await seedApprovedMoveFileApproval();
    const { generate } = scriptedProvider([{ text: "Once." }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }));

    const paused = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Continue after approval.",
      approvalId,
    });
    const executionId = paused.turn.pendingExecutions[0]!.executionId;

    const submit = () =>
      runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
        instruction: "Continue.",
        resumeExecutions: [
          {
            executionId,
            ok: true,
            result: { movedFrom: MOVED_ARGS.sourcePath, movedTo: MOVED_ARGS.destinationPath },
          },
        ],
      });

    await submit();
    // The sealed execution can never authorize a second submission.
    await expect(submit()).rejects.toMatchObject({
      status: 400,
      code: "common/bad-request",
    });
    expect(hostStore.rows[0]?.status).toBe("executed");
    expect(generate).toHaveBeenCalledTimes(1);
    // Persisted EXACTLY once — the rejected re-submission never re-attaches.
    expect(conversationMocks.attachAgentMessageToolResult).toHaveBeenCalledTimes(1);
  });

  it("makes the persisted host-execution result part of a LATER turn's history (not a bare tool-call)", async () => {
    const approvalId = await seedApprovedMoveFileApproval();
    const filesystem = makeFilesystem();
    const { generate, requests } = scriptedProvider([{ text: "Moved." }, { text: "Done." }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }, { filesystem }));

    // 1. The approved move pauses; the host executes it; the resume persists
    //    the completed result onto the deferred round's message (Phase A).
    const paused = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Continue after approval.",
      approvalId,
    });
    const executionId = paused.turn.pendingExecutions[0]!.executionId;
    await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Continue after the requested operations have been executed.",
      resumeExecutions: [
        {
          executionId,
          ok: true,
          result: { movedFrom: MOVED_ARGS.sourcePath, movedTo: MOVED_ARGS.destinationPath },
        },
      ],
    });
    expect(conversationMocks.attachAgentMessageToolResult).toHaveBeenCalledTimes(1);

    // 2. A LATER turn loads the conversation transcript — the deferred round
    //    now carries its persisted actual result.
    const t = new Date("2026-01-01T00:00:00Z");
    conversationMocks.loadAgentConversationMessages.mockResolvedValue([
      { role: "user", content: "Continue after approval.", isFinal: false, createdAt: t },
      {
        role: "assistant",
        content: "",
        isFinal: false,
        createdAt: new Date(t.getTime() + 1000),
        toolCalls: [{ id: approvalId, toolName: "move_file", input: MOVED_ARGS }],
        toolResults: [
          {
            ok: true,
            callId: approvalId,
            toolName: "move_file",
            toolInput: MOVED_ARGS,
            data: { movedFrom: MOVED_ARGS.sourcePath, movedTo: MOVED_ARGS.destinationPath },
          },
        ],
      },
    ]);

    const response = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Update the user.",
      conversationId: CONVERSATION_ID,
    });

    // The provider reconstructed the ACTUAL completed result for the deferred
    // round — exactly the same history shape `toAgentHistory` serves from the
    // stored `tool_results` — instead of a bare tool-call intent.
    expect(requests[1]?.history).toEqual([
      { role: "user", text: "Continue after approval." },
      {
        role: "assistant",
        toolCalls: [{ id: approvalId, toolName: "move_file", input: MOVED_ARGS }],
        toolResults: [
          {
            ok: true,
            callId: approvalId,
            toolName: "move_file",
            toolInput: MOVED_ARGS,
            data: { movedFrom: MOVED_ARGS.sourcePath, movedTo: MOVED_ARGS.destinationPath },
          },
        ],
      },
    ]);
    expect(response.turn.finalText).toBe("Done.");
  });
});

// ---------------------------------------------------------------------------
// 7. Cross-turn context: loadAgentConversationMessages is called and its
//    output reaches the provider as history
// ---------------------------------------------------------------------------

describe("instruction flow — cross-turn history", () => {
  function storedMessages(): Array<{
    role: string;
    content: string;
    toolCalls?: unknown;
    toolResults?: unknown;
    isFinal: boolean;
    createdAt: Date;
  }> {
    const t = new Date("2026-01-01T00:00:00Z");
    return [
      { role: "user", content: "Find cross.jpg", isFinal: false, createdAt: t },
      {
        role: "assistant",
        content: "",
        isFinal: false,
        createdAt: t,
        toolCalls: [
          { id: "t1", toolName: "search_files", input: { query: "cross.jpg" } },
        ],
        toolResults: [
          {
            ok: true,
            callId: "t1",
            toolName: "search_files",
            toolInput: { query: "cross.jpg" },
            data: [{ path: "/Users/apple/Testing/cross.jpg" }],
          },
        ],
      },
      { role: "assistant", content: "Found it.", isFinal: true, createdAt: t },
    ];
  }

  it("loads and forwards the full conversation history to the provider as initialHistory", async () => {
    conversationMocks.loadAgentConversationMessages.mockResolvedValue(storedMessages());

    const { generate, requests } = scriptedProvider([{ text: "Moving it now." }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }));

    const response = await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Move cross to desktop folder",
      conversationId: CONVERSATION_ID,
    });

    // The repository was asked for the conversation's full transcript.
    expect(conversationMocks.loadAgentConversationMessages).toHaveBeenCalledWith(
      USER_ID,
      CONVERSATION_ID,
    );

    // The provider saw initialHistory on its first request.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(requests[0]).toBeDefined();
    if (!requests[0]) return;
    expect(requests[0].message).toBe("Move cross to desktop folder");
    expect(requests[0].history).toEqual([
      { role: "user", text: "Find cross.jpg" },
      {
        role: "assistant",
        toolCalls: [
          { id: "t1", toolName: "search_files", input: { query: "cross.jpg" } },
        ],
        toolResults: [
          {
            ok: true,
            callId: "t1",
            toolName: "search_files",
            toolInput: { query: "cross.jpg" },
            data: [{ path: "/Users/apple/Testing/cross.jpg" }],
          },
        ],
      },
      { role: "assistant", text: "Found it." },
    ]);

    expect(response.conversationId).toBe(CONVERSATION_ID);
    expect(response.turn.finalText).toBe("Moving it now.");
  });

  it("omits history when the conversation has no prior messages", async () => {
    conversationMocks.loadAgentConversationMessages.mockResolvedValue([]);

    const { generate, requests } = scriptedProvider([{ text: "Fresh." }]);
    const runtime = makeInstructionRuntime(makeRuntimeOptions({ generate }));

    await runAiInstructionWithRuntime(runtime, sessionContext(ALICE), {
      instruction: "Start fresh",
      conversationId: CONVERSATION_ID,
    });

    expect(requests[0]).toBeDefined();
    if (!requests[0]) return;
    expect(requests[0].history).toBeUndefined();
  });
});
