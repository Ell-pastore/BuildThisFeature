/**
 * Phase 2 plan execution — deterministic provider + resolver + runtime.
 *
 * The deterministic plan-executor provider (`createPlanExecutorProvider`) and
 * the reference resolver (`resolvePlanReferences`) run REAL, through the real
 * `runPersistentTurn` → `runAgentLoop` → `routeAgentResponse` → `invokeTool`
 * pipeline. The deterministic provider is a pure state machine that never
 * contacts an LLM: it emits `search_files` when needed, resolves references
 * from search results, issues `move_file`, and terminates on the move result.
 *
 * Three seams are mocked:
 *   - the approval repository (in-memory, faithfully mirrors produce → resolve
 *     → consume so the REAL contract validation and executable guard run);
 *   - the host-execution store (in-memory create → get-pending-by-approval
 *     → seal single-use — §6.9 host-delegated path);
 *   - the agent-conversation persistence (eager turn transcript for the
 *     real `runPersistentTurn` eager persistence path).
 *
 * Coverage:
 *
 *   A. PROVIDER/RESOLVER PURE:
 *     1. Stateless step machine: identical inputs produce identical outputs.
 *     2. Ambiguous semantic source rejection.
 *     3. Missing semantic source (not-found).
 *     4. Missing / wrong-kind semantic destination (not-found).
 *     5. Folder source unsupported (at validation + resolution).
 *
 *   B. PLAN VALIDATION (defense-in-depth):
 *     6. parseAiPlanExecutionInput strictness + validatePlanForExecution
 *        rejects non-MOVE, missing destination, semantic without name/description.
 *
 *   C. FULL-FLOW RUNTIME:
 *     7. Semantic MOVE resolve + invoke: search → resolution → approval CREATE,
 *        resolved args, no in-process execution, planner isolation.
 *     8. Absolute path refs: no discovery, approval created with verbatim paths,
 *        destination folder + source filename preserved.
 *     9. Approval reuse via invokeTool: approved approval executes the stored
 *        exact arguments through the existing gate, ignoring caller input.
 *    10. §6.9 success-after-executor: absolute plan → approval → approve →
 *        resume{approvalId} → pendingExecutions → resume{resumeExecutions} →
 *        terminal success text.
 *    11. §6.9 host failure surfaced: same flow, host resumes with ok:false →
 *        terminal failure text.
 *    12. Planner isolation: no `plan_intent` tool call or re-planning occurs;
 *        only sfm-* tool results appear.
 *    13. Phase 1 → Phase 2 regression: `buildFileIntentPlan` output runs
 *        through the executor end-to-end without re-planning.
 *
 *   D. PHASE 4 — COPY EXECUTION:
 *    14. Provider/resolver pure: semantic COPY → both searches → `copy_file`
 *        with a DIRECTORY-shaped `destDirPath` (never a filename-appended
 *        exact path); absolute COPY issues no discovery; statelessness.
 *    15. `resolvePlanReferences` COPY: absolute → `destDirPath` is the folder
 *        verbatim; semantic → folder filtered by kind+location, no filename
 *        append; missing/ambiguous/wrong-kind destination → typed errors;
 *        folder source → unsupported; missing destination search → invalid.
 *    16. `validatePlanForExecution` COPY: accepts valid plans; rejects
 *        missing destination, folder sources, approval-flag tampering, and
 *        non-COPY/MOVE/RENAME intents.
 *    17. Full-flow semantic COPY end-to-end: search → resolution → preflight →
 *        approval CREATE with `{ sourcePath, destDirPath }`; no in-process
 *        copy; planner isolation (sfm-* ids only).
 *    18. Absolute COPY end-to-end: no discovery; verbatim directory.
 *    19. Approval reuse via invokeTool with an approved `copy_file` approval:
 *        stored exact args execute, caller-smuggled input ignored.
 *    20. §6.9 host-delegated COPY: approval → defer → host resume success and
 *        failure fidelity ("Copied…", "The copy did not complete…").
 *    21. Destination preconditions surface as executable failures:
 *        destination-folder missing and same-named destination already exists
 *        (no clobber); AllowList/security failure fidelity.
 *    22. Phase 1 → Phase 4 regression: planner-produced COPY plan runs
 *        without re-planning.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../tools/registry.js";
import { ToolError, ToolErrorCode } from "../tools/errors.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import {
  readToolDefinitions,
  registerReadTools,
} from "../tools/definitions/readTools.js";
import {
  writeToolDefinitions,
  registerWriteTools,
} from "../tools/definitions/writeTools.js";
import type { DirectoryListing, FileEntry, FileMetadata } from "../tools/tauriShapes.js";
import {
  buildFileIntentPlan,
  type FileIntentPlan,
  type EntityIntentReference,
} from "../tools/handlers/planIntent.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentToolResult } from "./agent.js";
import type { AgentProviderRequest } from "./provider.js";
import { approveAiToolApproval } from "./aiToolApprovals.js";
import {
  invokeTool,
  isToolApprovalRequiredResult,
  type InvokeToolOptions,
} from "./tools.js";
import {
  runPersistentTurn,
  type PersistentTurnOptions,
  type PersistentAgentTurnRuntime,
} from "./persistentAgentTurn.js";
import { createConversationState, finalizeConversation } from "./conversation.js";
import {
  MAX_PLAN_EXECUTION_TOOL_ROUNDS,
  PLAN_PAYLOAD_IDS,
  PlanExecutionError,
  PlanExecutionErrorCode,
  createPlanExecutionRuntime,
  createPlanExecutorProvider,
  parseAiPlanExecutionInput,
  resolvePlanReferences,
  runAiPlanExecutionWithRuntime,
  validatePlanForExecution,
  type PlanExecutionRuntime,
} from "./aiPlanExecutions.js";
import { AppError } from "../core/errors.js";

// ---------------------------------------------------------------------------
// In-memory approval repository (mirrors produce → resolve → CONSUME; the
// REAL contract validation and executable guard run).
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
  const Decision = {
    Approve: "approved",
    Reject: "rejected",
  } as const;
  class NotFoundError extends Error {
    constructor() {
      super("Tool approval not found for this user.");
      this.name = "ToolApprovalNotFoundError";
    }
  }
  class DuplicateError extends Error {
    readonly messageId: string;
    readonly toolName: string;
    constructor(messageId: string, toolName: string) {
      super(
        `A pending approval already exists for tool "${toolName}" in message "${messageId}".`,
      );
      this.name = "ToolApprovalDuplicateError";
      this.messageId = messageId;
      this.toolName = toolName;
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
// In-memory host-execution service seam (§6.9 approved host writes).
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
        (r) =>
          r.userId === userId &&
          r.approvalId === approvalId &&
          r.status === Status.Pending,
      ) ?? null
    );
  }

  async function getAiHostExecution(userId: string, executionId: string): Promise<Row | null> {
    return rows.find((r) => r.userId === userId && r.id === executionId) ?? null;
  }

  async function submitHostExecution(
    userId: string,
    executionId: string,
    now: Date,
  ): Promise<Row> {
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
// Agent-conversation persistence (eager turn transcript).
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

const CONVERSATION_ID = "55555555-5555-5555-5555-555555555555";
const MESSAGE_ID = "66666666-6666-6666-6666-666666666666";
const INSTRUCTION_MESSAGE_ID = "77777777-7777-4777-8777-777777777777";

/** The approval's OWN conversation, finalized (ready for the resume turn). */
function ownedConversationState(maxToolRounds = 3) {
  return finalizeConversation(
    createConversationState({
      instruction: "Move my file.",
      maxToolRounds,
    }),
    "Approval requested.",
  );
}

