/**
 * `read_file` tool handler (Phase 9.3 + 9.4).
 *
 * Purpose: Read the raw bytes of a file.
 * Input:   { path: string }
 * Output:  { encoding: "base64"; data: string }
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
  try {
    return await ctx.filesystem.readFile(pathResult.value);
  } catch (error) {
    throw mapExecutorError(error, "Unable to read the file.");
  }
};

