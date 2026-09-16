/**
 * AI plan execution (Phase 11.2).
 *
 * `POST /api/ai/plans/execute` turns a structured `FileIntentPlan` (produced
 * by `POST /api/ai/plans`) into filesystem operations through the EXISTING
 * persistent agent-turn runtime — without an LLM. A deterministic provider
 * (pure function of the plan + prior tool results) resolves semantic
 * references into absolute paths via read-only `search_files` tool calls, then
 * issues the single write (`move_file` for MOVE/RENAME, `copy_file` for COPY)
 * through the unchanged approval gate, policy, handler, and executor pipeline.
 *
 * Design rules:
 *
 *   - NO LLM: the provider is a deterministic state machine that never
 *     calls an external model. The `generate()` return is fully derived
 *     from the plan shape and the `toolResults` already executed.
 *   - DETERMINISTIC RESOLUTION: semantic references are resolved by
 *     filtering `search_files` results — by name/location/kind — never by
 *     asking a model to "discover" paths. Absolute paths bypass discovery
 *     entirely and are used verbatim (the same minimality rule the agent
 *     system instruction enforces for user-supplied paths).
 *   - EXISTING PIPELINE: MOVE/RENAME run `move_file`, COPY runs `copy_file` —
 *     both through the EXISTING approval gate → policy → handler → executor
 *     pipeline. The approval requires a persisted `turnContext`; the write
 *     requires approval; on host-delegated filesystems the §6.9 approved-write
 *     deferral pauses and resumes identically to the instruction flow.
 *  - MOVE + RENAME + COPY ONLY: other intents, unsupported intents, folder
 *    sources, multi-operation plans, copy/delete/organize, and any non-plan
 *    body fields are all rejected with a typed `PlanExecutionError` → 400
 *    structured JSON. A RENAME derives its destination deterministically from
 *    the resolved source's parent directory plus the requested new name — it
 *    never honors a caller-supplied destination. A COPY resolves its
 *    destination as the DIRECTORY only (the copy keeps the source's own file
 *    name) — it never appends the source filename to an exact path.
 *   - STRICT BODY: only `conversationId` (optional), `instruction`
 *     (required), `plan` (required), `approvalId` (optional), and
 *     `resumeExecutions` (optional) are accepted. Identity comes
 *     exclusively from the session.
 *   - RESUME SAFE: the provider is stateless (`plan + results → next
 *     action`). A fresh provider is created per request from the plan
 *     echoed in the body; resume via `approvalId` or
 *     `resumeExecutions` works identically because the seeded
 *     `toolResults` carry all the state the provider needs.
 */
import { AppError } from "../core/errors.js";
import { isConversationId } from "./conversationId.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  readToolDefinitions,
  registerReadTools,
} from "../tools/definitions/readTools.js";
import {
  writeToolDefinitions,
  registerWriteTools,
} from "../tools/definitions/writeTools.js";
import { hasControlCharacters, parentDirectory, validateToolPath } from "../tools/paths.js";
import { ToolErrorCode } from "../tools/errors.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { ToolDefinition } from "../tools/types.js";
import type { FileEntry } from "../tools/tauriShapes.js";
import type { MoveFileResult } from "../tools/handlers/moveFile.js";
import type { CopyFileResult } from "../tools/handlers/copyFile.js";
import type { EntityIntentReference, FileIntentPlan } from "../tools/handlers/planIntent.js";
import { ENTITY_REFERENCE_KINDS } from "../tools/handlers/planIntent.js";
import type { AgentToolCall, AgentToolResult } from "./agent.js";
import type {
  AgentProvider,
  AgentProviderRequest,
  AgentResponse,
} from "./provider.js";
import {
  runPersistentTurn,
  type PersistentTurnInput,
  type PersistentTurnResult,
} from "./persistentAgentTurn.js";
import {
  toAiInstructionResponse,
  mapAgentTurnError,
  parseResumeExecutions,
  type AiHostExecutionSubmissionInput,
  type AiInstructionResponse,
} from "./aiInstructions.js";

// ---------------------------------------------------------------------------
// Plan execution error
// ---------------------------------------------------------------------------