function sessionContext(user: unknown): { get: (key: string) => unknown } {
  return { get: (key) => (key === "user" ? user : undefined) };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function fileMeta(path: string, name?: string): FileMetadata {
  return {
    name: name ?? path.split(/[\\/]/).pop() ?? "",
    path,
    isFile: true,
    isFolder: false,
    sizeBytes: 100,
    extension: null,
    isHidden: false,
    modified: "2026-01-01T00:00:00.000Z",
    modifiedTs: 0,
    created: "2026-01-01T00:00:00.000Z",
    createdTs: 0,
    accessed: null,
    accessedTs: null,
  };
}

function folderMeta(path: string, name?: string): FileMetadata {
  return {
    ...fileMeta(path, name),
    isFile: false,
    isFolder: true,
    sizeBytes: 0,
    extension: null,
  };
}

function fileEntry(path: string, name: string, isFolder = false): FileEntry {
  return {
    id: `id-${path}`,
    name,
    path,
    isFolder,
    sizeBytes: isFolder ? 0 : 100,
    itemCount: isFolder ? 1 : null,
    fileType: isFolder ? "folder" : "file",
    size: isFolder ? "0" : "100",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    modifiedTs: 0,
    createdTs: 0,
  };
}

function makeFillableFilesystem(options?: {
  metadata?: Record<string, FileMetadata>;
  search?: Record<string, FileEntry[]>;
}): FilesystemExecutor & { calls: string[] } {
  const calls: string[] = [];
  const metadata: Record<string, FileMetadata> = { ...(options?.metadata ?? {}) };
  const searchMap: Record<string, FileEntry[]> = { ...(options?.search ?? {}) };
  return {
    calls,
    async listDirectory(path: string): Promise<DirectoryListing> {
      calls.push(`listDirectory:${path}`);
      return { path, parentPath: null, isHome: false, items: [] };
    },
    async searchFiles(query: string) {
      calls.push(`searchFiles:${query}`);
      return searchMap[query] ?? [];
    },
    async getFileMetadata(path: string) {
      calls.push(`getFileMetadata:${path}`);
      const found = metadata[path];
      if (found === undefined) {
        throw new Error(`The path "${path}" does not exist.`);
      }
      return found;
    },
    async readFile() {
      throw new Error("not used in this test");
    },
    async moveFile(source: string, destination: string) {
      calls.push(`moveFile:${source}->${destination}`);
      const src = metadata[source];
      if (src === undefined) {
        throw new Error(`The path "${source}" does not exist.`);
      }
      delete metadata[source];
      metadata[destination] = fileMeta(destination);
    },
    async copyFile(source: string, destDirPath: string) {
      calls.push(`copyFile:${source}->${destDirPath}`);
      const src = metadata[source];
      if (src === undefined) {
        throw new Error(`The path "${source}" does not exist.`);
      }
      const destDir = metadata[destDirPath];
      if (destDir === undefined || !destDir.isFolder) {
        throw new Error(`The path "${destDirPath}" is not a folder.`);
      }
      const name = source.split("/").pop() ?? "";
      const target = destDirPath + "/" + name;
      if (metadata[target] !== undefined) {
        throw new Error(`The path "${target}" already exists.`);
      }
      metadata[target] = fileMeta(target);
    },
  };
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function makeRealRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  return registry;
}

function makeInvokeOptions(
  overrides?: Partial<InvokeToolOptions>,
): InvokeToolOptions {
  return {
    registry: makeRealRegistry(),
    filesystem: makeFillableFilesystem(),
    turnContext: { conversationId: CONVERSATION_ID, messageId: MESSAGE_ID },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

function makePlanRuntime(options: {
  filesystem: FilesystemExecutor;
  registry?: ToolRegistry;
  maxToolRounds?: number;
}): PlanExecutionRuntime {
  const registry = options.registry ?? makeRealRegistry();
  return createPlanExecutionRuntime({
    registry,
    tools: [...readToolDefinitions, ...writeToolDefinitions],
    filesystem: options.filesystem,
    maxToolRounds: options.maxToolRounds ?? MAX_PLAN_EXECUTION_TOOL_ROUNDS,
  });
}

// ---------------------------------------------------------------------------
// Plan fixtures
// ---------------------------------------------------------------------------

const SEMANTIC_PLAN: FileIntentPlan = {
  intent: "MOVE",
  source: {
    reference: "semantic",
    kind: "file",
    name: "receipt.pdf",
    location: "/home/Downloads",
  },
  destination: {
    reference: "semantic",
    kind: "folder",
    name: "docs",
    location: "/home",
  },
  operation: {},
  requiresApproval: true,
  supported: true,
};

const ABSOLUTE_PLAN: FileIntentPlan = {
  intent: "MOVE",
  source: { reference: "path", kind: "file", absolutePath: "/home/Downloads/receipt.pdf" },
  destination: { reference: "path", kind: "folder", absolutePath: "/home/docs" },
  operation: {},
  requiresApproval: true,
  supported: true,
};

const SEMANTIC_RENAME_PLAN: FileIntentPlan = {
  intent: "RENAME",
  source: {
    reference: "semantic",
    kind: "file",
    name: "cross.jpg",
    location: "/home/photos",
  },
  operation: { newName: "cross-final.jpg" },
  requiresApproval: true,
  supported: true,
};

const ABSOLUTE_RENAME_PLAN: FileIntentPlan = {
  intent: "RENAME",
  source: { reference: "path", kind: "file", absolutePath: "/home/photos/cross.jpg" },
  operation: { newName: "cross-final.jpg" },
  requiresApproval: true,
  supported: true,
};

/** A rename plan whose secret destination reference must be ignored. */
const ABSOLUTE_RENAME_PLAN_WITH_SMUGGLED_DEST: FileIntentPlan = {
  ...ABSOLUTE_RENAME_PLAN,
  destination: { reference: "path", kind: "file", absolutePath: "/etc/evil/other.jpg" },
};

const SEMANTIC_COPY_PLAN: FileIntentPlan = {
  intent: "COPY",
  source: {
    reference: "semantic",
    kind: "file",
    name: "receipt.pdf",
    location: "/home/Downloads",
  },
  destination: {
    reference: "semantic",
    kind: "folder",
    name: "docs",
    location: "/home",
  },
  operation: {},
  requiresApproval: true,
  supported: true,
};

const ABSOLUTE_COPY_PLAN: FileIntentPlan = {
  intent: "COPY",
  source: { reference: "path", kind: "file", absolutePath: "/home/Downloads/receipt.pdf" },
  destination: { reference: "path", kind: "folder", absolutePath: "/home/docs" },
  operation: {},
  requiresApproval: true,
  supported: true,
};

/** A COPY plan whose destination silently omits a folder-kind destination. */
const ABSOLUTE_COPY_PLAN_FILE_DEST: FileIntentPlan = {
  ...ABSOLUTE_COPY_PLAN,
  destination: { reference: "path", kind: "file", absolutePath: "/home/docs" },
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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

// ===================================================================
// A. Deterministic provider / resolver (pure)
// ===================================================================

describe("deterministic plan-executor provider", () => {
  it("is a stateless step machine: search → move → terminal, identical inputs → identical outputs", async () => {
    const provider = createPlanExecutorProvider(SEMANTIC_PLAN);

    const sourceResult: AgentToolResult = {
      ok: true,
      callId: PLAN_PAYLOAD_IDS.sourceSearch,
      toolName: "search_files",
      toolInput: { query: "receipt.pdf" },
      data: [fileEntry("/home/Downloads/receipt.pdf", "receipt.pdf")],
    };
    const destResult: AgentToolResult = {
      ok: true,
      callId: PLAN_PAYLOAD_IDS.destinationSearch,
      toolName: "search_files",
      toolInput: { query: "docs" },
      data: [fileEntry("/home/docs", "docs", true)],
    };

    // Round 1: no results → both searches.
    const first = await provider.generate({
      message: "Move receipt.pdf",
      tools: [],
    });
    expect(first.toolCalls?.map((c) => ({ id: c.id, toolName: c.toolName }))).toEqual([
      { id: PLAN_PAYLOAD_IDS.sourceSearch, toolName: "search_files" },
      { id: PLAN_PAYLOAD_IDS.destinationSearch, toolName: "search_files" },
    ]);

    // Round 2: searches present → resolved move.
    const moveRequest: AgentProviderRequest = {
      message: "Move receipt.pdf",
      tools: [],
      toolResults: [sourceResult, destResult],
    };
    const a = await provider.generate(moveRequest);
    const b = await provider.generate(moveRequest);
    expect(b).toEqual(a); // stateless
    expect(a.toolCalls?.[0]).toMatchObject({
      id: PLAN_PAYLOAD_IDS.move,
      toolName: "move_file",
      input: {
        sourcePath: "/home/Downloads/receipt.pdf",
        destinationPath: "/home/docs/receipt.pdf",
      },
    });

    // Round 3: move result → terminal.
    const approved: AgentToolResult = {
      ok: false,
      callId: PLAN_PAYLOAD_IDS.move,
      toolName: "move_file",
      toolInput: {
        sourcePath: "/home/Downloads/receipt.pdf",
        destinationPath: "/home/docs/receipt.pdf",
      },
      error: ToolError.security(
        ToolErrorCode.ApprovalRequired,
        "requires approval",
      ),
    };
    const terminal = await provider.generate({
      message: "Move receipt.pdf",
      tools: [],
      toolResults: [sourceResult, destResult, approved],
    });
    expect(terminal.text).toContain("Approval is required");
  });

  it("accepts a move result seeded with a non-sfm callId (approval resume path)", async () => {
    const provider = createPlanExecutorProvider(ABSOLUTE_PLAN);

    // The §6.9 host resume seeds a result whose callId is the approval id,
    // not the sfm-move payload id. The provider must still terminate.
    const approvalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const moveResult: AgentToolResult = {
      ok: true,
      callId: approvalId,
      toolName: "move_file",
      toolInput: {
        sourcePath: "/home/Downloads/receipt.pdf",
        destinationPath: "/home/docs/receipt.pdf",
      },
      data: {
        movedFrom: "/home/Downloads/receipt.pdf",
        movedTo: "/home/docs/receipt.pdf",
      },
    };
    const terminal = await provider.generate({
      message: "Continue after host execution.",
      tools: [],
      toolResults: [moveResult],
    });
    expect(terminal.text).toBe(
      "Moved the file to /home/docs/receipt.pdf.",
    );
  });
});

// ===================================================================
// A. Resolver unit tests
// ===================================================================

describe("resolvePlanReferences", () => {
  it("rejects an ambiguous semantic source", () => {
    const plan: FileIntentPlan = {
      ...SEMANTIC_PLAN,
      source: { reference: "semantic", kind: "file", name: "receipt.pdf" },
    };
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.sourceSearch,
        toolName: "search_files",
        toolInput: { query: "receipt.pdf" },
        data: [
          fileEntry("/home/Downloads/receipt.pdf", "receipt.pdf"),
          fileEntry("/home/Archive/receipt.pdf", "receipt.pdf"),
        ],
      },
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.destinationSearch,
        toolName: "search_files",
        toolInput: { query: "docs" },
        data: [fileEntry("/home/docs", "docs", true)],
      },
    ];
    expect(() => resolvePlanReferences(plan, results)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Ambiguous,
      }),
    );
  });

  it("rejects a missing semantic source as not-found", () => {
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.sourceSearch,
        toolName: "search_files",
        toolInput: { query: "receipt.pdf" },
        data: [],
      },
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.destinationSearch,
        toolName: "search_files",
        toolInput: { query: "docs" },
        data: [fileEntry("/home/docs", "docs", true)],
      },
    ];
    expect(() => resolvePlanReferences(SEMANTIC_PLAN, results)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.NotFound,
      }),
    );
  });

  it("rejects a missing semantic destination (empty search) as not-found", () => {
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.sourceSearch,
        toolName: "search_files",
        toolInput: { query: "receipt.pdf" },
        data: [fileEntry("/home/Downloads/receipt.pdf", "receipt.pdf")],
      },
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.destinationSearch,
        toolName: "search_files",
        toolInput: { query: "docs" },
        data: [],
      },
    ];
    expect(() => resolvePlanReferences(SEMANTIC_PLAN, results)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.NotFound,
      }),
    );
  });

  it("rejects a semantic destination that resolves only to files (no folders)", () => {
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.sourceSearch,
        toolName: "search_files",
        toolInput: { query: "receipt.pdf" },
        data: [fileEntry("/home/Downloads/receipt.pdf", "receipt.pdf")],
      },
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.destinationSearch,
        toolName: "search_files",
        toolInput: { query: "docs" },
        data: [fileEntry("/home/Downloads/docs", "docs", false)],
      },
    ];
    expect(() => resolvePlanReferences(SEMANTIC_PLAN, results)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.NotFound,
      }),
    );
  });

  it("rejects a folder source as unsupported", () => {
    const plan: FileIntentPlan = {
      ...SEMANTIC_PLAN,
      source: { reference: "semantic", kind: "folder", name: "MyFolder" },
    };
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.sourceSearch,
        toolName: "search_files",
        toolInput: { query: "MyFolder" },
        data: [fileEntry("/home/MyFolder", "MyFolder", true)],
      },
    ];
    expect(() => resolvePlanReferences(plan, results)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Unsupported,
      }),
    );
  });
});

