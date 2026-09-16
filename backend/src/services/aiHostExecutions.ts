/**
 * Host-execution CONTRACT (Phase 10.39) — the application layer that decides
 * whether, and against what, a host execution is created and sealed, on top
 * of the `ai_host_executions` persistence (SCHEMA.md §6.9).
 *
 * The contract is SMALL and provider-independent:
 *
 *   - CREATE validates the request BEFORE any write: the ids are UUID-shaped,
 *     `toolName` must be a REGISTERED tool, THE TOOL MUST MATCH ITS GATE
 *     (ungated reads do NOT carry an `approvalId`; approved writes MUST — the
 *     container is what makes a deferred request host-delegable without first
 *     "executing" it through the Phase 10.28 resume), `arguments` must satisfy
 *     the tool's `inputSchema`, and `expiresAt` must be a future instant.
 *   - APPROVAL-LINKED WRITES (§6.9, today only `move_file`) additionally bind
 *     the execution to a PENDING, user-owned, unexpired approval whose stored
 *     tool name and arguments EXACTLY match the deferred call. The link is
 *     single-use: at most one pending execution per approval (DB partial unique
 *     index), and the approval is consumed by `persistentAgentTurn.seal()` the
 *     same transaction the execution seals — so an approved move runs exactly
 *     once, then the approval is terminal.
 *   - SUBMIT is a single-use seal via the repository (`sealHostExecution`):
 *     the row becomes `executed` with `executed_at` stamped and can never be
 *     replayed. Expiry is enforced at the seal boundary.
 *   - OWNERSHIP is the authenticated user passed in by the caller and enforced
 *     structurally by the repository (`where: { userId }`); a foreign execution
 *     is indistinguishable from a missing one.
 *   - NO HOST FILE OPERATION HAPPENS HERE – never. The contract only records
 *     and gates: the DESKTOP HOST executes the tool locally and submits its
 *     result through this contract, and the resume path seals each record
 *     through `submitHostExecution` before continuing the bounded turn.
 *   - SECRECY: only the validated `arguments` that identify the requested
 *     operation are stored. No raw file contents, filesystem paths beyond the
 *     tool's own identifying arguments, provider responses, model output, or
 *     submission results ever enter an execution record.
 *
 * The registry is injected so tests exercise the REAL registry/validation
 * path without a database; the repository is a thin persistence seam.
 */
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition, ToolInputSchema } from "../tools/types.js";
import { requiresToolApproval } from "../tools/types.js";
import { CONVERSATION_ID_PATTERN } from "./conversationId.js";
import {
  HostExecutionStatus,
  HostExecutionAlreadyExecutedError,
  HostExecutionDuplicateError,
  HostExecutionExpiredError,
  HostExecutionNotFoundError,
  createHostExecution,
  getHostExecution,
  getPendingHostExecution,
  getPendingHostExecutionByApproval,
  listHostExecutionsForConversations as listHostExecutionsForConversationsRepo,
  listPendingHostExecutions as listPendingHostExecutionsRepo,
  sealHostExecution,
  type HostExecutionRecord,
} from "../database/repositories/aiHostExecutions.js";
import {
  ToolApprovalExpiredError,
  ToolApprovalInvalidArgumentsError,
  assertToolApprovalExecutable,
  getToolApproval,
  validateToolApprovalArguments,
} from "./aiToolApprovals.js";

// Re-export the full persistence surface under one contract import.
export {
  HostExecutionStatus,
  HostExecutionAlreadyExecutedError,
  HostExecutionDuplicateError,
  HostExecutionExpiredError,
  HostExecutionNotFoundError,
  getHostExecution,
  getPendingHostExecution,
  getPendingHostExecutionByApproval,
  type HostExecutionRecord,
};

// ---------------------------------------------------------------------------
// Contract errors (application-level gates)
// ---------------------------------------------------------------------------

/**
 * Registered APPROVED-WRITE tools that run on the DESKTOP HOST (§6.9). Only
 * the tools in this container may be created with an `approvalId`: they defer
 * behind a host execution the moment their approval is granted, instead of
 * resuming through the Phase 10.28 executor. The container is deliberately
 * minimal and grows one blessed tool at a time.
 */
export const HOST_DELEGATED_APPROVED_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "move_file",
  "copy_file",
]);

/** Thrown when a request cannot form a valid host execution. */
export class HostExecutionValidationError extends Error {
  readonly code = "host-execution/invalid-input";
  constructor(message: string) {
    super(message);
    this.name = "HostExecutionValidationError";
  }
}

/** Thrown when `toolName` is not a registered tool. */
export class HostExecutionUnknownToolError extends Error {
  readonly code = "host-execution/unknown-tool";
  readonly toolName: string;
  constructor(toolName: string) {
    super(`No registered tool named "${toolName}".`);
    this.name = "HostExecutionUnknownToolError";
    this.toolName = toolName;
  }
}

