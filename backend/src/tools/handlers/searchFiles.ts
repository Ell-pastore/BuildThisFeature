/**
 * `search_files` tool handler (Phase 9.3 + 9.4).
 *
 * Purpose: Recursively search filenames by substring (case-insensitive).
 * Input:   { query: string }
 * Output:  FileEntry[] (Tauri shape)
 *
 * The handler validates its UNTRUSTED input, then delegates entirely
 * to the injected `FilesystemExecutor`. The Rust `AllowList` gates the
 * walk; the handler does not duplicate any search logic.
 *
 * Phase 9.4: executor errors are mapped to categorized `ToolError`s.
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
} from "./handler.js";
import { mapExecutorError } from "./executorErrors.js";
import type { FileEntry } from "../tauriShapes.js";

export const searchFilesHandler: ToolHandlerFunction<FileEntry[]> = async (
  input,
  ctx,
) => {
  const queryResult = requireString(input, "query");
  if (!queryResult.ok) throw queryResult.error;
  try {
    return await ctx.filesystem.searchFiles(queryResult.value);
  } catch (error) {
    throw mapExecutorError(error, "Unable to search files.");
  }
};