// ===================================================================
// B. Plan validation (defense-in-depth)
// ===================================================================

describe("plan validation (defense-in-depth)", () => {
  it("rejects non-MOVE/non-RENAME/non-COPY intents, missing destinations, and folder sources", () => {
    expect(() =>
      validatePlanForExecution({ ...ABSOLUTE_PLAN, intent: "DELETE" }),
    ).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Unsupported,
      }),
    );

    const noDest = { ...ABSOLUTE_PLAN } as Record<string, unknown>;
    delete noDest.destination;
    expect(() => validatePlanForExecution(noDest)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Invalid,
      }),
    );

    expect(() =>
      validatePlanForExecution({
        ...ABSOLUTE_PLAN,
        source: { reference: "semantic", kind: "folder", name: "x" },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Unsupported,
      }),
    );
  });

  it("rejects a semantic reference without name or description", () => {
    expect(() =>
      validatePlanForExecution({
        ...ABSOLUTE_PLAN,
        source: { reference: "semantic", kind: "file" },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Invalid,
      }),
    );
  });
});

describe("parseAiPlanExecutionInput", () => {
  it("rejects unknown body fields, missing instruction, and missing plan", () => {
    expect(
      () =>
        parseAiPlanExecutionInput({
          instruction: "Move it.",
          plan: ABSOLUTE_PLAN,
          userId: "x",
        }),
    ).toThrow(AppError);

    expect(
      () => parseAiPlanExecutionInput({ plan: ABSOLUTE_PLAN }),
    ).toThrow(AppError);

    expect(
      () => parseAiPlanExecutionInput({ instruction: "Move it." }),
    ).toThrow(AppError);
  });
});

// ===================================================================
// C. Full-flow runtime tests
// ===================================================================

describe("plan execution — semantic MOVE end-to-end", () => {
  it("resolves semantic references, invokes move_file through the existing approval gate, and never executes the move", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta(
          "/home/Downloads/receipt.pdf",
          "receipt.pdf",
        ),
        "/home/docs": folderMeta("/home/docs", "docs"),
      },
      search: {
        "receipt.pdf": [fileEntry("/home/Downloads/receipt.pdf", "receipt.pdf")],
        docs: [fileEntry("/home/docs", "docs", true)],
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Move receipt.pdf into docs.", plan: SEMANTIC_PLAN },
    );

    // Two discovery reads, then the move-file preflight (source, parent,
    // dest-free), all through the SAME fillable executor — but moveFile
    // itself is never called.
    expect(filesystem.calls).toEqual([
      "searchFiles:receipt.pdf",
      "searchFiles:docs",
      "getFileMetadata:/home/Downloads/receipt.pdf",
      "getFileMetadata:/home/docs",
      "getFileMetadata:/home/docs/receipt.pdf",
    ]);

    // Exactly one pending approval with the RESOLVED paths.
    expect(response.turn.pendingApprovals).toHaveLength(1);
    const pending = response.turn.pendingApprovals[0]!;
    expect(pending.toolName).toBe("move_file");
    expect(pending.arguments).toEqual({
      sourcePath: "/home/Downloads/receipt.pdf",
      destinationPath: "/home/docs/receipt.pdf",
    });

    // Two tool rounds (search + move-create) + one terminal text round.
    expect(response.turn.toolRounds).toBe(2);
    expect(response.turn.finalText).toContain("Approval is required");

    // Planner isolation: the only tool results are the sfm-* ids.
    expect(response.turn.toolResults.map((r) => r.callId)).toEqual([
      PLAN_PAYLOAD_IDS.sourceSearch,
      PLAN_PAYLOAD_IDS.destinationSearch,
      PLAN_PAYLOAD_IDS.move,
    ]);
  });
});

describe("plan execution — absolute path MOVE end-to-end", () => {
  it("issues no discovery, creates approval with verbatim paths, preserves dest folder + source filename", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta(
          "/home/Downloads/receipt.pdf",
          "receipt.pdf",
        ),
        "/home/docs": folderMeta("/home/docs", "docs"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Move receipt.pdf into docs.", plan: ABSOLUTE_PLAN },
    );

    // No search_files calls at all.
    expect(filesystem.calls.filter((c) => c.startsWith("searchFiles:"))).toEqual([]);

    // Only the preflight metadata reads.
    expect(filesystem.calls).toEqual([
      "getFileMetadata:/home/Downloads/receipt.pdf",
      "getFileMetadata:/home/docs",
      "getFileMetadata:/home/docs/receipt.pdf",
    ]);

    // Verbatim source path + folder destination with appended filename.
    const pending = response.turn.pendingApprovals[0]!;
    expect(pending.arguments).toEqual({
      sourcePath: "/home/Downloads/receipt.pdf",
      destinationPath: "/home/docs/receipt.pdf",
    });
  });
});

// ===================================================================
// C. Approval reuse via invokeTool (Phase 10.28 gate reuse)
// ===================================================================

describe("approval reuse — invokeTool with an approved approvalId", () => {
  it("executes the stored exact arguments on the executor, ignoring caller-supplied input", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/a.txt": fileMeta("/home/a.txt", "a.txt"),
        "/home/dest": folderMeta("/home/dest", "dest"),
      },
    });

    // Create a pending move_file approval through the real gate.
    const pending = await invokeTool(
      sessionContext(ALICE),
      "move_file",
      { sourcePath: "/home/a.txt", destinationPath: "/home/dest/b.txt" },
      makeInvokeOptions({ filesystem }),
    );
    expect(isToolApprovalRequiredResult(pending)).toBe(true);
    if (!isToolApprovalRequiredResult(pending)) return;

    const approvalId = pending.approval.approvalId;
    expect(approvalRepo.rows).toHaveLength(1);
    expect(approvalRepo.rows[0]!.toolName).toBe("move_file");

    // Approve.
    await approveAiToolApproval(USER_ID, approvalId, new Date());
    expect(approvalRepo.rows[0]!.status).toBe("approved");

    // Execute with DIFFERENT input — the gate runs only the stored args.
    const executed = await invokeTool(
      sessionContext(ALICE),
      "move_file",
      { sourcePath: "/smuggled/path", destinationPath: "/etc/evil" },
      makeInvokeOptions({ filesystem, approvalId }),
    );

    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.data).toEqual({
      movedFrom: "/home/a.txt",
      movedTo: "/home/dest/b.txt",
    });
    expect(filesystem.calls).toContain("moveFile:/home/a.txt->/home/dest/b.txt");
  });
});

