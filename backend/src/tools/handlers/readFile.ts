/**
 * `read_file` tool handler (Phase 9.2).
 *
 * Purpose: Read the raw bytes of a file.
 * Input:   { path: string }
 * Output:  { encoding: "base64"; data: string }
 *
 * The output is JSON-compatible (base64-encoded) so it can travel over any
 * wire protocol. Callers decode with `Buffer.from(data, "base64")`.
 *
 * Security: the tool never accesses the filesystem directly. The
 * FilesystemService gates every path through the AllowList and enforces
 * a 64 MiB size cap.
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
} from "./handler.js";

interface ReadFileOutput {
  encoding: "base64";
  data: string;
}

/** Validate input and dispatch to the filesystem service. */
export const readFileHandler: ToolHandlerFunction<ReadFileOutput> = async (
  input,
  ctx,
) => {
  const pathResult = requireString(input, "path");
  if (!pathResult.ok) throw pathResult.error;

  const buffer = await ctx.filesystem.readFile(pathResult.value);
  return { encoding: "base64", data: buffer.toString("base64") };
};

