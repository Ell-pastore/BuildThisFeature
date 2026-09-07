/**
 * Executor error → ToolError mapping (Phase 9.4).
 *
 * The desktop's Rust `fs_service` returns user-safe English strings on
 * failure over the Tauri IPC channel. The executor throws those as
 * plain `Error`s. Handlers convert them into categorized `ToolError`s
 * here so the dispatch surface (and any future HTTP route) can branch
 * on `category` without parsing the message.
 *
 * The mapping is deliberately explicit and per-operation. Each handler
 * knows the failure modes of its own operation, so the categories live
 * in the handler — not in a global substring matcher.
 *
 * `INTERNAL` is the safe default: when a thrown message does not match
 * any known shape, the handler must NOT surface it to the public.
 * The returned `ToolError` is a public-safe `internal`.
 */
import {
  ToolError,
  ToolErrorCode,
  type ToolErrorCategory,
} from "../errors.js";

/** A single recognized shape: substring → category. */
interface Shape {
  category: ToolErrorCategory;
  code: string;
  match: (lower: string) => boolean;
}

const SHAPES: readonly Shape[] = [
  {
    category: "security",
    code: ToolErrorCode.FilesystemPermissionDenied,
    match: (l) => l.includes("permission denied"),
  },
  {
    category: "security",
    code: ToolErrorCode.FilesystemNotAllowed,
    match: (l) => l.includes("access") && l.includes("not permitted"),
  },
  {
    category: "not_found",
    code: ToolErrorCode.FilesystemNotFound,
    match: (l) =>
      l.includes("does not exist") || l.includes("no longer exists"),
  },
  {
    category: "validation",
    code: "filesystem/not-a-directory",
    match: (l) => l.includes("not a folder") || l.includes("not a directory"),
  },
  {
    category: "validation",
    code: "filesystem/not-a-file",
    match: (l) => l.includes("is a folder") || l.includes("not a file"),
  },
];

/**
 * Map a thrown executor error to a `ToolError`. If no shape matches,
 * returns a public-safe `internal` error — the raw message is NEVER
 * surfaced.
 *
 * If the thrown value is already a `ToolError`, it is returned
 * unchanged (so handlers that explicitly categorize executor errors
 * upstream are honored).
 */
export function mapExecutorError(
  error: unknown,
  fallbackMessage = "Tool execution failed.",
): ToolError {
  if (error instanceof ToolError) return error;
  if (!(error instanceof Error)) {
    return ToolError.internal(fallbackMessage);
  }
  const lower = error.message.toLowerCase();
  for (const shape of SHAPES) {
    if (shape.match(lower)) {
      return new ToolError(shape.category, shape.code, error.message);
    }
  }
  return ToolError.internal(fallbackMessage);
}