// ===================================================================
// C. §6.9 host-delegated success-after-executor
// ===================================================================

describe("plan execution — §6.9 host-delegated success", () => {
  it("absolute plan → approval → approve → resume{approvalId} → pendingExecutions → resume{resumeExecutions} → success final text", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta(
          "/home/Downloads/receipt.pdf",
          "receipt.pdf",
        ),
        "/home/docs": folderMeta("/home/docs", "docs"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    // 1. First turn: approval CREATE.
    const first = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Move receipt.pdf into docs.", plan: ABSOLUTE_PLAN },
    );
    expect(first.turn.pendingApprovals).toHaveLength(1);
    const approvalId = first.turn.pendingApprovals[0]!.approvalId;
    expect(hostStore.rows).toHaveLength(0);

    // 2. Approve.
    await approveAiToolApproval(USER_ID, approvalId, new Date());
    expect(approvalRepo.rows[0]!.status).toBe("approved");

    // 3. Resume with approvalId → §6.9 defers to a pending host execution.
    const paused = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Continue.", plan: ABSOLUTE_PLAN, approvalId },
    );
    expect(paused.turn.pendingExecutions).toHaveLength(1);
    expect(hostStore.rows).toHaveLength(1);
    expect(hostStore.rows[0]!.status).toBe("pending");
    expect(hostStore.rows[0]!.approvalId).toBe(approvalId);
    expect(paused.turn.finalText).toBeUndefined();

    // 4. Resume with successful host result.
    const executionId = hostStore.rows[0]!.id;
    const final = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      {
        instruction: "Continue.",
        plan: ABSOLUTE_PLAN,
        resumeExecutions: [
          {
            executionId,
            ok: true,
            result: {
              movedFrom: "/home/Downloads/receipt.pdf",
              movedTo: "/home/docs/receipt.pdf",
            },
          },
        ],
      },
    );

    expect(hostStore.rows[0]!.status).toBe("executed");
    expect(hostStore.rows[0]!.executedAt).not.toBeNull();
    expect(final.turn.pendingExecutions).toEqual([]);
    expect(final.turn.pendingApprovals).toEqual([]);
    expect(final.turn.finalText).toBe(
      "Moved the file to /home/docs/receipt.pdf.",
    );
  });
});

// ===================================================================
// C. §6.9 host failure surfaced
// ===================================================================

describe("plan execution — §6.9 host failure surfaced", () => {
  it("resume with ok:false surfaces the failure message as final text", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta(
          "/home/Downloads/receipt.pdf",
          "receipt.pdf",
        ),
        "/home/docs": folderMeta("/home/docs", "docs"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    // Create + approve + defer.
    const first = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Move receipt.pdf into docs.", plan: ABSOLUTE_PLAN },
    );
    const approvalId = first.turn.pendingApprovals[0]!.approvalId;
    await approveAiToolApproval(USER_ID, approvalId, new Date());
    const paused = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Continue.", plan: ABSOLUTE_PLAN, approvalId },
    );
    const executionId = paused.turn.pendingExecutions[0]!.executionId;

    // Resume with a failed host result.
    const final = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      {
        instruction: "Continue.",
        plan: ABSOLUTE_PLAN,
        resumeExecutions: [
          {
            executionId,
            ok: false,
            error: {
              code: "tools/host-execution-required",
              category: "internal",
            },
          },
        ],
      },
    );

    expect(final.turn.pendingExecutions).toEqual([]);
    expect(final.turn.finalText).toBe(
      "The move did not complete: The desktop host could not execute the requested operation.",
    );
  });
});

// ===================================================================
// C. Planner isolation
// ===================================================================

describe("plan execution — planner isolation", () => {
  it("never calls plan_intent; only sfm-* tool results appear", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta(
          "/home/Downloads/receipt.pdf",
          "receipt.pdf",
        ),
        "/home/docs": folderMeta("/home/docs", "docs"),
      },
      search: {
        "receipt.pdf": [fileEntry("/home/Downloads/receipt.pdf", "receipt.pdf")],
        docs: [fileEntry("/home/docs", "docs", true)],
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Move receipt.pdf into docs.", plan: SEMANTIC_PLAN },
    );

    // All toolResults have sfm-* call ids.
    for (const result of response.turn.toolResults) {
      expect(
        result.callId === PLAN_PAYLOAD_IDS.sourceSearch ||
          result.callId === PLAN_PAYLOAD_IDS.destinationSearch ||
          result.callId === PLAN_PAYLOAD_IDS.move,
      ).toBe(true);
    }
    // No plan_intent call was persisted.
    expect(
      conversationMocks.beginAgentTurn.mock.calls.some((call) => {
        const input = call[0] as { toolCalls?: ReadonlyArray<{ toolName: string }> };
        return input?.toolCalls?.some((tc) => tc.toolName === "plan_intent") === true;
      }),
    ).toBe(false);
  });
});

// ===================================================================
// C. Phase 1 → Phase 2 regression (buildFileIntentPlan roundtrip)
// ===================================================================

describe("plan execution — Phase 1 → Phase 2 regression", () => {
  it("a plan produced by the real buildFileIntentPlan runs through the executor without re-planning", async () => {
    // This is the exact input shape buildFileIntentPlan expects (flat fields).
    const plan = buildFileIntentPlan({
      intent: "MOVE",
      sourceName: "receipt.pdf",
      sourceLocation: "/home/Downloads",
      sourceAbsolutePath: "/home/Downloads/receipt.pdf",
      sourceKind: "file",
      destinationName: "docs",
      destinationLocation: "/home",
      destinationAbsolutePath: "/home/docs",
      destinationKind: "folder",
    });

    expect(plan.intent).toBe("MOVE");
    expect(plan.source.reference).toBe("path");
    expect(plan.destination?.reference).toBe("path");

    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta(
          "/home/Downloads/receipt.pdf",
          "receipt.pdf",
        ),
        "/home/docs": folderMeta("/home/docs", "docs"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Move receipt.pdf into docs.", plan },
    );

    // Approval created with the exact paths from the Phase 1 plan.
    expect(response.turn.pendingApprovals).toHaveLength(1);
    expect(response.turn.pendingApprovals[0]!.arguments).toEqual({
      sourcePath: "/home/Downloads/receipt.pdf",
      destinationPath: "/home/docs/receipt.pdf",
    });
    // Only sfm-move (no search — absolute refs).
    expect(response.turn.toolResults.map((r) => r.callId)).toEqual([
      PLAN_PAYLOAD_IDS.move,
    ]);
  });
});

// ===================================================================
// Phase 3 — RENAME execution
// ===================================================================

describe("resolvePlanReferences — RENAME", () => {
  it("derives the destination from the source parent + newName for an absolute source", () => {
    expect(resolvePlanReferences(ABSOLUTE_RENAME_PLAN, [])).toEqual({
      sourcePath: "/home/photos/cross.jpg",
      destinationPath: "/home/photos/cross-final.jpg",
    });
  });

  it("never honors a caller-supplied destination for a rename", () => {
    expect(
      resolvePlanReferences(ABSOLUTE_RENAME_PLAN_WITH_SMUGGLED_DEST, []),
    ).toEqual({
      sourcePath: "/home/photos/cross.jpg",
      destinationPath: "/home/photos/cross-final.jpg",
    });
  });

  it("resolves a semantic source then derives the destination from its parent", () => {
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.sourceSearch,
        toolName: "search_files",
        toolInput: { query: "cross.jpg" },
        data: [fileEntry("/home/photos/cross.jpg", "cross.jpg")],
      },
    ];
    expect(
      resolvePlanReferences(SEMANTIC_RENAME_PLAN, results),
    ).toEqual({
      sourcePath: "/home/photos/cross.jpg",
      destinationPath: "/home/photos/cross-final.jpg",
    });
  });

  it("rejects a missing semantic source as not-found", () => {
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.sourceSearch,
        toolName: "search_files",
        toolInput: { query: "cross.jpg" },
        data: [],
      },
    ];
    expect(() => resolvePlanReferences(SEMANTIC_RENAME_PLAN, results)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.NotFound,
      }),
    );
  });

  it("rejects an ambiguous semantic source", () => {
    const plan: FileIntentPlan = {
      ...SEMANTIC_RENAME_PLAN,
      source: {
        reference: "semantic",
        kind: "file",
        name: "cross.jpg",
        location: "/home",
      },
    };
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.sourceSearch,
        toolName: "search_files",
        toolInput: { query: "cross.jpg" },
        data: [
          fileEntry("/home/photos/cross.jpg", "cross.jpg"),
          fileEntry("/home/backup/cross.jpg", "cross.jpg"),
        ],
      },
    ];
    expect(() => resolvePlanReferences(plan, results)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Ambiguous,
      }),
    );
  });

  it("rejects a folder source as unsupported", () => {
    const plan: FileIntentPlan = {
      ...SEMANTIC_RENAME_PLAN,
      source: { reference: "semantic", kind: "folder", name: "Photos" },
    };
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.sourceSearch,
        toolName: "search_files",
        toolInput: { query: "Photos" },
        data: [fileEntry("/home/photos", "Photos", true)],
      },
    ];
    expect(() => resolvePlanReferences(plan, results)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Unsupported,
      }),
    );
  });

  it("preserves the exact resolved source path (verbatim, not re-derived)", () => {
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.sourceSearch,
        toolName: "search_files",
        toolInput: { query: "cross.jpg" },
        data: [fileEntry("/home/photos/Sub/cross.jpg", "cross.jpg")],
      },
    ];
    expect(resolvePlanReferences(SEMANTIC_RENAME_PLAN, results).sourcePath).toBe(
      "/home/photos/Sub/cross.jpg",
    );
  });
});

