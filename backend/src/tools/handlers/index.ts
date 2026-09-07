/**
 * Tool handler registry + dispatch (Phase 9.3 + 9.4 + 9.5).
 *
 * The map and the dispatch function form the bridge's outward surface:
 * given a registered tool name and an untrusted input, the dispatch
 * function:
 *
 *   1. Verifies the tool is registered (registry gate, Phase 9.1).
 *   2. Enforces the permission/policy gate (Phase 9.5). Denied tools
 *      never reach the handler.
 *   3. Validates the input against the tool's schema (handler).
 *   4. Delegates to the FilesystemExecutor (the bridge to the desktop).
 *   5. Projects any failure into a `ToolError` with an explicit category
 *      (Phase 9.4 execution contract).
 *
 * The dispatch surface is provider-independent. The default
 * `FilesystemExecutor` is the Tauri/Rust bridge, but any other
 * implementation (e.g. a future CloudFilesystemExecutor) can be
 * substituted without changing this code.
 */
import { ToolRegistry, isToolRegistryError } from "../registry.js";
import type {
  DirectoryListing,
  FileEntry,
  FileMetadata,
} from "../tauriShapes.js";
import { ToolError, ToolErrorCode } from "../errors.js";
import {
  defaultToolPolicy,
  enforcePolicy,
  type ToolExecutionContext,
  type ToolPolicy,
} from "../policy.js";
import {
  runHandler,
  type RawToolInput,
  type ToolExecutionResult,
  type ToolHandler,
  type ToolHandlerContext,
} from "./handler.js";

import { getFileMetadataHandler } from "./getFileMetadata.js";
import { listDirectoryHandler } from "./listDirectory.js";
import { readFileHandler } from "./readFile.js";
import { searchFilesHandler } from "./searchFiles.js";

/**
 * Map of tool name → handler. Typed as an object literal (not a Record)
 * so the keys are known at compile time — the dispatch function and
 * consumers can rely on `handlers[name]` being exactly the right type
 * for each tool.
 */
export const handlers = Object.freeze({
  list_directory: ((input, ctx) =>
    runHandler(listDirectoryHandler, input, ctx)) as ToolHandler<DirectoryListing>,
  search_files: ((input, ctx) =>
    runHandler(searchFilesHandler, input, ctx)) as ToolHandler<FileEntry[]>,
  get_file_metadata: ((input, ctx) =>
    runHandler(getFileMetadataHandler, input, ctx)) as ToolHandler<FileMetadata>,
  read_file: ((input, ctx) =>
    runHandler(readFileHandler, input, ctx)) as ToolHandler<{
    encoding: "base64";
    data: string;
  }>,
});

/** Names of tools that have a registered handler. */
export const handledToolNames: readonly string[] = Object.freeze(
  Object.keys(handlers),
);

/**
 * Dispatch a tool call. Looks the tool up in the registry (proving it is
 * a known, registered tool), runs the permission/policy gate, then runs
 * the matching handler. Unknown tools return an `ok: false` result;
 * denied tools return an `ok: false` result with `category: "security"`.
 *
 * The returned `error` (when `ok` is false) is always a public
 * `ToolError` with an explicit `category`. Every code path through
 * dispatch terminates with a categorized error:
 *
 *   - "unknown_tool"  — registry has no such tool
 *   - "security"      — policy denied the call (or context is missing)
 *   - "internal"      — registry has the tool but no handler is wired
 *   - any category the handler's own throws produce (validation, etc.)
 */
export async function dispatchTool(
  registry: ToolRegistry,
  toolName: string,
  input: RawToolInput,
  context: ToolHandlerContext,
  /**
   * The execution context the policy reads. Required for the policy
   * gate; if absent, the dispatch returns a `security` error and the
   * handler is never called.
   */
  executionContext: ToolExecutionContext,
  /**
   * Override policy for tests. Defaults to the Phase 9.5 default
   * policy (`defaultToolPolicy()`). Future phases may compose
   * additional policies here.
   */
  policy: ToolPolicy = defaultToolPolicy(),
): Promise<ToolExecutionResult> {
  // Gate 1: prove the tool is registered before running any policy
  // or handler. A registry miss cannot be authorized by the policy.
  let definition;
  try {
    definition = registry.get(toolName);
  } catch (error) {
    if (isToolRegistryError(error)) {
      // Registry miss: category "unknown_tool" so callers can branch
      // without inspecting the code. The duplicate-tool case (409) is
      // a server-side wiring bug, but we still surface it as a
      // structured error rather than letting it crash dispatch.
      return {
        ok: false,
        error: new ToolError(
          "unknown_tool",
          error.code,
          `The requested tool "${toolName}" is not available.`,
        ),
      };
    }
    // An unexpected non-registry error here is a programming bug.
    return { ok: false, error: ToolError.internal() };
  }

  // Gate 2: the policy. Denied tools NEVER reach the handler. The
  // policy is the only thing that can produce a `security` result
  // before the handler runs; the handler's own `ToolError` throws
  // are passed through unchanged.
  const policyError = enforcePolicy(definition, executionContext, policy);
  if (policyError !== null) {
    return { ok: false, error: policyError };
  }

  // Gate 3: the registry has the tool — look up the handler.
  // The cast widens the exact-keys object to a string-key lookup so
  // the runtime gate (`!handler`) still produces a precise error path.
  const handler = (handlers as unknown as Record<string, ToolHandler | undefined>)[
    toolName
  ];
  if (!handler) {
    // Registry claim + no handler = wiring bug (not a user error).
    return {
      ok: false,
      error: new ToolError(
        "internal",
        ToolErrorCode.HandlerMissing,
        `The requested tool "${toolName}" has no registered handler.`,
      ),
    };
  }

  return handler(input, context);
}

