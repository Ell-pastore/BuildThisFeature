/**
 * Tool invocation service (Phase 9.8).
 *
 * The application/API entry point for invoking a registered tool. Given
 * an authenticated request (a Hono context that has been through
 * `requireAuth`), a tool name, and the untrusted input, it:
 *
 *   1. Obtains the identity from the authenticated session.
 *   2. Creates the `ToolExecutionContext`.
 *   3. Dispatches through the existing Tool Registry + policy pipeline.
 *   4. Returns the existing structured `ToolExecutionResult` / `ToolError`.
 *
 * Flow:
 *
 *   Authenticated request
 *   → createSessionExecutionContext(c)   (Phase 9.7)
 *   → Tool Registry check                (Phase 9.1)
 *   → APPROVAL GATE (Phase 10.28C)       (gated tools: create pending /
 *                                         execute stored args — never both)
 *   → dispatchTool(registry, name, input, { filesystem }, context)
 *   → policy → handler → executor
 *
 * Trust model: the identity is read from the session established by
 * `requireAuth` (via `createSessionExecutionContext`). The `input` is
 * untrusted and never influences identity; request-supplied identity
 * fields are ignored.
 *
 * No AI/LLM/provider, no new tools, no write/destructive operations,
 * and no new auth/context/policy system. The registry and
 * FilesystemExecutor are injected so the service is testable without
 * Tauri and so any future executor wiring can be substituted here.
 */
import { createSessionExecutionContext } from "../tools/sessionContext.js";
import {
  dispatchTool,
  runToolPreflight,
} from "../tools/handlers/index.js";
import { isToolRegistryError, type ToolRegistry } from "../tools/registry.js";
import { requiresToolApproval, type ToolDefinition } from "../tools/types.js";
import { ToolError, ToolErrorCode } from "../tools/errors.js";
import {
  isHostDelegatedFilesystemExecutor,
  type FilesystemExecutor,
} from "../tools/executor.js";
import { requireString } from "../tools/handlers/handler.js";
import { hasControlCharacters, validateToolPath } from "../tools/paths.js";
import type {
  RawToolInput,
  ToolExecutionResult,
  ToolFailureResult,
} from "../tools/handlers/handler.js";
import type { ToolExecutionContext, ToolPolicy } from "../tools/policy.js";
import {
  ToolApprovalDuplicateError,
  ToolApprovalInvalidArgumentsError,
  ToolApprovalValidationError,
  assertToolApprovalExecutable,
  createAiToolApproval,
  getPendingToolApproval,
  getToolApproval,
} from "./aiToolApprovals.js";
import {
  HostExecutionDuplicateError,
  HostExecutionInvalidArgumentsError,
  HostExecutionValidationError,
  createAiHostExecution,
  getPendingHostExecution,
} from "./aiHostExecutions.js";

/** Dependencies the invocation service needs to run pipeline stages. */
export interface InvokeToolOptions {
  /** The injected Tool Registry (Phase 9.1). Never bypassed. */
  registry: ToolRegistry;
  /** The injected FilesystemExecutor — the bridge to Tauri/Rust. */
  filesystem: FilesystemExecutor;
  /**
   * Optional policy override, mirroring `dispatchTool`. Defaults to the
   * Phase 9.5 default policy.
   */
  policy?: ToolPolicy;
  /**
   * Optional persistent-turn provenance (Phase 10.28C-prep). A bounded
   * persistent turn eagerly commits its conversation and the round's
   * assistant/tool-call message BEFORE the round's intents execute, then
   * threads the two REAL persisted ids here so `invokeTool` can bind them
   * to the `ToolExecutionContext` at the invocation boundary. Absent for
   * direct / non-persistent invocations — behavior is unchanged.
   */
  turnContext?: AgentTurnContext;
  /**
   * Trusted approval-presentation channel (Phase 10.28C). When set for an
   * APPROVAL-GATED tool, the invocation executes ONLY the exact validated
   * arguments stored in this owned, `approved`, unexpired approval — the
   * caller-supplied `input` is never executed. When absent, a gated tool is
   * NEVER executed: a pending approval is created and an
   * `approval_required` result is returned. Never sourced from provider
   * output or from the untrusted tool input; ignored for tools that do not
   * declare `requiresApproval: true`.
   */
  approvalId?: string;
  /**
   * Provider-intent provenance for host-delegated tool calls (Phase 10.39).
   * When the executor is a `HostDelegatedFilesystemExecutor`, an ungated read
   * tool is NOT executed in this process: the gate records a scoped
   * `ai_host_executions` row identified by `callId` and `toolRounds` and
   * returns a typed `host_execution_required` result for the desktop host.
   * Both values come from the controlled agent-loop layer, never from
   * provider output or the untrusted tool input. Ignored unless the executor
   * is host-delegated.
   */
  callId?: string;
  toolRounds?: number;
}