describe("resolvePlanReferences — RENAME new-name validation", () => {
  const cases: Array<[unknown, string]> = [
    [undefined, "newName missing"],
    ["", "empty"],
    ["   ", "whitespace only"],
    ["/", "POSIX separator"],
    ["a/b", "nested separator"],
    ["..", "traversal"],
    [".", "self"],
  ];
  for (const [newName, label] of cases) {
    it(`rejects "${label}"`, () => {
      const plan: FileIntentPlan = {
        ...ABSOLUTE_RENAME_PLAN,
        operation: { newName },
      };
      expect(() => resolvePlanReferences(plan, [])).toThrow(
        expect.objectContaining({
          name: "PlanExecutionError",
          code: PlanExecutionErrorCode.Invalid,
        }),
      );
    });
  }
});

describe("plan validation — RENAME (defense-in-depth)", () => {
  it("accepts a valid RENAME plan", () => {
    expect(() => validatePlanForExecution(ABSOLUTE_RENAME_PLAN)).not.toThrow();
  });

  it("rejects a RENAME plan without a new name", () => {
    expect(() =>
      validatePlanForExecution({ ...ABSOLUTE_RENAME_PLAN, operation: {} }),
    ).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Invalid,
      }),
    );
  });

  it("rejects a RENAME with a malformed new name", () => {
    expect(() =>
      validatePlanForExecution({
        ...ABSOLUTE_RENAME_PLAN,
        operation: { newName: "a/b" },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Invalid,
      }),
    );
  });

  it("rejects a RENAME with a folder source", () => {
    expect(() =>
      validatePlanForExecution({
        ...ABSOLUTE_RENAME_PLAN,
        source: { reference: "path", kind: "folder", absolutePath: "/home/photos" },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Unsupported,
      }),
    );
  });

  it("rejects a RENAME whose requiresApproval flag is false", () => {
    expect(() =>
      validatePlanForExecution({ ...ABSOLUTE_RENAME_PLAN, requiresApproval: false }),
    ).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Invalid,
      }),
    );
  });

  it("still rejects non-MOVE/non-RENAME/non-COPY intents", () => {
    for (const intent of ["DELETE", "ORGANIZE", "SEARCH", "TELEPORT"]) {
      expect(() =>
        validatePlanForExecution({ ...ABSOLUTE_RENAME_PLAN, intent }),
      ).toThrow(
        expect.objectContaining({
          name: "PlanExecutionError",
          code: PlanExecutionErrorCode.Unsupported,
        }),
      );
    }
  });
});

describe("deterministic plan-executor provider — RENAME", () => {
  it("emits only the source search, then a move_file with the derived target", async () => {
    const provider = createPlanExecutorProvider(SEMANTIC_RENAME_PLAN);

    // Round 1: needs ONLY the source search — no destination discovery.
    const first = await provider.generate({
      message: "Rename cross.jpg",
      tools: [],
    });
    expect(first.toolCalls?.map((c) => ({ id: c.id, toolName: c.toolName }))).toEqual([
      { id: PLAN_PAYLOAD_IDS.sourceSearch, toolName: "search_files" },
    ]);

    // Round 2: source resolved → move_file with derived destination.
    const sourceResult: AgentToolResult = {
      ok: true,
      callId: PLAN_PAYLOAD_IDS.sourceSearch,
      toolName: "search_files",
      toolInput: { query: "cross.jpg" },
      data: [fileEntry("/home/photos/cross.jpg", "cross.jpg")],
    };
    const move = await provider.generate({
      message: "Rename cross.jpg",
      tools: [],
      toolResults: [sourceResult],
    });
    expect(move.toolCalls?.[0]).toMatchObject({
      id: PLAN_PAYLOAD_IDS.move,
      toolName: "move_file",
      input: {
        sourcePath: "/home/photos/cross.jpg",
        destinationPath: "/home/photos/cross-final.jpg",
      },
    });

    // Round 3: approval-required result → rename-appropriate terminal text.
    const approved: AgentToolResult = {
      ok: false,
      callId: PLAN_PAYLOAD_IDS.move,
      toolName: "move_file",
      toolInput: {
        sourcePath: "/home/photos/cross.jpg",
        destinationPath: "/home/photos/cross-final.jpg",
      },
      error: ToolError.security(ToolErrorCode.ApprovalRequired, "requires approval"),
    };
    const terminal = await provider.generate({
      message: "Rename cross.jpg",
      tools: [],
      toolResults: [sourceResult, approved],
    });
    expect(terminal.text).toBe(
      "Approval is required to rename the file. Review the pending approval to continue.",
    );
  });

  it("issues no discovery for an absolute source and reports rename success", async () => {
    const provider = createPlanExecutorProvider(ABSOLUTE_RENAME_PLAN);

    const move = await provider.generate({ message: "Rename it.", tools: [] });
    expect(move.toolCalls?.[0]?.input).toEqual({
      sourcePath: "/home/photos/cross.jpg",
      destinationPath: "/home/photos/cross-final.jpg",
    });

    const executed: AgentToolResult = {
      ok: true,
      callId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      toolName: "move_file",
      toolInput: {
        sourcePath: "/home/photos/cross.jpg",
        destinationPath: "/home/photos/cross-final.jpg",
      },
      data: {
        movedFrom: "/home/photos/cross.jpg",
        movedTo: "/home/photos/cross-final.jpg",
      },
    };
    const terminal = await provider.generate({
      message: "Continue.",
      tools: [],
      toolResults: [executed],
    });
    expect(terminal.text).toBe("Renamed the file to /home/photos/cross-final.jpg.");
  });
});

describe("plan execution — semantic RENAME end-to-end", () => {
  it("searches once, derives the target, and creates the move_file approval", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/photos/cross.jpg": fileMeta("/home/photos/cross.jpg", "cross.jpg"),
        "/home/photos": folderMeta("/home/photos", "photos"),
      },
      search: {
        "cross.jpg": [fileEntry("/home/photos/cross.jpg", "cross.jpg")],
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Rename cross.jpg to cross-final.jpg.", plan: SEMANTIC_RENAME_PLAN },
    );

    // ONE discovery read, then the move_file preflight (source, parent, target)
    // — merged into the SAME executor. No destination discovery.
    expect(filesystem.calls).toEqual([
      "searchFiles:cross.jpg",
      "getFileMetadata:/home/photos/cross.jpg",
      "getFileMetadata:/home/photos",
      "getFileMetadata:/home/photos/cross-final.jpg",
    ]);

    // Exactly one pending move_file approval with the DERIVED target path.
    expect(response.turn.pendingApprovals).toHaveLength(1);
    const pending = response.turn.pendingApprovals[0]!;
    expect(pending.toolName).toBe("move_file");
    expect(pending.arguments).toEqual({
      sourcePath: "/home/photos/cross.jpg",
      destinationPath: "/home/photos/cross-final.jpg",
    });

    expect(response.turn.toolRounds).toBe(2);
    expect(response.turn.finalText).toBe(
      "Approval is required to rename the file. Review the pending approval to continue.",
    );

    // Planner isolation: only the sfm-* call ids appear.
    expect(response.turn.toolResults.map((r) => r.callId)).toEqual([
      PLAN_PAYLOAD_IDS.sourceSearch,
      PLAN_PAYLOAD_IDS.move,
    ]);
  });
});

describe("plan execution — absolute RENAME end-to-end", () => {
  it("issues no discovery and creates the approval with the derived target", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/photos/cross.jpg": fileMeta("/home/photos/cross.jpg", "cross.jpg"),
        "/home/photos": folderMeta("/home/photos", "photos"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Rename cross.jpg to cross-final.jpg.", plan: ABSOLUTE_RENAME_PLAN },
    );

    expect(filesystem.calls.filter((c) => c.startsWith("searchFiles:"))).toEqual([]);
    expect(filesystem.calls).toEqual([
      "getFileMetadata:/home/photos/cross.jpg",
      "getFileMetadata:/home/photos",
      "getFileMetadata:/home/photos/cross-final.jpg",
    ]);

    const pending = response.turn.pendingApprovals[0]!;
    expect(pending.arguments).toEqual({
      sourcePath: "/home/photos/cross.jpg",
      destinationPath: "/home/photos/cross-final.jpg",
    });
  });
});

