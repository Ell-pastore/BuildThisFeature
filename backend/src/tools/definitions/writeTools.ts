/**
 * Write tool definitions (Phase 10.36).
 *
 * Each definition is a pure metadata object: name, description, inputSchema,
 * permission, and — critically for Phase 10.36 — `requiresApproval`. Write
 * tools mutate the filesystem, so they are approval-gated at the definition,
 * not by any handler. No execution logic lives here.
 *
 * These definitions are wired into a `ToolRegistry` by `registerWriteTools`.
 */
import { ToolPermission, type ToolDefinition } from "../types.js";

const moveFileDefinition: ToolDefinition = {
  name: "move_file",
  description:
    "Move a file to an exact destination path. The destination may keep the file's original name (a plain move) or introduce a new name (a move that also renames). Both paths must be absolute and within the permitted scope. The source must be an existing file — folders are not moved, and files cannot be overwritten. The destination folder must already exist. These preconditions (source existence, destination-folder existence, no overwrite, scope) are validated at execution time and returned as errors if they fail, so they need not be checked with other tools first. This operation changes the filesystem and therefore requires explicit user approval before it executes.",
  inputSchema: {
    type: "object",
    properties: {
      sourcePath: {
        type: "string",
        description:
          "Absolute path of the existing file to move. Must be within an allowed scope.",
      },
      destinationPath: {
        type: "string",
        description:
          "Absolute full path the file should have after the move (including the file name). Must be within an allowed scope; its parent folder must already exist.",
      },
    },
    required: ["sourcePath", "destinationPath"],
  },
  permission: ToolPermission.Write,
  requiresApproval: true,
};

const copyFileDefinition: ToolDefinition = {
  name: "copy_file",
  description:
    "Copy a file into an existing destination DIRECTORY, keeping the file's original name. The source must be an existing file and the destination directory must already exist — the copy never introduces a new name and a same-named file in the destination is never overwritten. Both paths must be absolute and within the permitted scope. These preconditions (source existence, destination-directory existence, no overwrite, scope) are validated at execution time and returned as errors if they fail, so they need not be checked with other tools first. This operation changes the filesystem and therefore requires explicit user approval before it executes.",
  inputSchema: {
    type: "object",
    properties: {
      sourcePath: {
        type: "string",
        description:
          "Absolute path of the existing file to copy. Must be within an allowed scope.",
      },
      destDirPath: {
        type: "string",
        description:
          "Absolute path of the existing directory the file is copied into, KEEPING its original name. Must be within an allowed scope; it must already exist as a folder.",
      },
    },
    required: ["sourcePath", "destDirPath"],
  },
  permission: ToolPermission.Write,
  requiresApproval: true,
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const writeToolDefinitions: readonly ToolDefinition[] = Object.freeze([
  moveFileDefinition,
  copyFileDefinition,
]);

/**
 * Register all write tools into the given registry. Throws
 * `ToolRegistryError` if a tool is already registered.
 */
export function registerWriteTools(
  registry: { register: (tool: ToolDefinition) => void },
): void {
  for (const tool of writeToolDefinitions) {
    registry.register(tool);
  }
}