export const PlanExecutionErrorCode = {
  Unsupported: "unsupported",
  Ambiguous: "ambiguous",
  NotFound: "not-found",
  Invalid: "invalid",
} as const;

export type PlanExecutionErrorCode =
  (typeof PlanExecutionErrorCode)[keyof typeof PlanExecutionErrorCode];

export class PlanExecutionError extends Error {
  readonly code: PlanExecutionErrorCode;
  constructor(code: PlanExecutionErrorCode, message: string) {
    super(message);
    this.name = "PlanExecutionError";
    this.code = code;
  }
}

export function isPlanExecutionError(error: unknown): error is PlanExecutionError {
  return error instanceof PlanExecutionError;
}

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

export const MAX_PLAN_EXECUTION_TOOL_ROUNDS = 5;

// ---------------------------------------------------------------------------
// Deterministic payload ids (the provider + resolver share these)
// ---------------------------------------------------------------------------

export const PLAN_PAYLOAD_IDS = {
  sourceSearch: "sfm-source-search",
  destinationSearch: "sfm-destination-search",
  move: "sfm-move",
  copy: "sfm-copy",
} as const;

// ---------------------------------------------------------------------------
// Strict body validation
// ---------------------------------------------------------------------------

const PLAN_EXECUTION_BODY_FIELDS = new Set([
  "conversationId",
  "instruction",
  "plan",
  "approvalId",
  "resumeExecutions",
]);

export interface AiPlanExecutionBody {
  conversationId?: string;
  instruction: string;
  plan: FileIntentPlan;
  approvalId?: string;
  resumeExecutions?: readonly AiHostExecutionSubmissionInput[];
}

/**
 * Parse and strictly validate the plan execution request body. Rejects
 * missing/empty/whitespace-only/oversized instructions, a non-object body,
 * an unexpected field (including a body-supplied user id), a missing or
 * malformed plan, and a malformed conversationId/approvalId.
 *
 * @throws `AppError.badRequest` (400) on any violation.
 */
export function parseAiPlanExecutionInput(raw: unknown): AiPlanExecutionBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw AppError.badRequest("Request body must be a JSON object.");
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PLAN_EXECUTION_BODY_FIELDS.has(key)) {
      throw AppError.badRequest(`Unexpected field "${key}" in request body.`);
    }
  }

  const instructionRaw = record.instruction;
  if (typeof instructionRaw !== "string") {
    throw AppError.badRequest("Instruction must be a string.");
  }
  const instruction = instructionRaw.trim();
  if (instruction.length === 0) {
    throw AppError.badRequest("Instruction must not be empty.");
  }
  if (instruction.length > 4096) {
    throw AppError.badRequest(
      "Instruction must be at most 4096 characters long.",
    );
  }

  const planRaw = record.plan;
  if (typeof planRaw !== "object" || planRaw === null || Array.isArray(planRaw)) {
    throw AppError.badRequest("Plan must be a JSON object.");
  }

  let conversationId: string | undefined;
  if (record.conversationId !== undefined) {
    if (!isConversationId(record.conversationId)) {
      throw AppError.badRequest("A valid conversationId is required when resuming a conversation.");
    }
    conversationId = record.conversationId;
  }

  let approvalId: string | undefined;
  if (record.approvalId !== undefined) {
    if (!isConversationId(record.approvalId)) {
      throw AppError.badRequest("A valid approvalId is required when resuming an approval.");
    }
    approvalId = record.approvalId;
  }

  let resumeExecutions: AiHostExecutionSubmissionInput[] | undefined;
  if (record.resumeExecutions !== undefined) {
    resumeExecutions = parseResumeExecutions(record.resumeExecutions);
  }

  return {
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(approvalId !== undefined ? { approvalId } : {}),
    ...(resumeExecutions !== undefined ? { resumeExecutions } : {}),
    instruction,
    plan: planRaw as FileIntentPlan,
  };
}

// ---------------------------------------------------------------------------
// Plan validation (defense-in-depth)
// ---------------------------------------------------------------------------

const VALID_ENTITY_KINDS = new Set<string>(ENTITY_REFERENCE_KINDS);

