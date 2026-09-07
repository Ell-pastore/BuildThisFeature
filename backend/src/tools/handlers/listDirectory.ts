/**
 * `list_directory` tool handler (Phase 9.3).
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
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
} from "./handler.js";
import type { DirectoryListing } from "../tauriShapes.js";

export const listDirectoryHandler: ToolHandlerFunction<DirectoryListing> =
  async (input, ctx) => {
    const pathResult = requireString(input, "path");
    if (!pathResult.ok) throw pathResult.error;
    return ctx.filesystem.listDirectory(pathResult.value);
  };

