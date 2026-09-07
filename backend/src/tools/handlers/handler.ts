/**
 * Tool handler contract (Phase 9.3).
 *
 * The contract intentionally has no knowledge of:
 *   - any particular AI provider,
 *   - any particular LLM, prompt, or message,
 *   - any HTTP or IPC transport.
 *
 * A handler:
 *   1. Receives an UNTRUSTED input object (keys/values/types all
 *      unverified — the AI may pass anything).
 *   2. Validates the input against the tool's `inputSchema` (shape
 *      only — the registry does not own validation; handlers do).
 *   3. Calls the FilesystemExecutor (the bridge to the desktop).
 *   4. Returns a structured result or throws a structured error.
 *
 * Handlers never access the filesystem directly. They go through the
 * `FilesystemExecutor`, which delegates to Tauri → Rust → AllowList.
 */
import { AppError } from "../../core/errors.js";
import type { FilesystemExecutor } from "../executor.js";
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
  filesystem: FilesystemExecutor;
}

/** A successful tool execution. */
export interface ToolSuccessResult<T = unknown> {
  ok: true;
  data: T;
}

/** A failed tool execution. The error is a public `AppError`. */
export interface ToolFailureResult {
  ok: false;
  error: AppError;
}

export type ToolExecutionResult<T = unknown> =
  | ToolSuccessResult<T>
  | ToolFailureResult;

/**
 * The core function a handler runs. Throws on failure; the wrapper
 * `runHandler` converts thrown errors into structured `ToolExecutionResult`s.
 * Pure: same input ⇒ same output (modulo executor state).
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

/**
 * Convert any thrown error from the executor into a public AppError.
 *
 * The executor throws on failure with whatever message the desktop
 * returned (a Rust `Err(String)` or an `Error` from the Tauri IPC layer).
 * We project each call's specific failure modes into stable codes so
 * the rest of the system can branch without parsing human messages.
 *
 * Codes here are the SAME shape the rest of the API uses
 * ("<area>/<reason>"). Internal errors that contain stack traces or
 * filesystem paths are not exposed.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    const message = error.message || "Tool execution failed.";
    // The desktop's Rust service returns user-safe English strings on
    // failure. We map the most common ones to stable codes; everything
    // else is a 500 with a generic message.
    const lower = message.toLowerCase();
    if (lower.includes("permission denied")) {
      return new AppError(403, "filesystem/permission-denied", message);
    }
    if (lower.includes("does not exist") || lower.includes("no longer exists")) {
      return new AppError(404, "filesystem/not-found", message);
    }
    if (lower.includes("not a folder") || lower.includes("not a directory")) {
      return new AppError(400, "filesystem/not-a-directory", message);
    }
    if (lower.includes("is a folder") || lower.includes("not a file")) {
      return new AppError(400, "filesystem/not-a-file", message);
    }
    if (lower.includes("access") && lower.includes("not permitted")) {
      return new AppError(403, "filesystem/not-allowed", message);
    }
    // Unknown internal error: do not leak the raw message.
    return new AppError(500, "internal/error", "Tool execution failed.");
  }
  return new AppError(500, "internal/error", "Tool execution failed.");
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
): { ok: true; value: string } | { ok: false; error: AppError } {
  const value = input[field];
  if (typeof value !== "string") {
    return {
      ok: false,
      error: AppError.badRequest(`Field "${field}" must be a string.`),
    };
  }
  if (value.length === 0) {
    return {
      ok: false,
      error: AppError.badRequest(`Field "${field}" must not be empty.`),
    };
  }
  return { ok: true, value };
}

/** Re-export the ToolDefinition for handlers that want to attach to one. */
export type { ToolDefinition };

