/**
 * `copy_file` tool handler (Phase 11.6).
 *
 * Purpose: Copy a file INTO an existing destination directory, keeping its
 *          original name. Write operation — always approval-gated.
 * Input:   { sourcePath: string, destDirPath: string }
 * Output:  { copiedFrom: string, copiedTo: string }
 *
 * Important: COPY is directory-shaped, NOT exact-path-shaped. The Rust
 * `copy_item` keeps the source's file name (it copies into `dest_dir`); the
 * destination item is `destDirPath + basename(sourcePath)`. Unlike MOVE, no
 * renamed copy is possible — a COPY plan keeps the source name.
 *
 * The SAME validation function is used twice, mirroring `move_file`:
 *   1. in the approval gate's per-tool PREFLIGHT, before an approval
 *      record is even created, and
 *   2. at EXECUTION time, before the executor runs, so arguments that were
 *      validated days ago are re-validated against the current filesystem.
 *
 * `validateCopyFileInput` is read-only: it inspects metadata only and never
 * mutates the filesystem, so re-running it is always safe. It rejects
 * malformed input, non-absolute or scope-escaping paths, missing or folder
 * sources, missing or non-folder destinations, a self-copy (the destination
 * would resolve to the source), and existing destinations — the last four can
 * change between approval and execution, which is why execution re-runs it.
 *
 * Phase 11.6 spec: no shell, no OS commands, no new filesystem primitive —
 * the only mutation is `FilesystemExecutor.copyFile`, which delegates to the
 * Rust `copy_item` command (AllowList-authoritative).
 */
import {
  requireString,
  type ToolHandlerContext,
  type ToolHandlerFunction,
  type RawToolInput,
} from "./handler.js";
import { mapExecutorError } from "./executorErrors.js";
import { validateToolPath } from "../paths.js";
import { ToolError, ToolErrorCode } from "../errors.js";
import type { FilesystemExecutor } from "../executor.js";

export interface CopyFileArguments {
  sourcePath: string;
  destDirPath: string;
}

export interface CopyFileResult {
  copiedFrom: string;
  copiedTo: string;
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]+/);
  return parts[parts.length - 1] ?? "";
}

function joinPathFolder(folder: string, name: string): string {
  if (folder.endsWith("/") || folder.endsWith("\\")) return folder + name;
  const sep = folder.includes("\\") ? "\\" : "/";
  return folder + sep + name;
}

/**
 * Deep, read-only validation shared by the approval preflight and the
 * execution path. Throws a categorized `ToolError` on any problem:
 *
 *   - malformed input                         → validation / tools/invalid-input
 *   - relative / control-char / escaping path → validation|security / tools/*
 *   - source missing                          → not_found / filesystem/not-found
 *   - source is a folder                      → validation / filesystem/not-a-file
 *   - destination directory missing           → not_found / filesystem/not-found
 *   - destination directory not a folder      → validation / filesystem/not-a-directory
 *   - destination item already exists         → validation / filesystem/already-exists
 *   - destination resolves to the source      → validation / tools/invalid-input
 *   - any step outside permitted scope        → security / filesystem/not-allowed
 *
 * Returns the validated absolute path pair on success. The destination item
 * (`destDirPath` + basename of the source) is NOT an input — the copy keeps
 * the source name, so it is always derived.
 */
export async function validateCopyFileInput(
  input: RawToolInput,
  filesystem: FilesystemExecutor,
): Promise<CopyFileArguments> {
  const sourceResult = requireString(input, "sourcePath");
  if (!sourceResult.ok) throw sourceResult.error;
  const destDirResult = requireString(input, "destDirPath");
  if (!destDirResult.ok) throw destDirResult.error;

  const { sourcePath, destDirPath } = {
    sourcePath: sourceResult.value,
    destDirPath: destDirResult.value,
  };

  const sourceCheck = validateToolPath(sourcePath);
  if (!sourceCheck.ok) throw sourceCheck.error;
  const destDirCheck = validateToolPath(destDirPath);
  if (!destDirCheck.ok) throw destDirCheck.error;

  // 1. The source must exist and be a file.
  const sourceMetadata = await filesystem
    .getFileMetadata(sourcePath)
    .catch((error: unknown) => {
      throw mapExecutorError(error, "The file or folder no longer exists.");
    });
  if (!sourceMetadata.isFile) {
    throw ToolError.validation(
      ToolErrorCode.FilesystemNotAFile,
      "The source is not a file.",
    );
  }

  // 2. The destination directory must exist and be a folder.
  const destDirMetadata = await filesystem
    .getFileMetadata(destDirPath)
    .catch((error: unknown) => {
      const mapped = mapExecutorError(
        error,
        "The destination folder does not exist.",
      );
      if (mapped.category === "not_found") {
        throw ToolError.notFound(
          ToolErrorCode.FilesystemNotFound,
          "The destination folder does not exist.",
        );
      }
      throw mapped;
    });
  if (!destDirMetadata.isFolder) {
    throw ToolError.validation(
      ToolErrorCode.FilesystemNotADirectory,
      "The destination is not a folder.",
    );
  }

  // 3. The copy keeps the source name — derive the destination item and
  //    reject a self-copy (the copy would read and write the same entry).
  const destinationPath = joinPathFolder(destDirPath, basenameOf(sourcePath));
  if (destinationPath === sourcePath) {
    throw ToolError.validation(
      ToolErrorCode.InvalidInput,
      "The destination path must differ from the source path.",
    );
  }

  // 4. The destination item must NOT already exist — a copy never overwrites.
  let destinationMetadata: Awaited<
    ReturnType<FilesystemExecutor["getFileMetadata"]>
  > | null = null;
  try {
    destinationMetadata = await filesystem.getFileMetadata(destinationPath);
  } catch (error) {
    const mapped = mapExecutorError(error, "Tool execution failed.");
    if (mapped.category !== "not_found") throw mapped;
  }
  if (destinationMetadata !== null) {
    throw ToolError.validation(
      ToolErrorCode.FilesystemAlreadyExists,
      "A file or folder with that name already exists.",
    );
  }

  return { sourcePath, destDirPath };
}

/**
 * Execute the copy after the caller's own validation succeeded. The full
 * re-validation happens inside `validateCopyFileInput` at execution time;
 * this wrapper performs only the actual (authorized) mutation and shapes the
 * executor errors that can still race into the window between validation
 * and copy (permission revoked, destination appeared, source vanished).
 */
export const copyFileHandler: ToolHandlerFunction<CopyFileResult> = async (
  input,
  ctx,
) => {
  const paths = await validateCopyFileInput(input, ctx.filesystem);
  try {
    await ctx.filesystem.copyFile(paths.sourcePath, paths.destDirPath);
  } catch (error) {
    throw mapExecutorError(error, "Unable to copy the file.");
  }
  return {
    copiedFrom: paths.sourcePath,
    copiedTo: joinPathFolder(paths.destDirPath, basenameOf(paths.sourcePath)),
  };
};

export type { ToolHandlerContext };