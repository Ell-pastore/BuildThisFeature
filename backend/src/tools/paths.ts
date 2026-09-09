/**
 * Tool path validation — permitted filesystem scope (Phase 10.35).
 *
 * The AI must never coerce a tool into touching a path outside the app's
 * allowed scope. Scope membership is FINAL authority of the desktop's Rust
 * `AllowList` (canonical-path containment against the home directory), but
 * this module is the tool layer's deterministic first gate: it stops clearly
 * invalid or traversal-escaped paths BEFORE any executor call.
 *
 * Rules enforced here (all shape-only, never I/O):
 *
 *   - the path must be ABSOLUTE (POSIX `/`, a Windows drive `X:\`, or a UNC
 *     server share). A relative path is ambiguous and unusable by the
 *     canonical-scope executor — it is rejected as invalid input;
 *   - the path must not contain NUL or control characters;
 *   - the path must not ESCAPE the root: any `..` segment that would climb
 *     above the root is rejected as out of scope (category `security`).
 *     Paths like `/a/../b` that stay within the root are accepted.
 *
 * The guard returns the ORIGINAL string unchanged on success — the executor /
 * Rust layer still canonicalizes and re-verifies actual scope membership.
 * Nothing here reads, writes, normalizes-on-disk, or resolves symlinks.
 *
 * Messages never include the raw path: raw OS paths must not leak into
 * public error text.
 */
import { ToolError, ToolErrorCode } from "./errors.js";

/** True for an absolute path on POSIX, Windows drive letters, or UNC. */
export function isAbsoluteToolPath(path: string): boolean {
  if (path.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  if (path.startsWith("\\\\")) return true;
  return false;
}

function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** True when a `..` segment anywhere in the path climbs ABOVE the root. */
export function escapesToolScope(path: string): boolean {
  const parts = isWindowsAbsolute(path) ? path.split(/[\\/]+/) : path.split("/");

  // Index of the first segment AFTER the path's root marker(s):
  //   - POSIX `/a/b`      → ["", "a", "b"]                  → start 1 (skip "" root)
  //   - drive `C:\a\b`    → ["C:", "a", "b"]                → start 1 (skip "C:")
  //   - UNC `\\s\sh\a`    → ["", "", "s", "sh", "a"]        → start 4 (skip "", "", server, share)
  const start = isWindowsAbsolute(path)
    ? path.startsWith("\\\\")
      ? 4
      : 1
    : 1;

  let depth = 0;
  for (let i = start; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === undefined || part === "" || part === ".") continue;
    if (part === "..") {
      if (depth === 0) return true;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return false;
}

export type PathValidation =
  | { ok: true; path: string }
  | { ok: false; error: ToolError };

/**
 * Deterministic first gate for a tool-provided directory/file path. Rejects
 * relative, control-character, and root-escaping paths as typed `ToolError`s
 * — `validation` / `tools/invalid-path` for unusable input, `security` /
 * `tools/path-out-of-scope` for traversal. On success the original string is
 * passed through unmodified for the canonical scope check to re-verify.
 */
export function validateToolPath(path: string): PathValidation {
  if (!isAbsoluteToolPath(path)) {
    return {
      ok: false,
      error: ToolError.validation(
        ToolErrorCode.InvalidPath,
        "The path must be absolute.",
      ),
    };
  }
  for (let i = 0; i < path.length; i += 1) {
    const char = path.charCodeAt(i);
    if (char < 0x20) {
      return {
        ok: false,
        error: ToolError.validation(
          ToolErrorCode.InvalidPath,
          "The path contains an invalid character.",
        ),
      };
    }
  }
  if (escapesToolScope(path)) {
    return {
      ok: false,
      error: ToolError.security(
        ToolErrorCode.PathOutOfScope,
        "The path escapes the permitted filesystem scope.",
      ),
    };
  }
  return { ok: true, path };
}