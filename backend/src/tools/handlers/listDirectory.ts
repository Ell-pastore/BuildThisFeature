/**
 * `list_directory` tool handler (Phase 9.2).
 *
 * Purpose: List the contents of a directory.
 * Input:   { path: string }
 * Output:  DirectoryListing (structure mirrors the Rust fs_service).
 *
 * Security: the tool never accesses the filesystem directly. The
 * FilesystemService gates every path through the AllowList.
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
} from "./handler.js";
import type { DirectoryListing } from "../../services/filesystem/types.js";

/** Validate input and dispatch to the filesystem service. */
export const listDirectoryHandler: ToolHandlerFunction<DirectoryListing> = async (
  input,
  ctx,
) => {
  const pathResult = requireString(input, "path");
  if (!pathResult.ok) throw pathResult.error;

  const listing = await ctx.filesystem.listDirectory(pathResult.value);
  return listing;
};
