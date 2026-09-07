/**
 * `get_file_metadata` tool handler (Phase 9.3).
 *
 * Purpose: Retrieve metadata for a single file or directory without
 *          reading its contents.
 * Input:   { path: string }
 * Output:  FileMetadata (Tauri shape)
 *
 * The handler validates its UNTRUSTED input, then delegates entirely
 * to the injected `FilesystemExecutor`. The Rust `AllowList` authorizes
 * the path; this handler adds nothing to the security boundary.
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
} from "./handler.js";
import type { FileMetadata } from "../tauriShapes.js";

export const getFileMetadataHandler: ToolHandlerFunction<FileMetadata> =
  async (input, ctx) => {
    const pathResult = requireString(input, "path");
    if (!pathResult.ok) throw pathResult.error;
    return ctx.filesystem.getFileMetadata(pathResult.value);
  };

