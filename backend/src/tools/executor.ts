/**
 * FilesystemExecutor — the bridge between the Tool Registry and the
 * desktop's Tauri/Rust filesystem layer (Phase 9.3).
 *
 * Design rule: the backend NEVER reads or writes the host filesystem
 * directly. Every filesystem action is delegated to an injected executor,
 * which is owned and produced outside this module. In production the
 * default `tauriFilesystemExecutor()` talks to the Tauri webview's
 * `invoke()` call (the same channel the web app already uses through
 * `DesktopFilesystemProvider`). In tests, a `FakeFilesystemExecutor`
 * stands in — no Tauri, no LLM, no Node `fs`.
 *
 * The interface is intentionally minimal: it lists the four read-only
 * operations the Phase 9.2 tool definitions describe, plus the single
 * approval-gated write operation `moveFile` added in Phase 10.36. Write
 * and destructive operations are deliberately absent beyond that; they
 * belong to later phases and will be added here (and only here) when
 * they arrive.
 *
 * Every method throws on failure. The error shape is the caller's
 * concern; handlers project these into public `AppError`s.
 */
import type {
  DirectoryListing,
  FileEntry,
  FileMetadata,
} from "./tauriShapes.js";

/**
 * The single seam the rest of the tool layer is allowed to call.
 *
 * Implementations MUST:
 *   - delegate to the desktop's Tauri/Rust filesystem service (or a
 *     stand-in during tests);
 *   - let the Rust `AllowList` authorize every operation;
 *   - preserve the existing security rules; nothing here is a shortcut.
 */
export interface FilesystemExecutor {
  listDirectory(path: string): Promise<DirectoryListing>;
  searchFiles(query: string): Promise<FileEntry[]>;
  getFileMetadata(path: string): Promise<FileMetadata>;
  /**
   * Read a file's raw bytes. The bridge does not decode or interpret the
   * payload — that is the caller's job. Returns a base64 string so the
   * payload is JSON-safe for any wire format (HTTP, IPC, queue, log).
   */
  readFile(path: string): Promise<{ encoding: "base64"; data: string }>;
  /**
   * Move a file to an exact destination path (optionally renaming it).
   * The Rust `move_file` command rejects folders, missing sources,
   * missing destination folders, existing destinations, and any path
   * outside the configured `AllowList`. Resolves to nothing on success.
   */
  moveFile(source: string, destinationPath: string): Promise<void>;
  /**
   * Copy a file INTO an existing destination directory, keeping its original
   * name. The Rust `copy_item` command rejects folders, missing sources,
   * missing/non-folder destination directories, an existing destination item,
   * and any path outside the configured `AllowList`. Resolves to nothing on
   * success. Note the contract difference from `moveFile`: the destination is
   * a DIRECTORY, never an exact path — the copy keeps the source's name.
   */
  copyFile(source: string, destDirPath: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default implementation: Tauri IPC
// ---------------------------------------------------------------------------

/**
 * A minimal, structural typing of the Tauri `invoke` function. Defined
 * here (not imported from `@tauri-apps/api/core`) so the backend stays
 * buildable in environments that do not have Tauri installed.
 */
export type TauriInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/**
 * The default executor — proxies every call to a Tauri command in the
 * running desktop webview, which delegates in turn to the Rust
 * `fs_service` (the single source of truth for local filesystem access).
 *
 * The injected `invoke` is typed structurally so the production binding
 * (`@tauri-apps/api/core::invoke`) and any test double are both accepted.
 */
export function tauriFilesystemExecutor(
  invoke: TauriInvoke,
): FilesystemExecutor {
  return {
    listDirectory(path) {
      return invoke<DirectoryListing>("list_directory", { path });
    },
    searchFiles(query) {
      return invoke<FileEntry[]>("search_files", { query });
    },
    getFileMetadata(path) {
      return invoke<FileMetadata>("get_file_metadata", { path });
    },
    readFile(path) {
      // The Rust command returns `Vec<u8>`. Tauri serializes it as a
      // number[] over the wire; the bridge re-encodes to base64 so the
      // tool result is a single, JSON-safe string.
      return invoke<number[]>("read_file", { path }).then((bytes) => ({
        encoding: "base64" as const,
        data: Buffer.from(bytes).toString("base64"),
      }));
    },
    moveFile(source, destinationPath) {
      return invoke<void>("move_file", {
        source,
        destination: destinationPath,
      });
    },
    copyFile(source, destDirPath) {
      return invoke<void>("copy_item", {
        source,
        destDir: destDirPath,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Host-delegated executor (Phase 10.39)
// ---------------------------------------------------------------------------

/**
 * Thrown by every method of a `HostDelegatedFilesystemExecutor`. When THIS
 * process has no real access to the host filesystem (the executor is
 * host-delegated), the tool layer must defer: it records a scoped
 * host-execution request and the DESKTOP HOST executes locally. A method on
 * the delegated executor is never the execution path — reaching one means a
 * code path forgot to route through the Phase 10.39 host-execution gate.
 */
export class HostExecutionDeferredError extends Error {
  readonly code = "tools/host-execution-required";
  constructor() {
    super(
      "This filesystem operation is delegated to the desktop host; it cannot run inside the backend process.",
    );
    this.name = "HostExecutionDeferredError";
  }
}

/**
 * A `FilesystemExecutor` whose every operation is host-delegated. Carrying a
 * `kind: "host-delegated"` discriminator lets the invocation service detect
 * that ungated tool calls in THIS process must be recorded for the desktop
 * host instead of executed. Never construct this directly — use
 * `hostDelegatedFilesystemExecutor()`.
 */
export interface HostDelegatedFilesystemExecutor extends FilesystemExecutor {
  readonly kind: "host-delegated";
}

/** Narrow an executor to the host-delegated variant. */
export function isHostDelegatedFilesystemExecutor(
  filesystem: FilesystemExecutor,
): filesystem is HostDelegatedFilesystemExecutor {
  return (
    typeof filesystem === "object" &&
    filesystem !== null &&
    (filesystem as { kind?: unknown }).kind === "host-delegated"
  );
}

/**
 * The fail-closed host-delegated executor. Every method throws a
 * `HostExecutionDeferredError` — execution on the host is recorded by the
 * Phase 10.39 gate in the invocation service, never performed here. Write
 * operations reaching this executor (via the approval EXECUTE path) fail
 * closed with a security error, exactly as they do when no Tauri host is
 * available.
 */
export function hostDelegatedFilesystemExecutor(): HostDelegatedFilesystemExecutor {
  const deferred = (): Promise<never> => Promise.reject(new HostExecutionDeferredError());
  return {
    kind: "host-delegated",
    listDirectory: deferred,
    searchFiles: deferred,
    getFileMetadata: deferred,
    readFile: deferred,
    moveFile: deferred,
    copyFile: deferred,
  };
}