/**
 * The authenticated, PERSISTED conversation/message context a tool call
 * belongs to. Produced only by the persistent-turn layer from committed
 * repository rows — these ids are never supplied by provider output or
 * by the untrusted tool input.
 */
export interface AgentTurnContext {
  /** Persisted owning conversation id (UUID, repository-assigned). */
  conversationId: string;
  /** Persisted assistant/tool-call message id owning the current round. */
  messageId: string;
}

// ---------------------------------------------------------------------------
// Approval gate (Phase 10.28C)
// ---------------------------------------------------------------------------

/** How long a freshly created pending approval stays decidable. */
export const TOOL_APPROVAL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Safe, typed information about the pending approval a gated invocation
 * produced. Deliberately narrow: the approval id (so the caller / user can
 * reference it), the tool name, the VALIDATED arguments that were stored,
 * and the expiry of the approval window. No execution has happened.
 */
export interface ToolApprovalRequestInfo {
  /** The persisted pending approval id. */
  readonly approvalId: string;
  /** The registered tool the approval was created for. */
  readonly toolName: string;
  /** The schema-validated arguments stored in the approval. */
  readonly arguments: unknown;
  /** When the approval window closes. */
  readonly expiresAt: Date;
}

/**
 * The typed `approval_required` result: a structured failure (category
 * `security`, code `tools/approval-required`) enriched with the pending
 * approval's safe information. The gated tool was NOT executed.
 */
export interface ToolApprovalRequiredResult extends ToolFailureResult {
  /** Discriminator, always `true` on an approval_required result. */
  readonly approvalRequired: true;
  /** The pending approval's safe information. */
  readonly approval: ToolApprovalRequestInfo;
}

/** Narrow a tool execution result to an `approval_required` result. */
export function isToolApprovalRequiredResult(
  result: ToolExecutionResult,
): result is ToolApprovalRequiredResult {
  return (
    !result.ok &&
    "approvalRequired" in result &&
    result.approvalRequired === true &&
    "approval" in result
  );
}

/**
 * Invoke a registered tool for the authenticated session user.
 *
 * Security chain (Phase 10.28C): authentication → registry → APPROVAL →
 * policy → handler → executor. The approval stage sits between the registry
 * and the policy, inside this service — `dispatchTool` stays approval-agnostic.
 *
 * - Throws `AppError.unauthorized()` when no session identity is present.
 * - A tool with `requiresApproval: true` is NEVER executed directly:
 *   - without `options.approvalId` a PENDING approval is created (requires
 *     the persisted turn context) and a typed `approval_required` result is
 *     returned — the handler and executor are never reached;
 *   - with `options.approvalId` the gate loads the approval owned by the
 *     authenticated user, requires the exact tool name and an `approved`,
 *     unexpired state, and executes ONLY the stored validated arguments —
 *     still through the unchanged policy → handler → executor pipeline.
 * - Every other outcome is returned as a structured `ToolExecutionResult`.
 */
