/**
 * Public surface of the filesystem layer.
 *
 * The application layer imports ONLY from this module: the
 * `FilesystemProvider` abstraction plus a provider instance. Today the active
 * provider is always the desktop one (Tauri → Rust → OS filesystem). A future
 * `CloudFilesystemProvider` (HTTP API → backend) can take over behind this
 * same accessor without any UI or application-layer changes.
 */
import { DesktopFilesystemProvider } from "./desktop";
import type { FilesystemProvider } from "./provider";

export type { DirListing, DiskUsage, FilesystemProvider } from "./provider";

let activeProvider: FilesystemProvider | null = null;

/** Return the active filesystem provider, creating it on first use. */
export function getFilesystemProvider(): FilesystemProvider {
  if (!activeProvider) {
    activeProvider = new DesktopFilesystemProvider();
  }
  return activeProvider;
}