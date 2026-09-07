/**
 * Tool handler contract (Phase 9.2).
 *
 * A tool handler is the function that runs when a registered tool is
 * invoked. The contract intentionally has no knowledge of:
 *   - any particular AI provider,
 *   - any particular LLM, prompt, or message,
 *   - any HTTP or IPC transport.
 *
 * A handler:
 *   1. Receives an UNTRUSTED input object (keys/values/types all
 *      unverified — the AI may pass anything).
 *   2. Validates the input against the tool's `inputSchema` (shape
 *      only — the registry does not own validation; handlers do).
 *   3. Calls the application service.
 *   4. Returns a structured result or throws a structured error.
 *
 * Handlers never access the filesystem directly. They go through the
 * `FilesystemService`, which is gated by the AllowList.
 */
import { AppError } from "../../core/errors.js";
import type { FilesystemService } from "../../services/filesystem/filesystemService.js";
import { FilesystemError } from "../../services/filesystem/filesystemService.js";
import type { ToolDefinition } from "../types.js";

/**
 * The untrusted input bag from a tool invocation. A handler must never
 * trust a key or value type until it has validated it.
 */
export type RawToolInput = Record<string, unknown>;

/**
 * Per-invocation context handed to handlers. Carries the
 * already-constructed dependencies so handlers stay pure / easy to test.
 */
export interface ToolHandlerContext {
  filesystem: FilesystemService;
}

/**
 * A successful tool execution. The shape is intentionally minimal —
 * downstream code (HTTP routes, the future AI agent) projects it into
 * whatever wire format is appropriate.
 */
export interface ToolSuccessResult<T = unknown> {
  ok: true;
  data: T;
}

/**
 * A failed tool execution. The error is a stable, machine-readable
 * `AppError` so it can be projected into the same JSON envelope used by
 * every other API endpoint. Internal filesystem errors are mapped to
 * public-safe `AppError`s.
 */
export interface ToolFailureResult {
  ok: false;
  error: AppError;
}

export type ToolExecutionResult<T = unknown> =
  | ToolSuccessResult<T>
  | ToolFailureResult;

export class ToolHandlerError extends AppError {
  constructor(code: string, message: string, status = 400) {
    super(status, code, message);
    this.name = "ToolHandlerError";
  }
}

/**
 * The core function a handler runs. Throws on failure; the wrapper
 * `runHandler` converts thrown errors into structured `ToolExecutionResult`s.
 * Pure: same input ⇒ same output (modulo service state).
 */
export type ToolHandlerFunction<T = unknown> = (
  input: RawToolInput,
  context: ToolHandlerContext,
) => Promise<T> | T;

/**
 * A registered handler — the wrapper that produces a structured result.
 * This is what gets stored in the handler map.
 */
export type ToolHandler<T = unknown> = (
  input: RawToolInput,
  context: ToolHandlerContext,
) => Promise<ToolExecutionResult<T>>;

/** Convert any thrown error from the application services into a public AppError. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof FilesystemError) {
    return mapFilesystemError(error);
  }
  if (error instanceof Error) {
    // Anything unexpected: log + generic 500. Never leak the message.
    console.error("[tools] unexpected handler error:", error);
    return new AppError(500, "internal/error", "Internal server error.");
  }
  return new AppError(500, "internal/error", "Internal server error.");
}

function mapFilesystemError(error: FilesystemError): AppError {
  // Map our internal filesystem codes to public AppError shapes. Keep the
  // codes so clients can still branch, but the messages are public-safe.
  switch (error.code) {
    case "filesystem/not-found":
      return new AppError(404, "filesystem/not-found", error.message);
    case "filesystem/permission-denied":
      return new AppError(403, "filesystem/permission-denied", error.message);
    case "filesystem/not-a-directory":
      return new AppError(400, "filesystem/not-a-directory", error.message);
    case "filesystem/not-a-file":
      return new AppError(400, "filesystem/not-a-file", error.message);
    case "filesystem/invalid-path":
      return new AppError(400, "filesystem/invalid-path", error.message);
    case "filesystem/not-allowed":
      // Crucially: not-allowed (allowlist denied) becomes a 403, NOT a 404,
      // so the security boundary remains observable in logs. The public
      // message is generic; internal logs can carry more detail.
      return new AppError(403, "filesystem/not-allowed", error.message);
    case "filesystem/io-error":
    default:
      return new AppError(500, "filesystem/io-error", error.message);
  }
}

/** Convenience: run a handler function and return a structured result. */
export async function runHandler<T>(
  handler: ToolHandlerFunction<T>,
  input: RawToolInput,
  context: ToolHandlerContext,
): Promise<ToolExecutionResult<T>> {
  try {
    const data = await handler(input, context);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: toAppError(error) };
  }
}

/**
 * Tiny validation helper: read a string property from the untrusted input
 * and reject anything that is not a non-empty string. The path is the most
 * common input — making this a single, consistent check is what stops a
 * hostile caller from slipping an object or array into a `path` field.
 */
export function requireString(
  input: RawToolInput,
  field: string,
): { ok: true; value: string } | { ok: false; error: ToolHandlerError } {
  const value = input[field];
  if (typeof value !== "string") {
    return {
      ok: false,
      error: new ToolHandlerError(
        "tools/invalid-input",
        `Field "${field}" must be a string.`,
      ),
    };
  }
  if (value.length === 0) {
    return {
      ok: false,
      error: new ToolHandlerError(
        "tools/invalid-input",
        `Field "${field}" must not be empty.`,
      ),
    };
  }
  return { ok: true, value };
}

/** Re-export the ToolDefinition for handlers that want to attach to one. */
export type { ToolDefinition };