export async function invokeTool(
  c: { get: (key: string) => unknown },
  toolName: string,
  input: RawToolInput,
  options: InvokeToolOptions,
): Promise<ToolExecutionResult> {
  const executionContext = createSessionExecutionContext(c, options.turnContext);

  // Gate 1 — REGISTRY. Mirrors dispatchTool's first gate so the approval
  // decision below is made only for REGISTERED tools; an unknown tool
  // produces the identical structured error it always has.
  let definition: ToolDefinition;
  try {
    definition = options.registry.get(toolName);
  } catch (error) {
    if (isToolRegistryError(error)) {
      return {
        ok: false,
        error: new ToolError(
          "unknown_tool",
          error.code,
          `The requested tool "${toolName}" is not available.`,
        ),
      };
    }
    return { ok: false, error: ToolError.internal() };
  }

  // Gate 2 — APPROVAL. A gated tool never reaches policy/handler/executor
  // without an executable approval; ungated tools are unchanged.
  if (requiresToolApproval(definition)) {
    return runApprovalGate(executionContext, toolName, input, options);
  }

  // Gate 3 — HOST (Phase 10.39). Only when the executor is host-delegated
  // and NOT gated above: an ungated read tool must NOT execute in this
  // process — a scoped host-execution record is created for the desktop host.
  // The gate declines (`null`) for non-delegated read tools, missing
  // provenance, or missing turn context, in which case the unchanged pipeline
  // below runs; a read tool that actually reaches the doomed executor fails
  // closed with a security error.
  if (isHostDelegatedFilesystemExecutor(options.filesystem)) {
    const delegated = await runHostExecutionGate(
      executionContext,
      toolName,
      input,
      options,
    );
    if (delegated !== null) return delegated;
  }

  // Gates 4+ — policy → handler → executor, exactly as before.
  return dispatchTool(
    options.registry,
    toolName,
    input,
    { filesystem: options.filesystem },
    executionContext,
    options.policy,
  );
/**
 * The Phase 10.28C approval stage. Two strictly separated paths:
 *
 *   - EXECUTE (an approval was explicitly presented): load the OWNED record,
 *     require the exact tool name and an `approved`, unexpired state, then
 *     dispatch the approval's STORED arguments. The caller-supplied input is
 *     ignored — arguments, tool name, conversation, message, and identity
 *     cannot be altered by the caller.
 *   - CREATE (no approval presented): record a PENDING approval bound to the
 *     authenticated user and the persisted turn context, and return
 *     `approval_required`. The tool is not executed.
 *
 * Every rejection is a structured `security` result; nothing is executed.
 */
async function runApprovalGate(
  executionContext: ToolExecutionContext,
  toolName: string,
  input: RawToolInput,
  options: InvokeToolOptions,
): Promise<ToolExecutionResult> {
  const identity =
    executionContext.actor.kind === "ai-agent"
      ? executionContext.actor.identity
      : undefined;
  const userId = identity?.userId;
  if (userId === undefined || userId.length === 0) {
    return {
      ok: false,
      error: ToolError.security(
        ToolErrorCode.IdentityMissing,
        "Tool execution requires an authenticated identity.",
      ),
    };
  }

  // ---- EXECUTE path: an explicitly presented approval -----------------------
  if (options.approvalId !== undefined) {
    const record = await getToolApproval(userId, options.approvalId);
    if (record === null) {
      // Missing or foreign — deliberately indistinguishable.
      return {
        ok: false,
        error: ToolError.security(
          ToolErrorCode.ApprovalNotFound,
          "Tool approval not found for this user.",
        ),
      };
    }
    if (record.toolName !== toolName) {
      return {
        ok: false,
        error: ToolError.security(
          ToolErrorCode.ApprovalToolMismatch,
          `This tool approval was not created for tool "${toolName}".`,
        ),
      };
    }
    try {
      // The real Phase 10.28B guard: only `approved` AND inside the window.
      assertToolApprovalExecutable(record, new Date());
    } catch (error) {
      return {
        ok: false,
        error: ToolError.security(
          ToolErrorCode.ApprovalNotExecutable,
          error instanceof Error
            ? error.message
            : "This tool approval cannot be executed.",
        ),
      };
    }
    // Execute the EXACT stored, validated arguments — never the caller's
    // input — through the unchanged policy → handler → executor pipeline.
    return dispatchTool(
      options.registry,
      toolName,
      record.arguments as RawToolInput,
      { filesystem: options.filesystem },
      executionContext,
      options.policy,
    );
  }

  // ---- CREATE path: record a pending approval, execute nothing --------------
  if (options.turnContext === undefined) {
    return {
      ok: false,
      error: ToolError.security(
        ToolErrorCode.ApprovalContextMissing,
        `Tool "${toolName}" requires approval, which needs a persisted conversation and message context.`,
      ),
    };
  }
  // Phase 10.36: run the tool's read-only PREFLIGHT BEFORE any approval record
  // exists. A preflight performs DEEP validation that the generic schema check
  // cannot express (source exists + is a file, destination parent is a folder,
  // destination is free, both paths stay within permitted scope). Failing here
  // means NO approval is created and NOTHING executes — an approval can never
  // encode arguments that are provably invalid or unsafe at creation time.
  const preflightError = await runToolPreflight(
    toolName,
    input,
    options.filesystem,
  );
  if (preflightError !== null) {
    return { ok: false, error: preflightError };
  }
  const now = new Date();
  try {
    const record = await createAiToolApproval(
      {
        userId,
        conversationId: options.turnContext.conversationId,
        messageId: options.turnContext.messageId,
        toolName,
        arguments: input,
        expiresAt: new Date(now.getTime() + TOOL_APPROVAL_WINDOW_MS),
        now,
      },
      { registry: options.registry },
    );
    return approvalRequiredResult(record);
  } catch (error) {
    if (error instanceof ToolApprovalInvalidArgumentsError) {
      return {
        ok: false,
        error: ToolError.validation(ToolErrorCode.ApprovalInvalidArguments, error.message),
      };
    }
    if (error instanceof ToolApprovalDuplicateError) {
      // Idempotent re-request: surface the EXISTING pending approval for the
      // same message + tool instead of writing a second row.
      const existing = await getPendingToolApproval(
        userId,
        options.turnContext.messageId,
        toolName,
      );
      if (existing !== null) {
        return approvalRequiredResult(existing);
      }
      return {
        ok: false,
        error: ToolError.security(
          ToolErrorCode.ApprovalRequired,
          `A pending approval already exists for tool "${toolName}" in this message.`,
        ),
      };
    }
    if (error instanceof ToolApprovalValidationError) {
      // Malformed turn-context ids or expiry — fail closed, execute nothing.
      return {
        ok: false,
        error: ToolError.security(ToolErrorCode.ApprovalContextMissing, error.message),
      };
    }
    // UnknownTool / NotRequired cannot occur (the registry was pre-checked),
    // and any other failure (e.g. a foreign conversation id violating the FK)
    // is fail-closed: execute nothing.
    return { ok: false, error: ToolError.internal() };
  }
}

/** Build the typed `approval_required` result for a pending record. */
function approvalRequiredResult(record: {
  id: string;
  toolName: string;
  arguments: unknown;
  expiresAt: Date;
}): ToolApprovalRequiredResult {
  return {
    ok: false,
    error: ToolError.security(
      ToolErrorCode.ApprovalRequired,
      `Tool "${record.toolName}" requires user approval; approval ${record.id} is pending and the tool was not executed.`,
    ),
    approvalRequired: true,
    approval: {
      approvalId: record.id,
      toolName: record.toolName,
      arguments: record.arguments,
      expiresAt: record.expiresAt,
    },
  };
}
}

