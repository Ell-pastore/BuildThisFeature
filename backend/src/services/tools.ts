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
  /**
   * Optional persistent-turn provenance (Phase 10.28C-prep). A bounded
   * persistent turn eagerly commits its conversation and the round's
   * assistant/tool-call message BEFORE the round's intents execute, then
   * threads the two REAL persisted ids here so `invokeTool` can bind them
   * to the `ToolExecutionContext` at the invocation boundary. Absent for
   * direct / non-persistent invocations — behavior is unchanged.
   */
  turnContext?: AgentTurnContext;
}

/**
 * The authenticated, PERSISTED conversation/message context a tool call
 * belongs to. Produced only by the persistent-turn layer from committed
 * repository rows — these ids are never supplied by provider output or
 * by the untrusted tool input.
 */
export interface AgentTurnContext {
  /** Persisted owning conversation id (UUID, repository-assigned). */
  conversationId: string;
  /** Persisted assistant/tool-call message id owning the current round. */
  messageId: string;
}

/**
 * Invoke a registered tool for the authenticated session user.
 *
 * Throws `AppError.unauthorized()` when no session identity is present;
 * otherwise every outcome is returned as a structured
 * `ToolExecutionResult` (never thrown).
 *
 * When `options.turnContext` is present (persistent agent turns only), the
 * authenticated, persisted conversation + message ids are bound to the
 * `ToolExecutionContext` so the future approval stage has real ids at the
 * invocation boundary. Identity still comes exclusively from the session.
 */
export async function invokeTool(
  c: { get: (key: string) => unknown },
  toolName: string,
  input: RawToolInput,
  options: InvokeToolOptions,
): Promise<ToolExecutionResult> {
  const executionContext = createSessionExecutionContext(c, options.turnContext);
  return dispatchTool(
    options.registry,
    toolName,
    input,
    { filesystem: options.filesystem },
    executionContext,
    options.policy,
  );
}