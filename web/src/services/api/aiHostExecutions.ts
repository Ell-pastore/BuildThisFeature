/**
 * Desktop host-execution driver (Phase 10.39).
 *
 * When the backend records one or more AI filesystem tool calls as host
 * executions (`POST /api/ai/instructions` returns a PAUSED turn with
 * `turn.pendingExecutions`), THIS module bridges the gap: it executes each
 * requested operation through the app's own `FilesystemProvider` (the same
 * Tauri IPC the interactive UI uses) and then resumes the SAME bounded turn
 * by submitting the results back through `resumeExecutions`.
 *
 * Guarantees that hold by construction:
 *
 *   - The driver ONLY runs inside the Tauri desktop webview
 *     (`isTauriEnv()`). In a plain browser it returns `null` and the caller
 *     keeps the paused conversation state — the backend never receives an
 *     execution result it cannot attribute.
 *   - Only the four backend-registered READ tools plus the single
 *     APPROVED-WRITE tool are executable here (`list_directory`,
 *     `search_files`, `get_file_metadata`, `read_file`, and `move_file`);
 *     anything else is submitted as a categorized failure, never executed.
 *     `move_file` is bound 1:1 to a user-approved tool approval on the backend
 *     (it REJECTS executions without an approval id) — the driver never
 *     decides what to move, it only carries out the exact approved paths.
 *   - Results are submitted with a bounded iteration count. Every execution
 *     row is sealed once (pending → executed/expired) by the backend on
 *     resume, so a fresh resume cannot double-execute.
 *   - Results are the tool handlers' canonical shapes (same as the bots own
 *     executor returns), and `read_file` returns the same
 *     `{ encoding: "base64", data }` envelope the backend tools produce.
 */
import { submitAiInstruction } from "./aiInstructions";
import { getFilesystemProvider } from "../filesystem";
import { isTauriEnv } from "../desktopEnv";
import type {
  AiHostExecutionSubmission,
  AiInstructionHostExecution,
  AiInstructionResponse,
} from "../../types/ai";

/** The resume instruction the driver uses to continue a paused turn. */
export const RESUME_AFTER_HOST_EXECUTION =
  "Continue after the requested operations have been executed.";

/** Structural host-execution request the driver can execute + submit. */
export type HostExecutionRequest = Pick<
  AiInstructionHostExecution,
  "executionId" | "toolName" | "arguments"
>;

/** Read tools the desktop host is allowed to execute on the backend's behalf. */
export const HOST_EXECUTABLE_READ_TOOLS: ReadonlySet<string> = new Set([
  "list_directory",
  "search_files",
  "get_file_metadata",
  "read_file",
]);

/**
 * The single APPROVED-WRITE tool the desktop host executes (§6.9). The
 * backend only defers it under an executable, single-use approval, so
 * arriving here means the OPERATION was already user-approved.
 */
export const HOST_EXECUTABLE_APPROVED_WRITE_TOOLS: ReadonlySet<string> = new Set(["move_file"]);

/** Every tool the driver actually executes; anything else is a categorized failure. */
export const HOST_EXECUTABLE_TOOLS: ReadonlySet<string> = new Set([
  ...HOST_EXECUTABLE_READ_TOOLS,
  ...HOST_EXECUTABLE_APPROVED_WRITE_TOOLS,
]);

/** Bounded resume churn: a stalled/slow turn can never loop forever. */
const MAX_HOST_EXECUTION_ITERATIONS = 10;

function requireArgumentString(
  args: unknown,
  key: string,
): string {
  const value =
    args !== null && typeof args === "object" && key in args
      ? (args as Readonly<Record<string, unknown>>)[key]
      : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing or invalid string argument "${key}".`);
  }
  return value;
}

/** Chunked bytes → base64 (avoids call-stack blowups on large files). */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    let segment = "";
    for (let j = 0; j < chunk.length; j += 1) {
      segment += String.fromCharCode(chunk[j]);
    }
    binary += segment;
  }
  return btoa(binary);
}

/**
 * Execute one host-execution request through the app's filesystem provider,
 * returning the tool handler's canonical result shape. Throws when the
 * operation cannot be executed; the caller categorizes the failure.
 */
export async function executeHostExecution(
  execution: HostExecutionRequest,
): Promise<unknown> {
  const provider = getFilesystemProvider();
  switch (execution.toolName) {
    case "list_directory": {
      const path = requireArgumentString(execution.arguments, "path");
      return provider.listDirectory(path);
    }
    case "search_files": {
      const query = requireArgumentString(execution.arguments, "query");
      return provider.searchFiles(query);
    }
    case "get_file_metadata": {
      const path = requireArgumentString(execution.arguments, "path");
      return provider.getFileMetadata(path);
    }
    case "read_file": {
      const path = requireArgumentString(execution.arguments, "path");
      const bytes = await provider.readFile(path);
      return { encoding: "base64", data: bytesToBase64(bytes) };
    }
    case "move_file": {
      const sourcePath = requireArgumentString(execution.arguments, "sourcePath");
      const destinationPath = requireArgumentString(execution.arguments, "destinationPath");
      await provider.moveFile(sourcePath, destinationPath);
      return { movedFrom: sourcePath, movedTo: destinationPath };
    }
    default:
      throw new Error(`Unsupported host-execution tool "${execution.toolName}".`);
  }
}

/** Build one strict submission for a pending execution (success or failure). */
export async function buildHostExecutionSubmission(
  execution: HostExecutionRequest,
): Promise<AiHostExecutionSubmission> {
  try {
    const result = await executeHostExecution(execution);
    return { executionId: execution.executionId, ok: true, result };
  } catch {
    return {
      executionId: execution.executionId,
      ok: false,
      error: { code: "tools/host-execution-failed", category: "tools" },
    };
  }
}

/**
 * Drive one paused turn to completion: execute every pending host execution
 * locally, submit the results, and repeat while the resumed turn pauses
 * again. Returns the final instruction response, or `null` when there is
 * nothing to drive or this is not the Tauri desktop webview (the caller then
 * keeps the paused conversation state — backend stays authoritative).
 */
export async function driveHostExecutions(
  executions: readonly HostExecutionRequest[],
  conversationId: string,
): Promise<AiInstructionResponse | null> {
  if (executions.length === 0 || !isTauriEnv()) return null;
  let current = executions;
  let final: AiInstructionResponse | null = null;
  for (let i = 0; i < MAX_HOST_EXECUTION_ITERATIONS; i += 1) {
    const submissions: AiHostExecutionSubmission[] = [];
    for (const execution of current) {
      submissions.push(await buildHostExecutionSubmission(execution));
    }
    final = await submitAiInstruction({
      conversationId,
      instruction: RESUME_AFTER_HOST_EXECUTION,
      resumeExecutions: submissions,
    });
    if (final.turn.pendingExecutions.length === 0) return final;
    current = final.turn.pendingExecutions;
  }
  // Bounded stop: still paused after exhausting iterations — surface the last
  // paused response so the caller can present that state and let the user
  // retry.
  return final;
}