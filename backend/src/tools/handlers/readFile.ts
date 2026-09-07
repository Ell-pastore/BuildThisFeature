/**
 * `read_file` tool handler (Phase 9.3).
 *
 * Purpose: Read the raw bytes of a file.
 * Input:   { path: string }
 * Output:  { encoding: "base64"; data: string }
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

interface ReadFileOutput {
  encoding: "base64";
  data: string;
}

export const readFileHandler: ToolHandlerFunction<ReadFileOutput> = async (
  input,
  ctx,
) => {
  const pathResult = requireString(input, "path");
  if (!pathResult.ok) throw pathResult.error;
  return ctx.filesystem.readFile(pathResult.value);
};