// ---------------------------------------------------------------------------
// Host-execution gate (Phase 10.39)
// ---------------------------------------------------------------------------

/** How long a freshly created pending host-execution stays decidable. */
export const HOST_EXECUTION_WINDOW_MS = 15 * 60 * 1000;

/**
 * The un-gated, READ-ONLY tools the desktop host executes locally. Write
 * tools are not listed: `move_file` requires approval and must never be
 * host-delegated (it stays behind the Phase 10.28 approval flow). This set is
 * the ONLY set Phase 10.39 delegates — anything else reaching a
 * host-delegated executor fails closed.
 */
export const HOST_DELEGATED_READ_TOOLS: ReadonlySet<string> = new Set([
  "list_directory",
  "search_files",
  "get_file_metadata",
  "read_file",
]);

/**
 * Safe, typed information about the pending host execution a delegated
 * invocation produced. Deliberately narrow: the execution id (so the desktop
 * host / caller can reference it), the tool name, the VALIDATED arguments
 * stored for the host, and the expiry of the window. No execution has
 * happened.
 */
export interface HostExecutionRequestInfo {
  /** The persisted pending host-execution id. */
  readonly executionId: string;
  /** The registered tool the host execution was created for. */
  readonly toolName: string;
  /** The schema-validated arguments stored for the host. */
  readonly arguments: unknown;
  /** When the host-execution window closes. */
  readonly expiresAt: Date;
}