describe("plan execution — approval reuse + real execution through the existing layer (RENAME)", () => {
  it("executes the stored exact rename arguments on the executor, ignoring caller input", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/photos/cross.jpg": fileMeta("/home/photos/cross.jpg", "cross.jpg"),
        "/home/photos": folderMeta("/home/photos", "photos"),
      },
    });

    // Create a pending move_file approval with RENAME args through the real gate.
    const pending = await invokeTool(
      sessionContext(ALICE),
      "move_file",
      { sourcePath: "/home/photos/cross.jpg", destinationPath: "/home/photos/cross-final.jpg" },
      makeInvokeOptions({ filesystem }),
    );
    expect(isToolApprovalRequiredResult(pending)).toBe(true);
    if (!isToolApprovalRequiredResult(pending)) return;

    const approvalId = pending.approval.approvalId;
    await approveAiToolApproval(USER_ID, approvalId, new Date());

    // Execute with DIFFERENT input — the gate runs only the stored args.
    const executed = await invokeTool(
      sessionContext(ALICE),
      "move_file",
      { sourcePath: "/smuggled/path", destinationPath: "/etc/evil" },
      makeInvokeOptions({ filesystem, approvalId }),
    );

    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.data).toEqual({
      movedFrom: "/home/photos/cross.jpg",
      movedTo: "/home/photos/cross-final.jpg",
    });
    expect(filesystem.calls).toContain(
      "moveFile:/home/photos/cross.jpg->/home/photos/cross-final.jpg",
    );
  });
});

describe("plan execution — §6.9 host-delegated RENAME", () => {
  it("success-after-executor: approval → defer → host resume → rename final text", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/photos/cross.jpg": fileMeta("/home/photos/cross.jpg", "cross.jpg"),
        "/home/photos": folderMeta("/home/photos", "photos"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const first = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Rename cross.jpg.", plan: ABSOLUTE_RENAME_PLAN },
    );
    const approvalId = first.turn.pendingApprovals[0]!.approvalId;
    await approveAiToolApproval(USER_ID, approvalId, new Date());

    const paused = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Continue.", plan: ABSOLUTE_RENAME_PLAN, approvalId },
    );
    expect(paused.turn.pendingExecutions).toHaveLength(1);
    expect(hostStore.rows[0]!.arguments).toEqual({
      sourcePath: "/home/photos/cross.jpg",
      destinationPath: "/home/photos/cross-final.jpg",
    });

    const executionId = paused.turn.pendingExecutions[0]!.executionId;
    const final = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      {
        instruction: "Continue.",
        plan: ABSOLUTE_RENAME_PLAN,
        resumeExecutions: [
          {
            executionId,
            ok: true,
            result: {
              movedFrom: "/home/photos/cross.jpg",
              movedTo: "/home/photos/cross-final.jpg",
            },
          },
        ],
      },
    );

    expect(hostStore.rows[0]!.status).toBe("executed");
    expect(final.turn.pendingExecutions).toEqual([]);
    expect(final.turn.finalText).toBe("Renamed the file to /home/photos/cross-final.jpg.");
  });

  it("host failure fidelity: resume with ok:false surfaces rename failure text", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/photos/cross.jpg": fileMeta("/home/photos/cross.jpg", "cross.jpg"),
        "/home/photos": folderMeta("/home/photos", "photos"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const first = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Rename cross.jpg.", plan: ABSOLUTE_RENAME_PLAN },
    );
    const approvalId = first.turn.pendingApprovals[0]!.approvalId;
    await approveAiToolApproval(USER_ID, approvalId, new Date());
    const paused = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Continue.", plan: ABSOLUTE_RENAME_PLAN, approvalId },
    );
    const executionId = paused.turn.pendingExecutions[0]!.executionId;

    const final = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      {
        instruction: "Continue.",
        plan: ABSOLUTE_RENAME_PLAN,
        resumeExecutions: [
          {
            executionId,
            ok: false,
            error: { code: "tools/host-execution-required", category: "internal" },
          },
        ],
      },
    );

    expect(final.turn.pendingExecutions).toEqual([]);
    expect(final.turn.finalText).toBe(
      "The rename did not complete: The desktop host could not execute the requested operation.",
    );
  });
});

describe("plan execution — case-only RENAME behavior", () => {
  it("derives the target preserving the requested case, differing from the source", () => {
    const plan: FileIntentPlan = {
      ...ABSOLUTE_RENAME_PLAN,
      operation: { newName: "Cross.jpg" },
    };
    expect(resolvePlanReferences(plan, [])).toEqual({
      sourcePath: "/home/photos/cross.jpg",
      destinationPath: "/home/photos/Cross.jpg",
    });
  });

  it("surfaces the existing layer's already-exists guard on a case-colliding path", async () => {
    // A case-insensitive host reports the case-differing name as existing;
    // the existing move_file preflight refuses the overwrite (no clobber).
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/photos/cross.jpg": fileMeta("/home/photos/cross.jpg", "cross.jpg"),
        "/home/photos/Cross.jpg": fileMeta("/home/photos/Cross.jpg", "Cross.jpg"),
        "/home/photos": folderMeta("/home/photos", "photos"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      {
        instruction: "Rename cross.jpg to Cross.jpg.",
        plan: { ...ABSOLUTE_RENAME_PLAN, operation: { newName: "Cross.jpg" } },
      },
    );

    expect(response.turn.pendingApprovals).toEqual([]);
    expect(response.turn.finalText).toBe(
      "The rename did not complete: A file or folder with that name already exists.",
    );
  });
});

describe("plan execution — Phase 3 regression (buildFileIntentPlan RENAME roundtrip)", () => {
  it("a planner-produced RENAME plan runs through the executor without re-planning", async () => {
    const plan = buildFileIntentPlan({
      intent: "RENAME",
      sourceKind: "file",
      sourceName: "cross.jpg",
      sourceLocation: "/home/photos",
      sourceAbsolutePath: "/home/photos/cross.jpg",
      newName: "cross-final.jpg",
    });

    expect(plan.intent).toBe("RENAME");
    expect(plan.source.reference).toBe("path");
    expect(plan.operation).toEqual({ newName: "cross-final.jpg" });

    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/photos/cross.jpg": fileMeta("/home/photos/cross.jpg", "cross.jpg"),
        "/home/photos": folderMeta("/home/photos", "photos"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Rename cross.jpg to cross-final.jpg.", plan },
    );

    expect(response.turn.pendingApprovals).toHaveLength(1);
    expect(response.turn.pendingApprovals[0]!.arguments).toEqual({
      sourcePath: "/home/photos/cross.jpg",
      destinationPath: "/home/photos/cross-final.jpg",
    });
    expect(response.turn.toolResults.map((r) => r.callId)).toEqual([
      PLAN_PAYLOAD_IDS.move,
    ]);
  });
});

// ===================================================================
// Phase 4 — COPY execution
// ===================================================================

describe("deterministic plan-executor provider — COPY", () => {
  it("semantic COPY: emits BOTH searches, then a copy_file with a DIRECTORY-shaped destDirPath", async () => {
    const provider = createPlanExecutorProvider(SEMANTIC_COPY_PLAN);

    // Round 1: no results → source AND destination searches.
    const first = await provider.generate({ message: "Copy receipt.pdf", tools: [] });
    expect(first.toolCalls?.map((c) => ({ id: c.id, toolName: c.toolName }))).toEqual([
      { id: PLAN_PAYLOAD_IDS.sourceSearch, toolName: "search_files" },
      { id: PLAN_PAYLOAD_IDS.destinationSearch, toolName: "search_files" },
    ]);

    // Round 2: searches present → resolved copy into the DESTINATION DIRECTORY
    // — the source file name is NOT appended (unlike MOVE).
    const request: AgentProviderRequest = {
      message: "Copy receipt.pdf",
      tools: [],
      toolResults: [
        {
          ok: true,
          callId: PLAN_PAYLOAD_IDS.sourceSearch,
          toolName: "search_files",
          toolInput: { query: "receipt.pdf" },
          data: [fileEntry("/home/Downloads/receipt.pdf", "receipt.pdf")],
        },
        {
          ok: true,
          callId: PLAN_PAYLOAD_IDS.destinationSearch,
          toolName: "search_files",
          toolInput: { query: "docs" },
          data: [fileEntry("/home/docs", "docs", true)],
        },
      ],
    };
    const a = await provider.generate(request);
    const b = await provider.generate(request);
    expect(b).toEqual(a); // stateless
    expect(a.toolCalls?.[0]).toMatchObject({
      id: PLAN_PAYLOAD_IDS.copy,
      toolName: "copy_file",
      input: {
        sourcePath: "/home/Downloads/receipt.pdf",
        destDirPath: "/home/docs",
      },
    });

    // Round 3: approval-required result → copy-appropriate terminal text.
    const approved: AgentToolResult = {
      ok: false,
      callId: PLAN_PAYLOAD_IDS.copy,
      toolName: "copy_file",
      toolInput: { sourcePath: "/home/Downloads/receipt.pdf", destDirPath: "/home/docs" },
      error: ToolError.security(ToolErrorCode.ApprovalRequired, "requires approval"),
    };
    const terminal = await provider.generate({
      message: "Copy receipt.pdf",
      tools: [],
      toolResults: [...(request.toolResults ?? []), approved],
    });
    expect(terminal.text).toBe(
      "Approval is required to copy the file. Review the pending approval to continue.",
    );
  });

  it("absolute COPY: issues no discovery and issues copy_file with the verbatim directory", async () => {
    const provider = createPlanExecutorProvider(ABSOLUTE_COPY_PLAN);

    const copy = await provider.generate({ message: "Copy it.", tools: [] });
    expect(copy.toolCalls?.[0]).toMatchObject({
      id: PLAN_PAYLOAD_IDS.copy,
      toolName: "copy_file",
      input: {
        sourcePath: "/home/Downloads/receipt.pdf",
        destDirPath: "/home/docs",
      },
    });
    expect(copy.toolCalls?.length).toBe(1);
  });

  it("accepts a copy result seeded with a non-sfm callId (approval resume path)", async () => {
    const provider = createPlanExecutorProvider(ABSOLUTE_COPY_PLAN);
    const executionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const copyResult: AgentToolResult = {
      ok: true,
      callId: executionId,
      toolName: "copy_file",
      toolInput: { sourcePath: "/home/Downloads/receipt.pdf", destDirPath: "/home/docs" },
      data: {
        copiedFrom: "/home/Downloads/receipt.pdf",
        copiedTo: "/home/docs/receipt.pdf",
      },
    };
    const terminal = await provider.generate({
      message: "Continue after host execution.",
      tools: [],
      toolResults: [copyResult],
    });
    expect(terminal.text).toBe("Copied the file to /home/docs/receipt.pdf.");
  });
});

