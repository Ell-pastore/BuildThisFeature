/**
 * Host-execution contract — approval binding for APPROVED WRITES (§6.9).
 *
 * `createAiHostExecution` runs with the REAL registry + validation (no
 * database). The two seams are mocked: the approval contract
 * (`./aiToolApprovals.js`) — `getToolApproval`/`assertToolApprovalExecutable`
 * are scripted, while the REAL argument validator + error classes stay real —
 * and the repository (`../database/repositories/aiHostExecutions.js`), whose
 * `createHostExecution` is captured to prove exactly what (if anything) would
 * be persisted.
 *
 * Coverage:
 *
 *   1. GATE PAIRING — an APPROVED-WRITE (move_file) REQUIRES an `approvalId`;
 *      an ungated read with an `approvalId` is rejected ("not-allowed"); an
 *      approval-gated read outside the container stays "not-delegable".
 *   2. APPROVAL BINDING — a missing/foreign approval, an expired or otherwise
 *      non-executable approval, a different tool, and different arguments are
 *      all rejected with the discriminating `HostExecutionApprovalError` kind.
 *   3. HAPPY PATH — a matching, executable approval binds the execution 1:1
 *      and the repository receives the approval's exact tool + arguments.
 *   4. REGRESSION — the ungated read path still creates WITHOUT an approvalId.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../tools/registry.js";
import { ToolPermission } from "../tools/types.js";
import {
  createAiHostExecution,
  HostExecutionApprovalError,
  HostExecutionNotDelegableError,
} from "./aiHostExecutions.js";
import {
  ToolApprovalExpiredError,
  ToolApprovalNotExecutableError,
  type ToolApprovalRecord,
} from "./aiToolApprovals.js";
import {
  HostExecutionStatus,
  type HostExecutionRecord,
} from "../database/repositories/aiHostExecutions.js";

// ---------------------------------------------------------------------------
// Approval-contract seam: getToolApproval + the executable guard are scripted;
// the argument validator and error classes stay REAL.
// ---------------------------------------------------------------------------

const approvalMocks = vi.hoisted(() => ({
  getToolApproval: vi.fn(),
  assertToolApprovalExecutable: vi.fn(),
}));

vi.mock("./aiToolApprovals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./aiToolApprovals.js")>();
  return {
    ...actual,
    getToolApproval: approvalMocks.getToolApproval,
    assertToolApprovalExecutable: approvalMocks.assertToolApprovalExecutable,
  };
});

// ---------------------------------------------------------------------------
// Host-execution repository seam: real error classes, captured create.
// ---------------------------------------------------------------------------

const repoMocks = vi.hoisted(() => ({
  createHostExecution: vi.fn(),
}));

const FIXTURE_EXECUTION_ID = "bbbbbbbb-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

vi.mock("../database/repositories/aiHostExecutions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../database/repositories/aiHostExecutions.js")>();
  return {
    ...actual,
    createHostExecution: repoMocks.createHostExecution,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "55555555-5555-5555-5555-555555555555";
const MESSAGE_ID = "66666666-6666-6666-6666-666666666666";
const APPROVAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const NOW = new Date("2026-09-11T00:00:00.000Z");

function moveFileRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "move_file",
    description: "Approved host write (test fixture).",
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: { type: "string" },
        destinationPath: { type: "string" },
      },
      required: ["sourcePath", "destinationPath"],
    },
    permission: ToolPermission.Write,
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
  registry.register({
    name: "list_directory",
    description: "Approval-gated read (NOT in the approved-write container).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    permission: ToolPermission.Read,
    requiresApproval: true,
  });
  return registry;
}

function approvedApproval(overrides: Partial<ToolApprovalRecord> = {}): ToolApprovalRecord {
  return {
    id: APPROVAL_ID,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    toolName: "move_file",
    arguments: { sourcePath: "/home/receipt.pdf", destinationPath: "/home/docs/receipt.pdf" },
    status: "approved",
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: FUTURE,
    decidedAt: now(),
    ...overrides,
  };
}

function now(): Date {
  return new Date("2026-09-11T01:00:00.000Z");
}

function pendingRecord(overrides: Partial<HostExecutionRecord> = {}): HostExecutionRecord {
  return {
    id: FIXTURE_EXECUTION_ID,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    toolName: "move_file",
    callId: "c1",
    arguments: { sourcePath: "/home/receipt.pdf", destinationPath: "/home/docs/receipt.pdf" },
    round: 1,
    status: HostExecutionStatus.Pending,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: FUTURE,
    executedAt: null,
    approvalId: APPROVAL_ID,
    ...overrides,
  };
}

function request(overrides: object = {}) {
  return {
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    toolName: "move_file",
    callId: "c1",
    round: 1,
    arguments: { sourcePath: "/home/receipt.pdf", destinationPath: "/home/docs/receipt.pdf" },
    approvalId: APPROVAL_ID,
    expiresAt: FUTURE,
    now: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  approvalMocks.getToolApproval.mockReset().mockResolvedValue(approvedApproval());
  approvalMocks.assertToolApprovalExecutable.mockReset().mockImplementation(() => {});
  repoMocks.createHostExecution.mockReset().mockImplementation(
    (input: { id: string; toolName: string; arguments: unknown; approvalId: string | null }) =>
      Promise.resolve(
        pendingRecord({ toolName: input.toolName, arguments: input.arguments, approvalId: input.approvalId }),
      ),
  );
});

// ---------------------------------------------------------------------------
// 1. Gate pairing (§6.9)
// ---------------------------------------------------------------------------

describe("createAiHostExecution — approval gate pairing (§6.9)", () => {
  it("REQUIRES an approvalId for an approved host write (move_file)", async () => {
    const register = moveFileRegistry();
    const withoutApproval = {
      ...request(),
      approvalId: undefined,
    };

    await expect(
      createAiHostExecution(withoutApproval, { registry: register }),
    ).rejects.toMatchObject({
      name: "HostExecutionApprovalError",
      kind: "required",
    });
    expect(repoMocks.createHostExecution).not.toHaveBeenCalled();
  });

  it("rejects an approvalId on a tool OUTSIDE the approved-write container", async () => {
    const register = moveFileRegistry();

    await expect(
      createAiHostExecution(
        request({
          toolName: "search_files",
          arguments: { query: "receipt" },
          approvalId: APPROVAL_ID,
        }),
        { registry: register },
      ),
    ).rejects.toMatchObject({
      name: "HostExecutionApprovalError",
      kind: "not-allowed",
    });
    expect(repoMocks.createHostExecution).not.toHaveBeenCalled();
  });

  it("keeps approval-gated reads outside the container NOT host-delegable", async () => {
    const register = moveFileRegistry();

    await expect(
      createAiHostExecution(request({ toolName: "list_directory", arguments: { path: "/home" } }), {
        registry: register,
      }),
    ).rejects.toMatchObject({
      name: "HostExecutionNotDelegableError",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Approval binding failures
// ---------------------------------------------------------------------------

describe("createAiHostExecution — approval binding failures", () => {
  it("rejects a missing/foreign approval ('missing')", async () => {
    approvalMocks.getToolApproval.mockResolvedValue(null);

    await expect(
      createAiHostExecution(request(), { registry: moveFileRegistry() }),
    ).rejects.toMatchObject({ name: "HostExecutionApprovalError", kind: "missing" });
    expect(repoMocks.createHostExecution).not.toHaveBeenCalled();
  });

  it("rejects an expired approval ('expired')", async () => {
    approvalMocks.assertToolApprovalExecutable.mockImplementation(() => {
      throw new ToolApprovalExpiredError();
    });

    await expect(
      createAiHostExecution(request(), { registry: moveFileRegistry() }),
    ).rejects.toMatchObject({ name: "HostExecutionApprovalError", kind: "expired" });
    expect(repoMocks.createHostExecution).not.toHaveBeenCalled();
  });

  it("rejects a non-pending/non-approved approval ('not-pending')", async () => {
    approvalMocks.assertToolApprovalExecutable.mockImplementation(() => {
      throw new ToolApprovalNotExecutableError("rejected");
    });

    await expect(
      createAiHostExecution(request(), { registry: moveFileRegistry() }),
    ).rejects.toMatchObject({ name: "HostExecutionApprovalError", kind: "not-pending" });
  });

  it("rejects an approval for a DIFFERENT tool ('tool-mismatch')", async () => {
    approvalMocks.getToolApproval.mockResolvedValue(
      approvedApproval({ toolName: "copy_file" }),
    );

    await expect(
      createAiHostExecution(request(), { registry: moveFileRegistry() }),
    ).rejects.toMatchObject({ name: "HostExecutionApprovalError", kind: "tool-mismatch" });
  });

  it("rejects an approval for DIFFERENT arguments ('arguments-mismatch')", async () => {
    approvalMocks.getToolApproval.mockResolvedValue(
      approvedApproval({
        arguments: { sourcePath: "/home/other.txt", destinationPath: "/home/docs/other.txt" },
      }),
    );

    await expect(
      createAiHostExecution(request(), { registry: moveFileRegistry() }),
    ).rejects.toMatchObject({ name: "HostExecutionApprovalError", kind: "arguments-mismatch" });
  });

  it("rejects schema-invalid arguments even when the approval matches", async () => {
    await expect(
      createAiHostExecution(request({ arguments: { sourcePath: "" } }), {
        registry: moveFileRegistry(),
      }),
    ).rejects.toMatchObject({ name: "HostExecutionInvalidArgumentsError" });
    expect(repoMocks.createHostExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Happy path + regression
// ---------------------------------------------------------------------------

describe("createAiHostExecution — approved-write happy path and regression", () => {
  it("binds an executable, matching approval and persists WITH its approvalId", async () => {
    const record = await createAiHostExecution(request(), { registry: moveFileRegistry() });

    expect(record).toEqual(
      expect.objectContaining({
        id: FIXTURE_EXECUTION_ID,
        toolName: "move_file",
        approvalId: APPROVAL_ID,
      }),
    );
    expect(repoMocks.createHostExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        toolName: "move_file",
        callId: "c1",
        round: 1,
        arguments: { sourcePath: "/home/receipt.pdf", destinationPath: "/home/docs/receipt.pdf" },
        approvalId: APPROVAL_ID,
        expiresAt: FUTURE,
        now: NOW,
      }),
    );
  });

  it("still creates ungated reads WITHOUT an approvalId (regression)", async () => {
    const record = await createAiHostExecution(
      request({ toolName: "search_files", arguments: { query: "receipt" }, approvalId: undefined }),
      { registry: moveFileRegistry() },
    );

    expect(repoMocks.createHostExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "search_files",
        arguments: { query: "receipt" },
        approvalId: null,
      }),
    );
    expect(record.approvalId).toBeNull();
  });
});