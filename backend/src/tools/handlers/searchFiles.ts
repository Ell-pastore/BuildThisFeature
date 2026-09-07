/**
 * `search_files` tool handler (Phase 9.2).
 *
 * Purpose: Recursively search filenames by substring (case-insensitive).
 * Input:   { query: string }
 * Output:  SearchResult[]
 *
 * Security: delegates entirely to FilesystemService, which gates the
 * walk through the AllowList. Symlink escapes are prevented by
 * canonicalization at every step.
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
} from "./handler.js";
import type { SearchResult } from "../../services/filesystem/types.js";

/** Validate input and dispatch to the filesystem service. */
export const searchFilesHandler: ToolHandlerFunction<SearchResult[]> = async (
  input,
  ctx,
) => {
  const queryResult = requireString(input, "query");
  if (!queryResult.ok) throw queryResult.error;

  const results = await ctx.filesystem.searchFiles(queryResult.value);
  return results;
};
