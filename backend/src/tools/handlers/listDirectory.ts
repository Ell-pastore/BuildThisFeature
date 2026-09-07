/**
 * `list_directory` tool handler (Phase 9.3 + 9.4).
 *
 * Purpose: List the contents of a directory.
 * Input:   { path: string }
 * Output:  DirectoryListing (Tauri shape, identical to the web app's)
 *
 * The handler validates its UNTRUSTED input, then delegates entirely
 * to the injected `FilesystemExecutor`, which is the bridge to the
 * desktop's Tauri command and, behind that, the Rust `fs_service`. The
 * Rust `AllowList` authorizes the operation; this handler adds nothing
 * to the security boundary.
 *
 * Phase 9.4: executor errors are mapped to categorized `ToolError`s
 * via the shared `mapExecutorError` helper, so the dispatch surface
 * sees a clean `category` for every failure mode.
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
} from "./handler.js";
import { mapExecutorError } from "./executorErrors.js";
import type { DirectoryListing } from "../tauriShapes.js";

export const listDirectoryHandler: ToolHandlerFunction<DirectoryListing> =
  async (input, ctx) => {
    const pathResult = requireString(input, "path");
    if (!pathResult.ok) throw pathResult.error;
    try {
      return await ctx.filesystem.listDirectory(pathResult.value);
    } catch (error) {
      throw mapExecutorError(error, "Unable to list the directory.");
    }
  };