/**
 * The typed `host_execution_required` result: a structured failure (category
 * `security`, code `tools/host-execution-required`) enriched with the pending
 * host execution's safe information. The tool was NOT executed in this
 * process — the desktop host is expected to execute it locally and submit.
 */
export interface HostExecutionRequiredResult extends ToolFailureResult {
  /** Discriminator, always `true` on a host-execution-required result. */
  readonly executionRequired: true;
  /** The pending host execution's safe information. */
  readonly execution: HostExecutionRequestInfo;
}

/** Narrow a tool execution result to a `host_execution_required` result. */
export function isHostExecutionRequiredResult(
  result: ToolExecutionResult,
): result is HostExecutionRequiredResult {
  return (
    !result.ok &&
    "executionRequired" in result &&
    result.executionRequired === true &&
    "execution" in result
  );
}

/**
 * The Phase 10.39 host-delegation stage, reached ONLY when the executor is
 * host-delegated AND the tool passed the approval gate above (so it is an
 * ungated, read-only tool).
 *
 * Returns a `host_execution_required` result after writing one scoped pending
 * host-execution row for the desktop host; returns `null` when the request is
 * NOT delegable, so `invokeTool` falls through to the unchanged dispatch —
 * where a read tool hitting the doomed executor fails closed.
 *
 * Every rejection is a structured `security` (or `validation`) result from the
 * gate; nothing in this process is executed. Shallow-to-deep argument checks
 * (schema shape via `createAiHostExecution`, path semantics for the
 * path-valued reads) run BEFORE any row is written.
 */
