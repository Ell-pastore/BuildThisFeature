/**
 * Public entrypoint for the tool subsystem (Phase 9.2).
 *
 * Exposes the registry, the read-only filesystem tool definitions, and
 * the handler dispatch surface. Centralizing the public API here keeps
 * the rest of the backend from reaching into individual modules.
 */
export { ToolRegistry, isToolRegistryError, ToolRegistryErrorCode } from "./registry.js";
export type { ToolRegistryError } from "./registry.js";

export { ToolPermission } from "./types.js";
export type {
  ToolDefinition,
  ToolInputSchema,
  ToolInputSchemaProperty,
} from "./types.js";

export { readToolDefinitions, registerReadTools } from "./definitions/readTools.js";

export {
  handlers,
  handledToolNames,
  dispatchTool,
} from "./handlers/index.js";
export type {
  RawToolInput,
  ToolExecutionResult,
  ToolFailureResult,
  ToolHandler,
  ToolHandlerContext,
  ToolHandlerFunction,
  ToolSuccessResult,
} from "./handlers/handler.js";

export {
  AllowList,
} from "../services/filesystem/allowList.js";

export {
  FilesystemService,
  FilesystemError,
  FilesystemErrorCode,
  isFilesystemError,
} from "../services/filesystem/filesystemService.js";
export type {
  DirectoryListing,
  FileEntry,
  FileMetadata,
  SearchResult,
} from "../services/filesystem/types.js";