describe("resolvePlanReferences — COPY", () => {
  it("resolves an absolute destination as the DIRECTORY verbatim — no filename appended", () => {
    expect(resolvePlanReferences(ABSOLUTE_COPY_PLAN, [])).toEqual({
      sourcePath: "/home/Downloads/receipt.pdf",
      destinationPath: "/home/docs",
    });
  });

  it("resolves a semantic destination to the folder path without appending the source name", () => {
    const plan: FileIntentPlan = {
      ...SEMANTIC_COPY_PLAN,
      source: { reference: "path", kind: "file", absolutePath: "/home/Downloads/receipt.pdf" },
    };
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.destinationSearch,
        toolName: "search_files",
        toolInput: { query: "docs" },
        data: [
          fileEntry("/home/docs", "docs", true),
          fileEntry("/tmp/docs-offsite", "docs-offsite", true),
        ],
      },
    ];
    expect(resolvePlanReferences(plan, results)).toEqual({
      sourcePath: "/home/Downloads/receipt.pdf",
      destinationPath: "/home/docs",
    });
  });

  it("rejects an ambiguous semantic COPY destination (multiple folders)", () => {
    const plan: FileIntentPlan = {
      ...SEMANTIC_COPY_PLAN,
      source: { reference: "path", kind: "file", absolutePath: "/home/Downloads/receipt.pdf" },
      destination: { reference: "semantic", kind: "folder", name: "docs" },
    };
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.destinationSearch,
        toolName: "search_files",
        toolInput: { query: "docs" },
        data: [
          fileEntry("/home/docs", "docs", true),
          fileEntry("/tmp/docs", "docs", true),
        ],
      },
    ];
    expect(() => resolvePlanReferences(plan, results)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Ambiguous,
      }),
    );
  });

  it("rejects a missing semantic COPY destination (empty search) as not-found", () => {
    const plan: FileIntentPlan = {
      ...SEMANTIC_COPY_PLAN,
      source: { reference: "path", kind: "file", absolutePath: "/home/Downloads/receipt.pdf" },
    };
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.destinationSearch,
        toolName: "search_files",
        toolInput: { query: "docs" },
        data: [],
      },
    ];
    expect(() => resolvePlanReferences(plan, results)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.NotFound,
      }),
    );
  });

  it("rejects a semantic COPY destination that resolves only to files", () => {
    const plan: FileIntentPlan = {
      ...SEMANTIC_COPY_PLAN,
      source: { reference: "path", kind: "file", absolutePath: "/home/Downloads/receipt.pdf" },
    };
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.destinationSearch,
        toolName: "search_files",
        toolInput: { query: "docs" },
        data: [fileEntry("/home/Downloads/docs", "docs", false)],
      },
    ];
    expect(() => resolvePlanReferences(plan, results)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.NotFound,
      }),
    );
  });

  it("rejects a COPY destination when the destination search result is missing", () => {
    const plan: FileIntentPlan = {
      ...SEMANTIC_COPY_PLAN,
      source: { reference: "path", kind: "file", absolutePath: "/home/Downloads/receipt.pdf" },
    };
    expect(() => resolvePlanReferences(plan, [])).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Invalid,
      }),
    );
  });

  it("rejects a folder source as unsupported", () => {
    const plan: FileIntentPlan = {
      ...ABSOLUTE_COPY_PLAN,
      source: { reference: "semantic", kind: "folder", name: "MyFolder" },
    };
    const results: AgentToolResult[] = [
      {
        ok: true,
        callId: PLAN_PAYLOAD_IDS.sourceSearch,
        toolName: "search_files",
        toolInput: { query: "MyFolder" },
        data: [fileEntry("/home/Downloads/MyFolder", "MyFolder", true)],
      },
    ];
    expect(() => resolvePlanReferences(plan, results)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Unsupported,
      }),
    );
  });
});

describe("plan validation — COPY (defense-in-depth)", () => {
  it("accepts a valid COPY plan", () => {
    expect(() => validatePlanForExecution(ABSOLUTE_COPY_PLAN)).not.toThrow();
  });

  it("rejects a COPY plan without a destination reference", () => {
    const noDest = { ...ABSOLUTE_COPY_PLAN, destination: undefined } as unknown as FileIntentPlan;
    expect(() => validatePlanForExecution(noDest)).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Invalid,
      }),
    );
  });

  it("rejects a COPY with a folder source", () => {
    expect(() =>
      validatePlanForExecution({
        ...ABSOLUTE_COPY_PLAN,
        source: { reference: "path", kind: "folder", absolutePath: "/home/Downloads/folder" },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Unsupported,
      }),
    );
  });

  it("rejects a COPY whose requiresApproval flag is false", () => {
    expect(() =>
      validatePlanForExecution({ ...ABSOLUTE_COPY_PLAN, requiresApproval: false }),
    ).toThrow(
      expect.objectContaining({
        name: "PlanExecutionError",
        code: PlanExecutionErrorCode.Invalid,
      }),
    );
  });

  it("rejects unsupported intents for execution", () => {
    for (const intent of ["DELETE", "ORGANIZE", "SEARCH", "TELEPORT"]) {
      expect(() =>
        validatePlanForExecution({ ...ABSOLUTE_COPY_PLAN, intent }),
      ).toThrow(
        expect.objectContaining({
          name: "PlanExecutionError",
          code: PlanExecutionErrorCode.Unsupported,
        }),
      );
    }
  });
});

describe("plan execution — semantic COPY end-to-end", () => {
  it("resolves semantic refs, creates the copy_file approval with a destDirPath, and never copies in-process", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta("/home/Downloads/receipt.pdf", "receipt.pdf"),
        "/home/docs": folderMeta("/home/docs", "docs"),
      },
      search: {
        "receipt.pdf": [fileEntry("/home/Downloads/receipt.pdf", "receipt.pdf")],
        docs: [fileEntry("/home/docs", "docs", true)],
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Copy receipt.pdf into docs.", plan: SEMANTIC_COPY_PLAN },
    );

    // Two discovery reads, then the copy_file preflight (source, destDir,
    // derived-destination-free), all through the SAME fillable executor — but
    // copyFile itself is never called (approval is required first).
    expect(filesystem.calls).toEqual([
      "searchFiles:receipt.pdf",
      "searchFiles:docs",
      "getFileMetadata:/home/Downloads/receipt.pdf",
      "getFileMetadata:/home/docs",
      "getFileMetadata:/home/docs/receipt.pdf",
    ]);

    // One pending approval with the DIRECTORY-shaped resolved args.
    expect(response.turn.pendingApprovals).toHaveLength(1);
    const pending = response.turn.pendingApprovals[0]!;
    expect(pending.toolName).toBe("copy_file");
    expect(pending.arguments).toEqual({
      sourcePath: "/home/Downloads/receipt.pdf",
      destDirPath: "/home/docs",
    });

    expect(response.turn.toolRounds).toBe(2);
    expect(response.turn.finalText).toBe(
      "Approval is required to copy the file. Review the pending approval to continue.",
    );

    // Planner isolation: only the sfm-* ids and the copy payload id.
    expect(response.turn.toolResults.map((r) => r.callId)).toEqual([
      PLAN_PAYLOAD_IDS.sourceSearch,
      PLAN_PAYLOAD_IDS.destinationSearch,
      PLAN_PAYLOAD_IDS.copy,
    ]);
    expect(
      conversationMocks.beginAgentTurn.mock.calls.some((call) => {
        const input = call[0] as { toolCalls?: ReadonlyArray<{ toolName: string }> };
        return input?.toolCalls?.some((tc) => tc.toolName === "plan_intent") === true;
      }),
    ).toBe(false);
  });
});

