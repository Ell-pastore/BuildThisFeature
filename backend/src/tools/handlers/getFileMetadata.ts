/**
 * `get_file_metadata` tool handler (Phase 9.2).
 *
 * Purpose: Retrieve metadata about a file or directory without reading contents.
 * Input:   { path: string }
 * Output:  FileMetadata (structure mirrors the Rust fs_service).
 *
 * Security: the tool never accesses the filesystem directly. The
 * FilesystemService gates every path through the AllowList.
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
} from "./handler.js";
import type { FileMetadata } from "../../services/filesystem/types.js";

/** Validate input and dispatch to the filesystem service. */
export const getFileMetadataHandler: ToolHandlerFunction<FileMetadata> = async (
  input,
  ctx,
) => {
  const pathResult = requireString(input, "path");
  if (!pathResult.ok) throw pathResult.error;

  const metadata = await ctx.filesystem.getFileMetadata(pathResult.value);
  return metadata;
};