/**
 * Validate a plan body for execution. Accepts MOVE, RENAME, and COPY intents;
 * rejects unsupported plans, malformed source/destination references,
 * semantic references without name or description, invalid path references,
 * for RENAME a missing or malformed `newName`, and for MOVE/COPY a missing
 * destination reference.
 *
 * @throws `PlanExecutionError` on any violation.
 */
export function validatePlanForExecution(plan: unknown): FileIntentPlan {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      "Plan must be a JSON object.",
    );
  }

  const p = plan as Record<string, unknown>;

  if (
    typeof p.intent !== "string" ||
    (p.intent !== "MOVE" && p.intent !== "RENAME" && p.intent !== "COPY")
  ) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Unsupported,
      `Intent "${String(p.intent ?? "")}" is not supported for execution. Only MOVE, RENAME, and COPY are supported.`,
    );
  }

  if (p.supported !== true) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Unsupported,
      "This plan is marked as unsupported.",
    );
  }

  if (p.requiresApproval !== true) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      `The plan's requiresApproval flag must be true for a ${p.intent}.`,
    );
  }

  // --- source ---
  if (typeof p.source !== "object" || p.source === null || Array.isArray(p.source)) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      "Source must be a JSON object.",
    );
  }
  validateEntityReference(p.source as Record<string, unknown>, "source", p.intent as string);

  if (p.intent === "RENAME") {
    // RENAME derives its target path from the resolved source's parent
    // directory plus the requested new name. A caller-supplied destination
    // is NEVER honored — if present it is still shape-validated, but it is
    // ignored when the actual move_file arguments are built.
    if (
      typeof p.operation !== "object" ||
      p.operation === null ||
      Array.isArray(p.operation)
    ) {
      throw new PlanExecutionError(
        PlanExecutionErrorCode.Invalid,
        "The plan's operation must be an object.",
      );
    }
    validateRenameNewName((p.operation as Record<string, unknown>).newName);
    if (p.destination !== undefined) {
      if (
        typeof p.destination !== "object" ||
        p.destination === null ||
        Array.isArray(p.destination)
      ) {
        throw new PlanExecutionError(
          PlanExecutionErrorCode.Invalid,
          "Destination must be a JSON object.",
        );
      }
      validateEntityReference(p.destination as Record<string, unknown>, "destination", p.intent as string);
    }
    return plan as FileIntentPlan;
  }

  // --- MOVE/COPY: a destination reference is required ---
  if (typeof p.destination !== "object" || p.destination === null || Array.isArray(p.destination)) {
    const action = p.intent === "COPY" ? "COPY" : "MOVE";
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      `A destination reference is required for a ${action}.`,
    );
  }
  validateEntityReference(p.destination as Record<string, unknown>, "destination", p.intent as string);

  return plan as FileIntentPlan;
}

function validateEntityReference(
  ref: Record<string, unknown>,
  label: string,
  intent = "MOVE",
): void {
  const refKind = ref.reference;
  if (refKind !== "path" && refKind !== "semantic") {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      `The ${label} reference type must be "path" or "semantic".`,
    );
  }

  const kind = ref.kind;
  if (typeof kind !== "string" || !VALID_ENTITY_KINDS.has(kind)) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      `The ${label} kind must be one of: file, folder, any, unknown.`,
    );
  }

  if (kind === "folder" && label === "source") {
    const action = intent === "RENAME" ? "renamed" : intent === "COPY" ? "copied" : "moved";
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Unsupported,
      `Folders cannot be ${action}. Only files are supported.`,
    );
  }

  if (refKind === "path") {
    const absolutePath = ref.absolutePath;
    if (typeof absolutePath !== "string" || absolutePath.trim().length === 0) {
      throw new PlanExecutionError(
        PlanExecutionErrorCode.Invalid,
        `The ${label} absolutePath must be a non-empty string.`,
      );
    }
    const guard = validateToolPath(absolutePath);
    if (!guard.ok) {
      throw new PlanExecutionError(
        PlanExecutionErrorCode.Invalid,
        `The ${label} path is invalid: ${guard.error.message}`,
      );
    }
  }

  if (refKind === "semantic") {
    const name = ref.name;
    const description = ref.description;
    const hasName = typeof name === "string" && name.trim().length > 0;
    const hasDescription = typeof description === "string" && description.trim().length > 0;
    if (!hasName && !hasDescription) {
      throw new PlanExecutionError(
        PlanExecutionErrorCode.Invalid,
        `The ${label} reference has no searchable name or description.`,
      );
    }
  }
}