describe("plan execution — absolute COPY end-to-end", () => {
  it("issues no discovery and creates the approval with the verbatim destination directory", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta("/home/Downloads/receipt.pdf", "receipt.pdf"),
        "/home/docs": folderMeta("/home/docs", "docs"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Copy receipt.pdf into docs.", plan: ABSOLUTE_COPY_PLAN },
    );

    expect(filesystem.calls.filter((c) => c.startsWith("searchFiles:"))).toEqual([]);
    expect(filesystem.calls).toEqual([
      "getFileMetadata:/home/Downloads/receipt.pdf",
      "getFileMetadata:/home/docs",
      "getFileMetadata:/home/docs/receipt.pdf",
    ]);

    const pending = response.turn.pendingApprovals[0]!;
    expect(pending.toolName).toBe("copy_file");
    expect(pending.arguments).toEqual({
      sourcePath: "/home/Downloads/receipt.pdf",
      destDirPath: "/home/docs",
    });
    expect(response.turn.toolResults.map((r) => r.callId)).toEqual([
      PLAN_PAYLOAD_IDS.copy,
    ]);
  });

  it("surfaces a missing destination folder as a copy failure (not_found)", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta("/home/Downloads/receipt.pdf", "receipt.pdf"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Copy receipt.pdf into docs.", plan: ABSOLUTE_COPY_PLAN },
    );

    expect(response.turn.pendingApprovals).toEqual([]);
    expect(response.turn.finalText).toBe(
      "The copy did not complete: The destination folder does not exist.",
    );
  });

  it("rejects an existing same-named destination as already-exists without creating an approval", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta("/home/Downloads/receipt.pdf", "receipt.pdf"),
        "/home/docs": folderMeta("/home/docs", "docs"),
        "/home/docs/receipt.pdf": fileMeta("/home/docs/receipt.pdf", "receipt.pdf"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Copy receipt.pdf into docs.", plan: ABSOLUTE_COPY_PLAN },
    );

    expect(response.turn.pendingApprovals).toEqual([]);
    expect(response.turn.finalText).toBe(
      "The copy did not complete: A file or folder with that name already exists.",
    );
  });

  it("surfaces an AllowList/security preflight failure faithfully", async () => {
    const filesystem: FilesystemExecutor = {
      async listDirectory(path: string): Promise<DirectoryListing> {
        return { path, parentPath: null, isHome: false, items: [] };
      },
      async searchFiles() {
        return [];
      },
      async getFileMetadata() {
        throw new Error("Access to this location is not permitted.");
      },
      async readFile() {
        return { encoding: "base64", data: "" };
      },
      async moveFile() {
        return undefined;
      },
      async copyFile() {
        return undefined;
      },
    };
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Copy receipt.pdf into docs.", plan: ABSOLUTE_COPY_PLAN },
    );

    expect(response.turn.pendingApprovals).toEqual([]);
    expect(response.turn.finalText).toBe(
      "The copy did not complete: Access to this location is not permitted.",
    );
    // The write never reached the executor — the failing round was the
    // sfm-copy preflight of the write tool itself.
    expect(response.turn.toolResults.at(-1)?.callId).toBe(PLAN_PAYLOAD_IDS.copy);
    expect(response.turn.toolResults.at(-1)?.ok).toBe(false);
  });
});

describe("plan execution — approval reuse + real copy execution through the existing layer (COPY)", () => {
  it("executes the stored exact copy args on the executor, ignoring caller input", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta("/home/Downloads/receipt.pdf", "receipt.pdf"),
        "/home/docs": folderMeta("/home/docs", "docs"),
      },
    });

    const pending = await invokeTool(
      sessionContext(ALICE),
      "copy_file",
      { sourcePath: "/home/Downloads/receipt.pdf", destDirPath: "/home/docs" },
      makeInvokeOptions({ filesystem }),
    );
    expect(isToolApprovalRequiredResult(pending)).toBe(true);
    if (!isToolApprovalRequiredResult(pending)) return;

    const approvalId = pending.approval.approvalId;
    expect(approvalRepo.rows).toHaveLength(1);
    expect(approvalRepo.rows[0]!.toolName).toBe("copy_file");
    await approveAiToolApproval(USER_ID, approvalId, new Date());

    // Execute with DIFFERENT input — the gate runs only the stored args.
    const executed = await invokeTool(
      sessionContext(ALICE),
      "copy_file",
      { sourcePath: "/smuggled/path", destDirPath: "/etc/evil" },
      makeInvokeOptions({ filesystem, approvalId }),
    );

    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.data).toEqual({
      copiedFrom: "/home/Downloads/receipt.pdf",
      copiedTo: "/home/docs/receipt.pdf",
    });
    expect(filesystem.calls).toContain(
      "copyFile:/home/Downloads/receipt.pdf->/home/docs",
    );
  });
});

describe("plan execution — §6.9 host-delegated COPY", () => {
  it("success-after-executor: approval → defer → host resume → copy final text", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta("/home/Downloads/receipt.pdf", "receipt.pdf"),
        "/home/docs": folderMeta("/home/docs", "docs"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const first = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Copy receipt.pdf into docs.", plan: ABSOLUTE_COPY_PLAN },
    );
    const approvalId = first.turn.pendingApprovals[0]!.approvalId;
    await approveAiToolApproval(USER_ID, approvalId, new Date());

    const paused = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Continue.", plan: ABSOLUTE_COPY_PLAN, approvalId },
    );
    expect(paused.turn.pendingExecutions).toHaveLength(1);
    expect(hostStore.rows).toHaveLength(1);
    expect(hostStore.rows[0]!.toolName).toBe("copy_file");
    expect(hostStore.rows[0]!.arguments).toEqual({
      sourcePath: "/home/Downloads/receipt.pdf",
      destDirPath: "/home/docs",
    });

    const executionId = paused.turn.pendingExecutions[0]!.executionId;
    const final = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      {
        instruction: "Continue.",
        plan: ABSOLUTE_COPY_PLAN,
        resumeExecutions: [
          {
            executionId,
            ok: true,
            result: {
              copiedFrom: "/home/Downloads/receipt.pdf",
              copiedTo: "/home/docs/receipt.pdf",
            },
          },
        ],
      },
    );

    expect(hostStore.rows[0]!.status).toBe("executed");
    expect(final.turn.pendingExecutions).toEqual([]);
    expect(final.turn.pendingApprovals).toEqual([]);
    expect(final.turn.finalText).toBe("Copied the file to /home/docs/receipt.pdf.");
  });

  it("host failure fidelity: resume with ok:false surfaces the copy failure text", async () => {
    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta("/home/Downloads/receipt.pdf", "receipt.pdf"),
        "/home/docs": folderMeta("/home/docs", "docs"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const first = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Copy receipt.pdf into docs.", plan: ABSOLUTE_COPY_PLAN },
    );
    const approvalId = first.turn.pendingApprovals[0]!.approvalId;
    await approveAiToolApproval(USER_ID, approvalId, new Date());
    const paused = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Continue.", plan: ABSOLUTE_COPY_PLAN, approvalId },
    );
    const executionId = paused.turn.pendingExecutions[0]!.executionId;

    const final = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      {
        instruction: "Continue.",
        plan: ABSOLUTE_COPY_PLAN,
        resumeExecutions: [
          {
            executionId,
            ok: false,
            error: { code: "tools/host-execution-required", category: "internal" },
          },
        ],
      },
    );

    expect(final.turn.pendingExecutions).toEqual([]);
    expect(final.turn.finalText).toBe(
      "The copy did not complete: The desktop host could not execute the requested operation.",
    );
  });
});

describe("plan execution — Phase 1 → Phase 4 regression (buildFileIntentPlan COPY roundtrip)", () => {
  it("a planner-produced COPY plan runs through the executor without re-planning", async () => {
    const plan = buildFileIntentPlan({
      intent: "COPY",
      sourceKind: "file",
      sourceName: "receipt.pdf",
      sourceLocation: "/home/Downloads",
      sourceAbsolutePath: "/home/Downloads/receipt.pdf",
      destinationKind: "folder",
      destinationName: "docs",
      destinationLocation: "/home",
      destinationAbsolutePath: "/home/docs",
    });

    expect(plan.intent).toBe("COPY");
    expect(plan.source.reference).toBe("path");
    expect(plan.destination?.reference).toBe("path");

    const filesystem = makeFillableFilesystem({
      metadata: {
        "/home/Downloads/receipt.pdf": fileMeta("/home/Downloads/receipt.pdf", "receipt.pdf"),
        "/home/docs": folderMeta("/home/docs", "docs"),
      },
    });
    const runtime = makePlanRuntime({ filesystem });

    const response = await runAiPlanExecutionWithRuntime(
      runtime,
      sessionContext(ALICE),
      { instruction: "Copy receipt.pdf into docs.", plan },
    );

    expect(response.turn.pendingApprovals).toHaveLength(1);
    expect(response.turn.pendingApprovals[0]!.arguments).toEqual({
      sourcePath: "/home/Downloads/receipt.pdf",
      destDirPath: "/home/docs",
    });
    expect(response.turn.toolResults.map((r) => r.callId)).toEqual([
      PLAN_PAYLOAD_IDS.copy,
    ]);
  });
});
