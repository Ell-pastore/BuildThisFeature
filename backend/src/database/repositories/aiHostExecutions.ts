/**
 * Authenticated host-execution repository (Phase 10.39) — the ONLY place
 * `ai_host_executions` persistence touches Prisma.
 *
 * Boundary rules (database/README): no HTTP semantics, no Hono deps, no
 * filesystem access, no provider calls, no network. The repository persists
 * the Phase 10.39 host-execution contract (SCHEMA.md §6.9) under an
 * authenticated user's ownership. Ownership is enforced on every load and
 * modify: an `executionId` that is not owned by `userId` is indistinguishable
 * from one that does not exist (returns `null` / throws
 * `HostExecutionNotFoundError`).
 *
 * This layer stores ONLY a deferred execution's validated tool `arguments`
 * (the identifying input of the requested operation). It never stores raw
 * file contents, provider responses, model output, or resolved filesystem
 * state; it never executes anything and never invokes the tool registry.
 *
 * State machine (SCHEMA.md §6.9): `pending` → `executed` | `expired`.
 * `executed` is a SINGLE-USE seal — `executed_at` is stamped exactly once on
 * resume and the row can never authorize a second execution. `expired` is
 * reachable only from `pending` once `expires_at` has passed without a
 * submission. Rows are transient conversation state: the schema cascades
 * them away with their conversation/message (like `ai_tool_approvals`, §6.8).
 */
import { getDatabase } from "../client.js";
import type { Prisma } from "../generated/prisma/client.js";

// ---------------------------------------------------------------------------
// Status constants
// ---------------------------------------------------------------------------

/** Closed host-execution state domain (SCHEMA.md §6.9; DB-enforced CHECK). */
export const HostExecutionStatus = {
  Pending: "pending",
  Executed: "executed",
  Expired: "expired",
} as const;

export type HostExecutionStatus =
  (typeof HostExecutionStatus)[keyof typeof HostExecutionStatus];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when an execution id is unknown OR belongs to another user
 *  (both are deliberately indistinguishable). */
export class HostExecutionNotFoundError extends Error {
  readonly code = "host-execution/not-found-or-not-owned";
  constructor() {
    super("Host execution not found for this user.");
    this.name = "HostExecutionNotFoundError";
  }
}

/** Thrown when a pending execution already exists for the same message + tool + call. */
export class HostExecutionDuplicateError extends Error {
  readonly code = "host-execution/duplicate-pending";
  readonly messageId: string;
  readonly toolName: string;
  readonly callId: string;
  constructor(messageId: string, toolName: string, callId: string) {
    super(
      `A pending host execution already exists for tool "${toolName}" (call "${callId}") in message "${messageId}".`,
    );
    this.name = "HostExecutionDuplicateError";
    this.messageId = messageId;
    this.toolName = toolName;
    this.callId = callId;
  }
}

/** Thrown when an execution's window elapsed before it was submitted. */
export class HostExecutionExpiredError extends Error {
  readonly code = "host-execution/expired";
  constructor() {
    super("This host execution has expired.");
    this.name = "HostExecutionExpiredError";
  }
}

