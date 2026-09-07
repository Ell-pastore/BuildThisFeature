/**
 * `search_files` tool handler (Phase 9.3).
 *
 * Purpose: Recursively search filenames by substring (case-insensitive).
 * Input:   { query: string }
 * Output:  FileEntry[] (Tauri shape)
 *
 * The handler validates its UNTRUSTED input, then delegates entirely
 * to the injected `FilesystemExecutor`. The Rust `AllowList` gates the
 * walk; the handler does not duplicate any search logic.
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
} from "./handler.js";
import type { FileEntry } from "../tauriShapes.js";

export const searchFilesHandler: ToolHandlerFunction<FileEntry[]> = async (
  input,
  ctx,
) => {
  const queryResult = requireString(input, "query");
  if (!queryResult.ok) throw queryResult.error;
  return ctx.filesystem.searchFiles(queryResult.value);
};