/**
 * Validate a RENAME's requested new name: a non-empty plain file name with
 * no path separators, no traversal segments, and no control characters.
 * Returns the trimmed name on success.
 *
 * @throws `PlanExecutionError` (invalid) on any violation.
 */
export function validateRenameNewName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      "The new name must be a string.",
    );
  }
  const name = raw.trim();
  if (name.length === 0) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      "The new name must not be empty.",
    );
  }
  if (
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      "The new name must be a plain file name without path separators.",
    );
  }
  if (hasControlCharacters(name)) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      "The new name contains an invalid character.",
    );
  }
  return name;
}

// ---------------------------------------------------------------------------
// Deterministic reference resolver
// ---------------------------------------------------------------------------

function searchQueryFor(ref: EntityIntentReference): string {
  if (typeof ref.name === "string" && ref.name.trim().length > 0) return ref.name.trim();
  if (typeof ref.description === "string" && ref.description.trim().length > 0) {
    return ref.description.trim();
  }
  throw new PlanExecutionError(
    PlanExecutionErrorCode.Invalid,
    "The reference has no usable search query (name or description).",
  );
}

function findResult(results: readonly AgentToolResult[], id: string): AgentToolResult | undefined {
  return results.find((r) => r.callId === id);
}

function filterByLocation(
  ref: EntityIntentReference,
  entries: FileEntry[],
): FileEntry[] {
  if (typeof ref.location !== "string" || ref.location.trim().length === 0) return entries;
  const lower = ref.location.toLowerCase();
  return entries.filter((e) => e.path.toLowerCase().includes(lower));
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]+/);
  return parts[parts.length - 1] ?? "";
}

function joinPathFolder(folder: string, name: string): string {
  if (folder.endsWith("/") || folder.endsWith("\\")) return folder + name;
  const sep = folder.includes("\\") ? "\\" : "/";
  return folder + sep + name;
}

function resolveSourcePath(
  ref: EntityIntentReference,
  results: readonly AgentToolResult[],
  intent: string = "MOVE",
): string {
  if (ref.reference === "path") {
    const absolutePath = ref.absolutePath;
    if (absolutePath === undefined || absolutePath.length === 0) {
      throw new PlanExecutionError(
        PlanExecutionErrorCode.Invalid,
        "Source absolutePath is missing.",
      );
    }
    return absolutePath;
  }

  const search = findResult(results, PLAN_PAYLOAD_IDS.sourceSearch);
  if (search === undefined) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      "Source search result is missing.",
    );
  }
  if (!search.ok) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.NotFound,
      "The source could not be found.",
    );
  }

  const matches = (search.data ?? []) as FileEntry[];
  let candidates = matches;

  const action = intent === "RENAME" ? "renamed" : intent === "COPY" ? "copied" : "moved";

  // Filter by kind: RENAME/MOVE only support files.
  if (ref.kind === "file") {
    candidates = candidates.filter((e) => !e.isFolder);
  } else if (ref.kind === "folder") {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Unsupported,
      `Folders cannot be ${action}. Only files are supported.`,
    );
  }

  // Apply optional location filter.
  candidates = filterByLocation(ref, candidates);

  if (candidates.length === 0) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.NotFound,
      `No file matching "${searchQueryFor(ref)}" was found.`,
    );
  }
  if (candidates.length > 1) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Ambiguous,
      `Multiple files match "${searchQueryFor(ref)}". Refine the source reference.`,
    );
  }

  const entry = candidates[0]!;
  if (entry.isFolder) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Unsupported,
      `Folders cannot be ${action}. Only files are supported.`,
    );
  }
  return entry.path;
}

