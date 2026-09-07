/**
 * Tool invocation service (Phase 9.8).
 *
 * The application/API entry point for invoking a registered tool. Given
 * an authenticated request (a Hono context that has been through
 * `requireAuth`), a tool name, and the untrusted input, it:
 *
 *   1. Obtains the identity from the authenticated session.
 *   2. Creates the `ToolExecutionContext`.
 *   3. Dispatches through the existing Tool Registry + policy pipeline.
 *   4. Returns the existing structured `ToolExecutionResult` / `ToolError`.
 *
 * Flow:
 *
 *   Authenticated request
 *   → createSessionExecutionContext(c)   (Phase 9.7)
 *   → dispatchTool(registry, name, input, { filesystem }, context)
 *   → policy → handler → executor
 *
 * Trust model: the identity is read from the session established by
 * `requireAuth` (via `createSessionExecutionContext`). The `input` is
 * untrusted and never influences identity; request-supplied identity
 * fields are ignored.
 *
 * No AI/LLM/provider, no new tools, no write/destructive operations,
 * and no new auth/context/policy system. The registry and
 * FilesystemExecutor are injected so the service is testable without
 * Tauri and so any future executor wiring can be substituted here.
 */
import { createSessionExecutionContext } from "../tools/sessionContext.js";
import { dispatchTool } from "../tools/handlers/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { FilesystemExecutor } from "../tools/executor.js";
import type { RawToolInput, ToolExecutionResult } from "../tools/handlers/handler.js";
import type { ToolPolicy } from "../tools/policy.js";

/** Dependencies the invocation service needs to run pipeline stages. */
export interface InvokeToolOptions {
  /** The injected Tool Registry (Phase 9.1). Never bypassed. */
  registry: ToolRegistry;
  /** The injected FilesystemExecutor — the bridge to Tauri/Rust. */
  filesystem: FilesystemExecutor;
  /**
   * Optional policy override, mirroring `dispatchTool`. Defaults to the
   * Phase 9.5 default policy.
   */
  policy?: ToolPolicy;
}

/**
 * Invoke a registered tool for the authenticated session user.
 *
 * Throws `AppError.unauthorized()` when no session identity is present;
 * otherwise every outcome is returned as a structured
 * `ToolExecutionResult` (never thrown).
 */
export async function invokeTool(
  c: { get: (key: string) => unknown },
  toolName: string,
  input: RawToolInput,
  options: InvokeToolOptions,
): Promise<ToolExecutionResult> {
  const executionContext = createSessionExecutionContext(c);
  return dispatchTool(
    options.registry,
    toolName,
    input,
    { filesystem: options.filesystem },
    executionContext,
    options.policy,
  );
}