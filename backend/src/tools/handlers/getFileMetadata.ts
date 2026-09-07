/**
 * `get_file_metadata` tool handler (Phase 9.3 + 9.4).
 *
 * Purpose: Retrieve metadata for a single file or directory without
 *          reading its contents.
 * Input:   { path: string }
 * Output:  FileMetadata (Tauri shape)
 *
 * The handler validates its UNTRUSTED input, then delegates entirely
 * to the injected `FilesystemExecutor`. The Rust `AllowList` authorizes
 * the path; this handler adds nothing to the security boundary.
 *
 * Phase 9.4: executor errors are mapped to categorized `ToolError`s.
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
} from "./handler.js";
import { mapExecutorError } from "./executorErrors.js";
import type { FileMetadata } from "../tauriShapes.js";

export const getFileMetadataHandler: ToolHandlerFunction<FileMetadata> =
  async (input, ctx) => {
    const pathResult = requireString(input, "path");
    if (!pathResult.ok) throw pathResult.error;
    try {
      return await ctx.filesystem.getFileMetadata(pathResult.value);
    } catch (error) {
      throw mapExecutorError(error, "Unable to read file metadata.");
    }
  };