/**
 * Derive the destination path for a RENAME plan: the resolved source's parent
 * directory plus the validated `newName` from the plan's operation. A
 * caller-supplied destination reference is NEVER used.
 */
function renameDestinationPath(
  sourcePath: string,
  plan: FileIntentPlan,
): string {
  const newName = validateRenameNewName(plan.operation.newName);
  const parent = parentDirectory(sourcePath);
  if (parent === null) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      "The resolved source path has no parent directory.",
    );
  }
  return joinPathFolder(parent, newName);
}

function resolveDestinationPath(
  ref: EntityIntentReference,
  sourceFileName: string,
  results: readonly AgentToolResult[],
): string {
  if (ref.reference === "path") {
    const absolutePath = ref.absolutePath;
    if (absolutePath === undefined || absolutePath.length === 0) {
      throw new PlanExecutionError(
        PlanExecutionErrorCode.Invalid,
        "Destination absolutePath is missing.",
      );
    }
    // When the destination reference is a folder, append the source file name.
    if (ref.kind === "folder") {
      return joinPathFolder(absolutePath, sourceFileName);
    }
    return absolutePath;
  }

  const search = findResult(results, PLAN_PAYLOAD_IDS.destinationSearch);
  if (search === undefined) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      "Destination search result is missing.",
    );
  }
  if (!search.ok) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.NotFound,
      "The destination could not be found.",
    );
  }

  const matches = (search.data ?? []) as FileEntry[];
  // Destination for a MOVE must be a folder.
  const folders = matches.filter((e) => e.isFolder);
  const candidates = filterByLocation(ref, folders);

  if (candidates.length === 0) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.NotFound,
      `The destination folder "${searchQueryFor(ref)}" was not found.`,
    );
  }
  if (candidates.length > 1) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Ambiguous,
      `Multiple folders match "${searchQueryFor(ref)}". Refine the destination reference.`,
    );
  }

  return joinPathFolder(candidates[0]!.path, sourceFileName);
}

/**
 * Resolve the destination DIRECTORY for a COPY. Unlike `resolveDestinationPath`
 * (MOVE) it NEVER appends the source file name — a copy keeps the source's own
 * name, so the resolved value IS the `destDirPath` handed to `copy_file`.
 */
function resolveDestinationDirectoryPath(
  ref: EntityIntentReference,
  results: readonly AgentToolResult[],
): string {
  if (ref.reference === "path") {
    const absolutePath = ref.absolutePath;
    if (absolutePath === undefined || absolutePath.length === 0) {
      throw new PlanExecutionError(
        PlanExecutionErrorCode.Invalid,
        "Destination absolutePath is missing.",
      );
    }
    return absolutePath;
  }

  const search = findResult(results, PLAN_PAYLOAD_IDS.destinationSearch);
  if (search === undefined) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      "Destination search result is missing.",
    );
  }
  if (!search.ok) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.NotFound,
      "The destination could not be found.",
    );
  }

  const matches = (search.data ?? []) as FileEntry[];
  const folders = matches.filter((e) => e.isFolder);
  const candidates = filterByLocation(ref, folders);

  if (candidates.length === 0) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.NotFound,
      `The destination folder "${searchQueryFor(ref)}" was not found.`,
    );
  }
  if (candidates.length > 1) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Ambiguous,
      `Multiple folders match "${searchQueryFor(ref)}". Refine the destination reference.`,
    );
  }

  return candidates[0]!.path;
}

/**
 * Resolve both references from the plan and prior search results into the
 * absolute paths the write tool requires. For RENAME the destination is derived
 * deterministically from the resolved source's parent plus the plan's
 * `operation.newName`; for MOVE the existing destination-ref resolver appends
 * the source file name; for COPY the destination resolves to the FOLDER only
 * (the copy keeps the source's own name).
 *
 * @throws `PlanExecutionError` when resolution fails (not-found, ambiguous,
 *         unsupported, invalid).
 */