/** Thrown when a tool requires user approval (not host-delegated). */
export class HostExecutionNotDelegableError extends Error {
  readonly code = "host-execution/not-delegable";
  readonly toolName: string;
  constructor(toolName: string) {
    super(
      `Tool "${toolName}" requires user approval, so it cannot be host-executed.`,
    );
    this.name = "HostExecutionNotDelegableError";
    this.toolName = toolName;
  }
}

/** Thrown when tool arguments do not satisfy the tool's input schema. */
export class HostExecutionInvalidArgumentsError extends Error {
  readonly code = "host-execution/invalid-arguments";
  readonly toolName: string;
  constructor(toolName: string, reason: string) {
    super(`Invalid arguments for tool "${toolName}": ${reason}`);
    this.name = "HostExecutionInvalidArgumentsError";
    this.toolName = toolName;
  }
}

/**
 * Thrown when a create request with an `approvalId` cannot bind to the
 * approving approval (approved host writes, §6.9). The `.kind` discriminates
 * the exact reason for API mapping and tests.
 */
export class HostExecutionApprovalError extends Error {
  readonly code = "host-execution/approval";
  readonly kind:
    | "missing"
    | "not-pending"
    | "expired"
    | "not-owned"
    | "tool-mismatch"
    | "arguments-mismatch"
    | "required"
    | "not-allowed";
  readonly toolName?: string;
  constructor(
    kind: HostExecutionApprovalError["kind"],
    message: string,
    toolName?: string,
  ) {
    super(message);
    this.name = "HostExecutionApprovalError";
    this.kind = kind;
    if (toolName !== undefined) this.toolName = toolName;
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateHostExecutionRequest {
  /** The authenticated user requesting/owning the execution. */
  userId: string;
  /** uuid of the owning AI conversation (validated here). */
  conversationId: unknown;
  /** uuid of the persisted message/turn that produced the request. */
  messageId: unknown;
  /** Registered tool name to delegate. */
  toolName: unknown;
  /** The provider intent this execution belongs to. */
  callId: unknown;
  /** The loop round in which the request was batched. */
  round: unknown;
  /** Untrusted tool arguments — validated against the tool's schema. */
  arguments: unknown;
  /** The granting approval for an APPROVED WRITE (§6.9), or undefined for a
   *  normal ungated host-delegated request. Validated against the approval's
   *  stored tool name + arguments and bound single-use to this execution. */
  approvalId?: string;
  /** End of the host-execution window, as a `Date` strictly after `now`. */
  expiresAt: unknown;
  /** Injectable "now"; defaults to `new Date()`. */
  now?: Date;
}

/**
 * Create a pending host execution after validating the FULL request against
 * the tool registry: known tool, schema-valid arguments (gated by the tool's
 * approval posture — see below), a future expiry, and, for APPROVED WRITES,
 * a matching pendable approval owned by this user. Defers the pending-row
 * write to the repository (which enforces the one-pending-per-(message,
 * tool, call) rule, the one-pending-per-(approval) partial unique index, and
 * ownership).
 *
 * Gate pairing (§6.9): `approvalId` is REQUIRED exactly for the approved-write
 * container `HOST_DELEGATED_APPROVED_WRITE_TOOLS` and FORBIDDEN for every
 * other tool. Approval-gated tools outside the container are not host-delegable
 * (they belong to the Phase 10.28 approval flow), and ungated reads must not
 * masquerade as approved writes.
 *
 * @throws `HostExecutionValidationError` on malformed ids / expiry.
 * @throws `HostExecutionUnknownToolError` for unregistered tool names.
 * @throws `HostExecutionNotDelegableError` when the tool is approval-gated
 *         AND outside the approved-write container.
 * @throws `HostExecutionApprovalError` (kind `required` / `not-allowed`) when
 *         the approvalId ↔ tool gate pairing is violated.
 * @throws `HostExecutionApprovalError` (kinds `missing`, `expired`,
 *         `not-pending`, `not-owned`, `tool-mismatch`, `arguments-mismatch`)
 *         when the provided approval cannot authorize this exact call.
 * @throws `HostExecutionInvalidArgumentsError` for schema-invalid arguments.
 * @throws the repository's duplicate/DB errors unchanged.
 */
export async function createAiHostExecution(
  request: CreateHostExecutionRequest,
  deps: { registry: ToolRegistry },
): Promise<HostExecutionRecord> {
  if (typeof request.userId !== "string" || request.userId.length === 0) {
    throw new HostExecutionValidationError("A non-empty userId is required.");
  }
  if (!isUuid(request.conversationId)) {
    throw new HostExecutionValidationError("A valid conversationId is required.");
  }
  if (!isUuid(request.messageId)) {
    throw new HostExecutionValidationError("A valid messageId is required.");
  }
  if (typeof request.callId !== "string" || request.callId.length === 0) {
    throw new HostExecutionValidationError("A non-empty callId is required.");
  }
  if (
    typeof request.round !== "number" ||
    !Number.isInteger(request.round) ||
    request.round < 1
  ) {
    throw new HostExecutionValidationError("round must be a positive integer.");
  }

  const now = request.now ?? new Date();
  const expiresAt = request.expiresAt;
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new HostExecutionValidationError("expiresAt must be a valid Date.");
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new HostExecutionValidationError("expiresAt must be in the future.");
  }

  if (typeof request.toolName !== "string" || request.toolName.length === 0) {
    throw new HostExecutionValidationError("A non-empty toolName is required.");
  }

  let definition: Readonly<ToolDefinition>;
  try {
    definition = deps.registry.get(request.toolName);
  } catch {
    // Registry miss = the request references an unknown, unblessed tool.
    throw new HostExecutionUnknownToolError(request.toolName);
  }

  const isApprovedWrite = HOST_DELEGATED_APPROVED_WRITE_TOOLS.has(definition.name);
  const hasApprovalId = request.approvalId !== undefined;
  if (isApprovedWrite && !hasApprovalId) {
    throw new HostExecutionApprovalError(
      "required",
      `Tool "${definition.name}" is an approved host write and requires an approvalId.`,
      definition.name,
    );
  }
  if (!isApprovedWrite && requiresToolApproval(definition)) {
    throw new HostExecutionNotDelegableError(definition.name);
  }
  if (!isApprovedWrite && hasApprovalId) {
    throw new HostExecutionApprovalError(
      "not-allowed",
      `Tool "${definition.name}" is not an approved host write and cannot carry an approvalId.`,
      definition.name,
    );
  }

  try {
    validateToolApprovalArguments(definition.name, definition.inputSchema, request.arguments);
  } catch (error) {
    if (error instanceof ToolApprovalInvalidArgumentsError) {
      // Re-shape the shared validator's error under the host contract.
      throw new HostExecutionInvalidArgumentsError(definition.name, error.message);
    }
    throw error;
  }

  let approvalId: string | null = null;
  if (request.approvalId !== undefined) {
    if (!isUuid(request.approvalId)) {
      throw new HostExecutionValidationError("A valid approvalId is required.");
    }
    const approval = await getToolApproval(request.userId, request.approvalId);
    if (approval === null) {
      throw new HostExecutionApprovalError(
        "missing",
        "The approving tool approval does not exist for this user.",
      );
    }
    try {
      assertToolApprovalExecutable(approval, now);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "The approving tool approval is not pending.";
      if (error instanceof ToolApprovalExpiredError) {
        throw new HostExecutionApprovalError(
          "expired",
          `The approving tool approval is expired: ${reason}`,
          approval.toolName,
        );
      }
      throw new HostExecutionApprovalError(
        "not-pending",
        `The approving tool approval cannot authorize this execution: ${reason}`,
        approval.toolName,
      );
    }
    if (approval.toolName !== definition.name) {
      throw new HostExecutionApprovalError(
        "tool-mismatch",
        `Approval "${approval.id}" authorizes tool "${approval.toolName}", not "${definition.name}".`,
        definition.name,
      );
    }
    if (!deepEqualJson(approval.arguments, request.arguments)) {
      throw new HostExecutionApprovalError(
        "arguments-mismatch",
        `Approval "${approval.id}" authorizes different tool arguments.`,
        definition.name,
      );
    }
    approvalId = approval.id;
  }

  return createHostExecution({
    userId: request.userId,
    conversationId: request.conversationId,
    messageId: request.messageId,
    toolName: definition.name,
    callId: request.callId,
    arguments: request.arguments,
    round: request.round,
    expiresAt,
    approvalId,
    now,
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Load ONE host execution owned by `userId`. Ownership is structural.
 *
 * @throws `HostExecutionValidationError` on a malformed execution id.
 */
export async function getAiHostExecution(
  userId: string,
  executionId: unknown,
): Promise<HostExecutionRecord | null> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new HostExecutionValidationError("A non-empty userId is required.");
  }
  if (!isUuid(executionId)) {
    throw new HostExecutionValidationError("A valid executionId is required.");
  }
  return getHostExecution(userId, executionId);
}

/**
 * List the authenticated user's pending host executions, oldest-first.
 * Ownership is structural; only `pending` rows are returned.
 */
export async function listPendingHostExecutions(userId: string): Promise<HostExecutionRecord[]> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new HostExecutionValidationError("A non-empty userId is required.");
  }
  return listPendingHostExecutionsRepo(userId);
}

