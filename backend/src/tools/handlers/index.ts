/**
 * Tool handler registry (Phase 9.2).
 *
 * Maps each registered tool's name to its handler function. A single
 * dispatch function turns a (tool, input, context) triple into a structured
 * result.
 */
import { AppError } from "../../core/errors.js";
import { ToolRegistry, isToolRegistryError } from "../registry.js";
import type { ToolExecutionResult, ToolHandlerContext } from "./handler.js";
import { runHandler, type RawToolInput, type ToolHandler } from "./handler.js";

import { getFileMetadataHandler } from "./getFileMetadata.js";
import { listDirectoryHandler } from "./listDirectory.js";
import { readFileHandler } from "./readFile.js";
import { searchFilesHandler } from "./searchFiles.js";

import type { DirectoryListing } from "../../services/filesystem/types.js";
import type { FileMetadata } from "../../services/filesystem/types.js";
import type { SearchResult } from "../../services/filesystem/types.js";

/** Output shape for read_file (must stay in sync with readFile.ts). */
interface ReadFileOutput {
  encoding: "base64";
  data: string;
}

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
    runHandler(searchFilesHandler, input, ctx)) as ToolHandler<SearchResult[]>,
  get_file_metadata: ((input, ctx) =>
    runHandler(getFileMetadataHandler, input, ctx)) as ToolHandler<FileMetadata>,
  read_file: ((input, ctx) =>
    runHandler(readFileHandler, input, ctx)) as ToolHandler<ReadFileOutput>,
});

/** Names of tools that have a registered handler. */
export const handledToolNames: readonly string[] = Object.freeze(
  Object.keys(handlers),
);

/**
 * Dispatch a tool call. Looks the tool up in the registry (proving it is
 * a known, registered tool) then runs the matching handler. Unknown tools
 * return an `ok: false` result — dispatch is expected to fail predictably
 * for caller-supplied tool names.
 *
 * The returned error is always a public `AppError` suitable for projecting
 * into an HTTP response.
 */
export async function dispatchTool(
  registry: ToolRegistry,
  toolName: string,
  input: RawToolInput,
  context: ToolHandlerContext,
): Promise<ToolExecutionResult> {
  // Gate 1: prove the tool is registered before running any handler.
  try {
    registry.get(toolName);
  } catch (error) {
    if (isToolRegistryError(error)) {
      // Map the registry error to a public-safe AppError. The status is
      // 400 (malformed request — caller asked for a non-existent tool)
      // and the code is the registry's own stable code so clients can
      // branch on it.
      const status = error.code === "tools/unknown-tool" ? 400 : 409;
      return {
        ok: false,
        error: new AppError(
          status,
          error.code,
          "The requested tool is not available.",
        ),
      };
    }
    throw error;
  }

  // Gate 2: the registry has the tool — look up the handler.
  // The cast widens the exact-keys object to a string-key lookup so the
  // runtime gate (`!handler`) still produces a precise error path.
  const handler = (handlers as unknown as Record<string, ToolHandler | undefined>)[
    toolName
  ];
  if (!handler) {
    // Registry claim + no handler = wiring bug (not a user error).
    return {
      ok: false,
      error: new AppError(
        500,
        "tools/handler-missing",
        "The requested tool has no registered handler.",
      ),
    };
  }

  return runHandler(handler, input, context);
}