export function resolvePlanReferences(
  plan: FileIntentPlan,
  results: readonly AgentToolResult[],
): { sourcePath: string; destinationPath: string } {
  const sourcePath = resolveSourcePath(plan.source, results, plan.intent);
  const sourceFileName = basenameOf(sourcePath);
  if (sourceFileName.length === 0) {
    throw new PlanExecutionError(
      PlanExecutionErrorCode.Invalid,
      "The resolved source path has no file name.",
    );
  }
  const destinationPath =
    plan.intent === "RENAME"
      ? renameDestinationPath(sourcePath, plan)
      : plan.intent === "COPY"
        ? resolveDestinationDirectoryPath(plan.destination!, results)
        : resolveDestinationPath(plan.destination!, sourceFileName, results);
  return { sourcePath, destinationPath };
}

// ---------------------------------------------------------------------------
// Deterministic provider (state machine, no LLM)
// ---------------------------------------------------------------------------

/**
 * Build a deterministic, stateless `AgentProvider` that executes a plan:
 *
 *   1. If the write-tool result (MOVE/RENAME `move_file`, COPY `copy_file`)
 *      exists → terminal: return final text.
 *   2. If any semantic reference needs discovery → issue `search_files`.
 *   3. All references resolved → issue the write tool.
 *
 * The provider is STATELESS (`plan + toolResults → response`). Resume
 * works because the seeded `toolResults` from `approvalId` or
 * `resumeExecutions` carry all the state the provider needs. The client
 * echoes the plan in the body on each request, so a fresh provider
 * created from that plan is functionally identical to the prior one.
 */
export function createPlanExecutorProvider(plan: FileIntentPlan): AgentProvider {
  // Validate once at creation; the deterministic loop never re-validates.
  validatePlanForExecution(plan);

  return {
    async generate(request: AgentProviderRequest): Promise<AgentResponse> {
      return stepPlanExecution(plan, request.toolResults ?? []);
    },
  };
}

function writeToolFor(intent: string): { payloadId: string; toolName: string } {
  if (intent === "COPY") {
    return { payloadId: PLAN_PAYLOAD_IDS.copy, toolName: "copy_file" };
  }
  // MOVE and RENAME converge on the SAME move_file write.
  return { payloadId: PLAN_PAYLOAD_IDS.move, toolName: "move_file" };
}

function stepPlanExecution(
  plan: FileIntentPlan,
  results: readonly AgentToolResult[],
): AgentResponse {
  // 1. Write-terminal? The loop's own round carries the payload id, but an
  //    approval/host-execution RESUME seeds the executed result with the
  //    approval id as its callId — both identify the same single write.
  const { payloadId, toolName } = writeToolFor(plan.intent);
  const writeResult =
    findResult(results, payloadId) ??
    results.find((r) => r.toolName === toolName);
  if (writeResult !== undefined) {
    return terminalFromOperationResult(writeResult, plan.intent);
  }

  // 2. Which searches are still needed? Discovery is limited to semantic
  //    references the resolver actually consumes: MOVE resolves both source
  //    and destination, RENAME only the source (its target path is derived),
  //    COPY resolves source + destination directory.
  const needsSourceSearch =
    plan.source.reference === "semantic" &&
    findResult(results, PLAN_PAYLOAD_IDS.sourceSearch) === undefined;
  const needsDestSearch =
    (plan.intent === "MOVE" || plan.intent === "COPY") &&
    plan.destination !== undefined &&
    plan.destination.reference === "semantic" &&
    findResult(results, PLAN_PAYLOAD_IDS.destinationSearch) === undefined;

  if (needsSourceSearch || needsDestSearch) {
    const calls: AgentToolCall[] = [];
    if (needsSourceSearch) {
      calls.push({
        id: PLAN_PAYLOAD_IDS.sourceSearch,
        toolName: "search_files",
        input: { query: searchQueryFor(plan.source) },
      });
    }
    if (needsDestSearch) {
      calls.push({
        id: PLAN_PAYLOAD_IDS.destinationSearch,
        toolName: "search_files",
        input: { query: searchQueryFor(plan.destination!) },
      });
    }
    return { toolCalls: calls };
  }

  // 3. All references resolved — issue the write tool.
  const { sourcePath, destinationPath } = resolvePlanReferences(plan, results);
  return {
    toolCalls: [
      {
        id: payloadId,
        toolName,
        // COPY is directory-shaped: the resolved value is the destination
        // DIRECTORY, never a source-file-named exact path. MOVE/RENAME keep
        // the exact-path shape.
        input:
          plan.intent === "COPY"
            ? { sourcePath, destDirPath: destinationPath }
            : { sourcePath, destinationPath },
      },
    ],
  };
}