// ---------------------------------------------------------------------------
// Submit (single-use seal, Phase 10.39)
// ---------------------------------------------------------------------------

/**
 * Submit the host's result for one pending execution, sealing it so it can
 * never be replayed or double-submitted. Ownership is enforced by the
 * repository.
 *
 * @throws `HostExecutionValidationError` on a malformed execution id.
 * @throws repository errors unchanged (`HostExecutionNotFoundError`,
 *         `HostExecutionAlreadyExecutedError`, `HostExecutionExpiredError`).
 */
export async function submitHostExecution(
  userId: string,
  executionId: unknown,
  now: Date = new Date(),
): Promise<HostExecutionRecord> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new HostExecutionValidationError("A non-empty userId is required.");
  }
  if (!isUuid(executionId)) {
    throw new HostExecutionValidationError("A valid executionId is required.");
  }
  return sealHostExecution(userId, executionId, now);
}

// ---------------------------------------------------------------------------
// Executable guard (no host work happens here)
// ---------------------------------------------------------------------------

/**
 * Whether a host execution can currently be submitted: it must be `pending`
 * AND inside its window (`now < expiresAt`). Pure.
 */
export function isHostExecutionExecutable(record: HostExecutionRecord, now: Date): boolean {
  return (
    record.status === HostExecutionStatus.Pending && now.getTime() < record.expiresAt.getTime()
  );
}