/** Thrown when submitting an execution that is not still `pending`. */
export class HostExecutionAlreadyExecutedError extends Error {
  readonly code = "host-execution/already-executed";
  readonly status: HostExecutionStatus;
  constructor(status: HostExecutionStatus) {
    super(`This host execution is already ${status}.`);
    this.name = "HostExecutionAlreadyExecutedError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An `ai_host_executions` row projected into the app layer. */
export interface HostExecutionRecord {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  toolName: string;
  /** The provider intent this execution belongs to. */
  callId: string;
  /** Validated tool arguments identifying the requested operation. */
  arguments: unknown;
  /** The loop round in which the request was batched. */
  round: number;
  status: HostExecutionStatus;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  executedAt: Date | null;
  /** Owning approving tool approval (set only for approved host writes, §6.9). */
  approvalId: string | null;
}

/** Input for creating a NEW pending host execution. */
export interface CreateHostExecutionInput {
  /** Owning (authenticated) user. */
  userId: string;
  /** Owning AI conversation (must already exist and belong to `userId`). */
  conversationId: string;
  /** The persisted message/turn that produced the tool request. */
  messageId: string;
  /** A REGISTERED tool name (validated by the contract, not the repo). */
  toolName: string;
  /** The provider intent this execution belongs to. */
  callId: string;
  /** Validated tool arguments identifying the requested operation. */
  arguments: unknown;
  /** The loop round in which the request was batched. */
  round: number;
  /** Host-execution window bound; after this instant a pending row is expired. */
  expiresAt: Date;
  /** Owner of the approving tool approval this write executes (§6.9), or
   *  `null` for a normal ungated host-delegated read. */
  approvalId: string | null;
  /** Authoritative "now" for timestamps + expiry checks (injectable). */
  now: Date;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function toRecord(row: {
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
}): HostExecutionRecord {
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    toolName: row.toolName,
    callId: row.callId,
    arguments: row.arguments,
    round: row.round,
    status: row.status as HostExecutionStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
    approvalId: row.approvalId,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a NEW pending host execution for a user-owned conversation/message.
 * One pending execution per (messageId, toolName, callId): a second pending
 * request for the same intent is a duplicate and is rejected before anything
 * is written. Ownership is structural (`userId` on the row) — there is no
 * cross-user read path.
 *
 * @throws `HostExecutionDuplicateError` when a pending execution already
 *         exists for the same message + tool + call.
 */
export async function createHostExecution(
  input: CreateHostExecutionInput,
): Promise<HostExecutionRecord> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    const existing = await tx.aiHostExecution.findFirst({
      where: {
        messageId: input.messageId,
        toolName: input.toolName,
        callId: input.callId,
        status: HostExecutionStatus.Pending,
      },
      select: { id: true },
    });
    if (existing !== null) {
      throw new HostExecutionDuplicateError(input.messageId, input.toolName, input.callId);
    }
    const created = await tx.aiHostExecution.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        toolName: input.toolName,
        callId: input.callId,
        arguments: asJson(input.arguments),
        round: input.round,
        status: HostExecutionStatus.Pending,
        createdAt: input.now,
        updatedAt: input.now,
        expiresAt: input.expiresAt,
        executedAt: null,
        approvalId: input.approvalId,
      },
    });
    return toRecord(created);
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Load ONE host execution OWNED by `userId`, or `null` when it does not exist
 * for `userId` (ownership enforced — a foreign execution is indistinguishable
 * from a missing one).
 */
export async function getHostExecution(
  userId: string,
  executionId: string,
): Promise<HostExecutionRecord | null> {
  const db = getDatabase();
  const row = await db.aiHostExecution.findFirst({
    where: { id: executionId, userId },
  });
  return row === null ? null : toRecord(row);
}

/**
 * Load the ONE `pending` execution for a given message + tool + call owned by
 * `userId`, or `null` when none is pending. Used by the Phase 10.39 invocation
 * gate to make a duplicate host-execution request IDEMPOTENT: the second
 * request surfaces the existing pending execution instead of writing a second
 * row (the repository's one-pending-per-(message, tool, call) rule stays the
 * enforcement backstop). Ownership is enforced by the `userId` predicate.
 */
export async function getPendingHostExecution(
  userId: string,
  messageId: string,
  toolName: string,
  callId: string,
): Promise<HostExecutionRecord | null> {
  const db = getDatabase();
  const row = await db.aiHostExecution.findFirst({
    where: {
      userId,
      messageId,
      toolName,
      callId,
      status: HostExecutionStatus.Pending,
    },
  });
  return row === null ? null : toRecord(row);
}

/**
 * Load the ONE `pending` host execution linked to an approving tool approval,
 * or `null` when none is pending (approved host writes, §6.9). An approval is
 * SINGLE-USE: at most one pending execution may be authorized by it (enforced
 * by the partial unique index on `(approval_id) WHERE status = 'pending'` in
 * the migration). This read makes a re-submitted approval-resume IDEMPOTENT:
 * a second resume surfaces the FIRST pending execution instead of attempting
 * a second row. Ownership is enforced by the `userId` predicate.
 */
export async function getPendingHostExecutionByApproval(
  userId: string,
  approvalId: string,
): Promise<HostExecutionRecord | null> {
  const db = getDatabase();
  const row = await db.aiHostExecution.findFirst({
    where: {
      userId,
      approvalId,
      status: HostExecutionStatus.Pending,
    },
  });
  return row === null ? null : toRecord(row);
}

/**
 * List the current user's PENDING host executions, oldest-first. Ownership is
 * structural (`userId`); only `pending` rows are returned. The existing
 * partial `(user_id, expires_at) WHERE status = 'pending'` index covers the
 * filter.
 */
export async function listPendingHostExecutions(userId: string): Promise<HostExecutionRecord[]> {
  const db = getDatabase();
  const rows = await db.aiHostExecution.findMany({
    where: { userId, status: HostExecutionStatus.Pending },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toRecord);
}

/**
 * List EVERY host execution OWNED by `userId` across the given conversations
 * (Phase 10.39), in ALL states (`pending`/`executed`/`expired`), oldest-first.
 * Used by the conversation history service to expose per-conversation turn
 * state and actionable pending executions. Ownership is structural (`userId`);
 * an empty conversation list returns `[]` without touching the database.
 */
export async function listHostExecutionsForConversations(
  userId: string,
  conversationIds: readonly string[],
): Promise<HostExecutionRecord[]> {
  if (conversationIds.length === 0) return [];
  const db = getDatabase();
  const rows = await db.aiHostExecution.findMany({
    where: {
      userId,
      conversationId: { in: [...conversationIds] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toRecord);
}

// ---------------------------------------------------------------------------
// Seal (single-use, Phase 10.39)
// ---------------------------------------------------------------------------

/**
 * Seal a PENDING host execution as EXECUTED: the host submitted its result
 * exactly once, so the row is terminal and can never be replayed. Ownership is
 * verified inside the same transaction as the write. Only `pending` rows may
 * be sealed.
 *
 * Expiry is enforced HERE, at the seal boundary: a `pending` row whose
 * `expires_at` has passed is first swept to `expired` and then throws
 * `HostExecutionExpiredError` — an expired execution can never be sealed.
 * `executed_at`/`updated_at` are stamped with `now`.
 *
 * @throws `HostExecutionNotFoundError` when the execution does not exist for
 *         `userId` (indistinguishable from foreign ownership).
 * @throws `HostExecutionAlreadyExecutedError` when the row is not `pending`.
 * @throws `HostExecutionExpiredError` when the window elapsed; the row is
 *         transitioned to `expired` before throwing.
 */
export async function sealHostExecution(
  userId: string,
  executionId: string,
  now: Date,
): Promise<HostExecutionRecord> {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    const owned = await tx.aiHostExecution.findFirst({
      where: { id: executionId, userId },
      select: { id: true, status: true, expiresAt: true },
    });
    if (owned === null) throw new HostExecutionNotFoundError();
    if (owned.status !== HostExecutionStatus.Pending) {
      throw new HostExecutionAlreadyExecutedError(owned.status as HostExecutionStatus);
    }
    if (now.getTime() >= owned.expiresAt.getTime()) {
      await tx.aiHostExecution.update({
        where: { id: executionId },
        data: {
          status: HostExecutionStatus.Expired,
          updatedAt: now,
        },
      });
      throw new HostExecutionExpiredError();
    }
    const updated = await tx.aiHostExecution.update({
      where: { id: executionId },
      data: {
        status: HostExecutionStatus.Executed,
        executedAt: now,
        updatedAt: now,
      },
    });
    return toRecord(updated);
  });
}