function terminalFromOperationResult(
  result: AgentToolResult,
  intent: string,
): AgentResponse {
  if (intent === "COPY") {
    if (result.ok) {
      const data = result.data as CopyFileResult | undefined;
      if (data !== undefined && typeof data.copiedTo === "string") {
        return { text: `Copied the file to ${data.copiedTo}.` };
      }
      return { text: "Copied the file." };
    }
    if (result.error.code === ToolErrorCode.ApprovalRequired) {
      return {
        text: "Approval is required to copy the file. Review the pending approval to continue.",
      };
    }
    const reason = result.error.message.replace(/\.+$/, "");
    return { text: `The copy did not complete: ${reason}.` };
  }

  const isRename = intent === "RENAME";
  if (result.ok) {
    const data = result.data as MoveFileResult | undefined;
    if (data !== undefined && typeof data.movedTo === "string") {
      return {
        text: `${isRename ? "Renamed" : "Moved"} the file to ${data.movedTo}.`,
      };
    }
    return { text: isRename ? "Renamed the file." : "Moved the file." };
  }

  // Approval required (Phase 10.28C): the approval CREATE returned
  // `approval_required` as a ToolError with this code.
  if (result.error.code === ToolErrorCode.ApprovalRequired) {
    return {
      text: `Approval is required to ${isRename ? "rename" : "move"} the file. Review the pending approval to continue.`,
    };
  }

  // Any other failure — including a failed §6.9 host submission (which seeds
  // an ok:false result whose code may also read `host-execution-required`).
  const reason = result.error.message.replace(/\.+$/, "");
  return {
    text: `The ${isRename ? "rename" : "move"} did not complete: ${reason}.`,
  };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map plan execution and agent turn failures to safe, typed `AppError`s.
 *
 *   - `PlanExecutionError`  → 400 `ai/plan-execution/<code>` (safe, typed).
 *   - All agent turn / provider errors are mapped identically to the
 *     instruction flow via `mapAgentTurnError`.
 */
export function mapPlanExecutionError(error: unknown): unknown {
  if (error instanceof PlanExecutionError) {
    return new AppError(
      400,
      `ai/plan-execution/${error.code}`,
      error.message,
    );
  }
  return mapAgentTurnError(error);
}

// ---------------------------------------------------------------------------
// Plan execution runtime seam
// ---------------------------------------------------------------------------

export interface PlanExecutionRuntimeOptions {
  registry: ToolRegistry;
  tools: readonly ToolDefinition[];
  filesystem: FilesystemExecutor;
  maxToolRounds?: number;
  resolveFilesystem?: (
    c: { get: (key: string) => unknown },
  ) => FilesystemExecutor | undefined;
  resolveMaxToolRounds?: (
    c: { get: (key: string) => unknown },
  ) => number | undefined;
}

export interface PlanExecutionRuntime {
  run(
    c: { get: (key: string) => unknown },
    input: PersistentTurnInput,
    provider: AgentProvider,
  ): Promise<PersistentTurnResult>;
}

/**
 * Create a `PlanExecutionRuntime` from the given options. The runtime wraps
 * `runPersistentTurn` with a per-call deterministic provider, per-request
 * filesystem resolution, and per-request max-tool-rounds resolution — the
 * same seams the instruction runtime uses.
 *
 * The caller supplies the provider on each `run()` call (mutually exclusive
 * with `stack` inside `runPersistentTurn`), so the runtime never composes
 * its own provider stack.
 */
export function createPlanExecutionRuntime(
  options: PlanExecutionRuntimeOptions,
): PlanExecutionRuntime {
  return {
    async run(c, input, provider) {
      const filesystem = options.resolveFilesystem?.(c) ?? options.filesystem;
      const resolvedMaxToolRounds = options.resolveMaxToolRounds?.(c);
      return runPersistentTurn(c, input, {
        provider,
        tools: options.tools,
        registry: options.registry,
        filesystem,
        ...(options.maxToolRounds !== undefined
          ? { maxToolRounds: options.maxToolRounds }
          : {}),
        ...(resolvedMaxToolRounds !== undefined
          ? { maxToolRounds: resolvedMaxToolRounds }
          : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Validate, execute, and shape one plan execution through the deterministic
 * provider and the EXISTING persistent agent-turn runtime.
 *
 * @throws `AppError.badRequest` (400) on body or plan validation errors;
 *         thrown outcomes of `runtime.run` are mapped via
 *         `mapPlanExecutionError`.
 */
export async function runAiPlanExecutionWithRuntime(
  runtime: PlanExecutionRuntime,
  c: { get: (key: string) => unknown },
  raw: unknown,
): Promise<AiInstructionResponse> {
  const input = parseAiPlanExecutionInput(raw);
  const provider = createPlanExecutorProvider(input.plan);

  const turnInput: PersistentTurnInput = {
    ...(input.conversationId !== undefined
      ? { conversationId: input.conversationId }
      : {}),
    ...(input.approvalId !== undefined
      ? { resumeApprovalId: input.approvalId }
      : {}),
    ...(input.resumeExecutions !== undefined
      ? { resumeHostExecutions: input.resumeExecutions }
      : {}),
    instruction: input.instruction,
  };

  let result: PersistentTurnResult;
  try {
    result = await runtime.run(c, turnInput, provider);
  } catch (error) {
    throw mapPlanExecutionError(error);
  }

  return toAiInstructionResponse(result);
}

// ---------------------------------------------------------------------------
// Runtime seam — production binding
// ---------------------------------------------------------------------------

let boundPlanExecutionRuntime: PlanExecutionRuntime | undefined;
let boundPlanExecutionFilesystem: FilesystemExecutor | undefined;

/**
 * Bind the LONG-LIVED plan execution runtime used by the route. The
 * production binding calls this from `composeProductionAiRuntime` with a
 * runtime pre-bound to the same composed filesystem/registry/tools as the
 * instruction runtime. Pass `undefined` to clear (for tests).
 */
export function bindAiPlanExecutionRuntime(
  runtime: PlanExecutionRuntime | undefined,
): void {
  boundPlanExecutionRuntime = runtime;
}

/**
 * Alternative seam: bind only the filesystem executor. The runtime is built
 * lazily on first use from the registered read+write tool surface. Pass
 * `undefined` to clear (for tests).
 */
export function bindAiPlanExecutionFilesystem(
  filesystem: FilesystemExecutor | undefined,
): void {
  boundPlanExecutionFilesystem = filesystem;
}

function createDefaultAiPlanExecutionRuntime(): PlanExecutionRuntime {
  if (boundPlanExecutionFilesystem === undefined) {
    throw AppError.notConfigured("The AI tool filesystem executor");
  }
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  return createPlanExecutionRuntime({
    tools: [...readToolDefinitions, ...writeToolDefinitions],
    registry,
    filesystem: boundPlanExecutionFilesystem,
    maxToolRounds: MAX_PLAN_EXECUTION_TOOL_ROUNDS,
  });
}

function resolveAiPlanExecutionRuntime(): PlanExecutionRuntime {
  if (boundPlanExecutionRuntime !== undefined) return boundPlanExecutionRuntime;
  let runtime: PlanExecutionRuntime;
  try {
    runtime = createDefaultAiPlanExecutionRuntime();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.notConfigured("The AI provider");
  }
  boundPlanExecutionRuntime = runtime;
  return runtime;
}

/**
 * Production entry point used by the route: resolves the bound (or lazily
 * default) plan execution runtime, then runs the plan through it.
 */
export async function runAiPlanExecution(
  c: { get: (key: string) => unknown },
  raw: unknown,
): Promise<AiInstructionResponse> {
  return runAiPlanExecutionWithRuntime(resolveAiPlanExecutionRuntime(), c, raw);
}