async function runHostExecutionGate(
  executionContext: ToolExecutionContext,
  toolName: string,
  input: RawToolInput,
  options: InvokeToolOptions,
): Promise<ToolExecutionResult | null> {
  const identity =
    executionContext.actor.kind === "ai-agent"
      ? executionContext.actor.identity
      : undefined;
  const userId = identity?.userId;
  if (userId === undefined || userId.length === 0) {
    return {
      ok: false,
      error: ToolError.security(
        ToolErrorCode.HostExecutionContextMissing,
        "Host execution requires an authenticated identity.",
      ),
    };
  }
  if (options.turnContext === undefined) {
    return {
      ok: false,
      error: ToolError.security(
        ToolErrorCode.HostExecutionContextMissing,
        `Tool "${toolName}" is delegated to the desktop host, which needs a persisted conversation and message context.`,
      ),
    };
  }
  if (!HOST_DELEGATED_READ_TOOLS.has(toolName)) {
    // Not a delegated read tool — let the unchanged pipeline run (a write
    // tool reaching the doomed executor fails closed).
    return null;
  }
  if (options.callId === undefined || options.toolRounds === undefined) {
    return {
      ok: false,
      error: ToolError.security(
        ToolErrorCode.HostExecutionContextMissing,
        `Tool "${toolName}" is delegated to the desktop host, which needs an intent call id and a round number.`,
      ),
    };
  }

  const pathError = validateHostExecutionReadArgs(toolName, input);
  if (pathError !== null) return { ok: false, error: pathError };

  try {
    const record = await createAiHostExecution(
      {
        userId,
        conversationId: options.turnContext.conversationId,
        messageId: options.turnContext.messageId,
        toolName,
        callId: options.callId,
        arguments: input,
        round: options.toolRounds,
        expiresAt: new Date(Date.now() + HOST_EXECUTION_WINDOW_MS),
      },
      { registry: options.registry },
    );
    return hostExecutionRequiredResult(record);
  } catch (error) {
    if (error instanceof HostExecutionInvalidArgumentsError) {
      return {
        ok: false,
        error: ToolError.validation(
          ToolErrorCode.HostExecutionInvalidArguments,
          error.message,
        ),
      };
    }
    if (error instanceof HostExecutionDuplicateError) {
      // Idempotent re-request: surface the EXISTING pending execution for the
      // same message + tool + call instead of writing a second row.
      const existing = await getPendingHostExecution(
        userId,
        options.turnContext.messageId,
        error.toolName,
        error.callId,
      );
      if (existing !== null) {
        return hostExecutionRequiredResult(existing);
      }
      return {
        ok: false,
        error: ToolError.security(
          ToolErrorCode.HostExecutionRequired,
          `A pending host execution already exists for tool "${toolName}" in this message.`,
        ),
      };
    }
    if (error instanceof HostExecutionValidationError) {
      // Malformed turn-context ids or expiry — fail closed, execute nothing.
      return {
        ok: false,
        error: ToolError.security(
          ToolErrorCode.HostExecutionContextMissing,
          error.message,
        ),
      };
    }
    // UnknownTool / NotDelegable cannot occur (the registry was pre-checked
    // and approval-gated tools never reach this gate); any other failure
    // (e.g. a foreign conversation id violating the FK) is fail-closed.
    return { ok: false, error: ToolError.internal() };
  }
}

/**
 * Deep, shape-only validation of the delegated read tools' arguments. The
 * `createAiHostExecution` schema check is shape-only; this adds the path
 * semantics the real handlers enforce (absolute + in-scope, control-free),
 * acting as the pre-write first gate — a host-execution record can never
 * encode clearly invalid or unsafe arguments. Messages never include the raw
 * path. Returns `null` when the arguments are well-formed.
 */
function validateHostExecutionReadArgs(
  toolName: string,
  input: RawToolInput,
): ToolError | null {
  const mandatoryPath =
    toolName === "list_directory" ||
    toolName === "get_file_metadata" ||
    toolName === "read_file";
  const required = requireString(input, "path");
  if (mandatoryPath && !required.ok) return required.error;
  if ("path" in input) {
    if (typeof input.path !== "string") {
      return ToolError.validation(
        ToolErrorCode.InvalidPath,
        "Field \"path\" must be a string.",
      );
    }
    const validated = validateToolPath(input.path);
    if (!validated.ok) return validated.error;
  }
  if ("query" in input) {
    if (typeof input.query !== "string") {
      return ToolError.validation(
        ToolErrorCode.InvalidPath,
        "Field \"query\" must be a string.",
      );
    }
    if (hasControlCharacters(input.query)) {
      return ToolError.validation(
        ToolErrorCode.InvalidPath,
        "Field \"query\" contains an invalid character.",
      );
    }
  }
  return null;
}

/** Build the typed `host_execution_required` result for a pending record. */
function hostExecutionRequiredResult(record: {
  id: string;
  toolName: string;
  arguments: unknown;
  expiresAt: Date;
}): HostExecutionRequiredResult {
  return {
    ok: false,
    error: ToolError.security(
      ToolErrorCode.HostExecutionRequired,
      `Tool "${record.toolName}" is delegated to the desktop host; host execution ${record.id} is pending and the tool was not executed.`,
    ),
    executionRequired: true,
    execution: {
      executionId: record.id,
      toolName: record.toolName,
      arguments: record.arguments,
      expiresAt: record.expiresAt,
    },
  };
}