/**
 * Guard the resume path must pass before sealing a host execution.
 *
 * @throws `HostExecutionNotExecutableError` when the execution is not
 *         `pending`; `HostExecutionExpiredError` when the execution window has
 *         elapsed (an expired execution cannot be submitted).
 */
export function assertHostExecutionExecutable(record: HostExecutionRecord, now: Date): void {
  if (record.status !== HostExecutionStatus.Pending) {
    throw new HostExecutionNotExecutableError(record.status);
  }
  if (now.getTime() >= record.expiresAt.getTime()) {
    throw new HostExecutionExpiredError();
  }
}

/** Thrown when a host execution cannot be submitted (not pending). */
export class HostExecutionNotExecutableError extends Error {
  readonly code = "host-execution/not-submittable";
  readonly status: string;
  constructor(status: string) {
    super(
      status === HostExecutionStatus.Pending
        ? "This host execution is still awaiting the host's submission."
        : `This host execution is ${status} and cannot be submitted.`,
    );
    this.name = "HostExecutionNotExecutableError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Shared safe projection for the conversation history API (Phase 10.39)
// ---------------------------------------------------------------------------

/**
 * Safe, content-free projection of one persisted host execution for
 * authenticated API responses. `arguments` are the validated tool arguments
 * (identification only — never raw contents); the owner's `userId` is
 * deliberately dropped because it is implied by authentication. Timestamps
 * are ISO strings.
 */
export interface AiHostExecution {
  id: string;
  conversationId: string;
  messageId: string;
  toolName: string;
  callId: string;
  arguments: Readonly<Record<string, unknown>>;
  round: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  executedAt: string | null;
}

/** Pure projection of a persisted record into the safe API shape. */
export function toAiHostExecution(record: HostExecutionRecord): AiHostExecution {
  return {
    id: record.id,
    conversationId: record.conversationId,
    messageId: record.messageId,
    toolName: record.toolName,
    callId: record.callId,
    arguments: record.arguments as Readonly<Record<string, unknown>>,
    round: record.round,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    executedAt: record.executedAt === null ? null : record.executedAt.toISOString(),
  };
}

/**
 * List EVERY host execution owned by `userId` for `conversationIds` (all
 * states, oldest-first), projected through `toAiHostExecution`. Empty input
 * returns `[]` without a database read.
 */
export async function listConversationHostExecutions(
  userId: string,
  conversationIds: readonly string[],
): Promise<AiHostExecution[]> {
  if (conversationIds.length === 0) return [];
  const records = await listHostExecutionsForConversationsRepo(userId, conversationIds);
  return records.map(toAiHostExecution);
}

// ---------------------------------------------------------------------------
// UUID-shape validation (shared convention, §conversationId.ts)
// ---------------------------------------------------------------------------

function isUuid(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Ordered JSON equality (approved-write argument binding, §6.9)
// ---------------------------------------------------------------------------

/**
 * Canonical deep-equality for approving a deferred host call against the
 * approval's STORED arguments: both sides are valid JSON values, so a
 * recursively-ordered stringify is a UNSAFE-FALLBACK-free, locale-independent
 * exact comparison. Used by `createAiHostExecution` to guarantee the host
 * executes EXACTLY the operation the user approved (the approval's persisted
 * `arguments` must equal the deferred call's `arguments` field-for-field).
 */
function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}