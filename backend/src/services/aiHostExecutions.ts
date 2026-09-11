/**
 * Host-execution CONTRACT (Phase 10.39) — the application layer that decides
 * whether, and against what, a host execution is created and sealed, on top
 * of the `ai_host_executions` persistence (SCHEMA.md §6.9).
 *
 * The contract is SMALL and provider-independent:
 *
 *   - CREATE validates the request BEFORE any write: the ids are UUID-shaped,
 *     `toolName` must be a REGISTERED tool, that tool must NOT declare
 *     `requiresApproval: true` (approval-gated tools are never host-delegated:
 *     they stay behind the Phase 10.28 approval flow), `arguments` must
 *     satisfy the tool's `inputSchema`, and `expiresAt` must be a future
 *     instant.
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
  listHostExecutionsForConversations as listHostExecutionsForConversationsRepo,
  listPendingHostExecutions as listPendingHostExecutionsRepo,
  sealHostExecution,
  type HostExecutionRecord,
} from "../database/repositories/aiHostExecutions.js";
import {
  ToolApprovalInvalidArgumentsError,
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
  type HostExecutionRecord,
};

// ---------------------------------------------------------------------------
// Contract errors (application-level gates)
// ---------------------------------------------------------------------------

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
  /** End of the host-execution window, as a `Date` strictly after `now`. */
  expiresAt: unknown;
  /** Injectable "now"; defaults to `new Date()`. */
  now?: Date;
}

/**
 * Create a pending host execution after validating the FULL request against
 * the tool registry: known tool, NOT approval-gated, schema-valid arguments,
 * a future expiry. Defers the pending-row write to the repository (which
 * enforces the one-pending-per-(message, tool, call) rule and ownership).
 *
 * @throws `HostExecutionValidationError` on malformed ids / expiry.
 * @throws `HostExecutionUnknownToolError` for unregistered tool names.
 * @throws `HostExecutionNotDelegableError` when the tool is approval-gated.
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

  if (requiresToolApproval(definition)) {
    throw new HostExecutionNotDelegableError(definition.name);
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

  return createHostExecution({
    userId: request.userId,
    conversationId: request.conversationId,
    messageId: request.messageId,
    toolName: definition.name,
    callId: request.callId,
    arguments: request.arguments,
    round: request.round,
    expiresAt,
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