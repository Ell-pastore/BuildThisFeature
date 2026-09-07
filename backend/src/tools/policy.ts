/**
 * Tool Permission / Policy layer (Phase 9.5).
 *
 * Sits between the Tool Registry and the Tool Handler:
 *
 *   Tool Registry   (Phase 9.1, provider-agnostic storage)
 *        ↓
 *   Policy          (THIS MODULE: reads tool.permission + ToolExecutionContext)
 *        ↓
 *   Tool Handler    (Phase 9.3, validates input, dispatches to executor)
 *        ↓
 *   Filesystem Exec (Phase 9.3, bridge to Tauri/Rust/AllowList)
 *
 * The policy is a PURE function: it reads the tool's existing permission
 * metadata and the per-call `ToolExecutionContext`, and returns a
 * `PolicyDecision`. It performs no I/O and depends on no AI provider,
 * no LLM, no HTTP, no Tauri runtime.
 *
 * The Phase 9.5 default policy is intentionally minimal:
 *
 *   - The execution context MUST be present and identify an AI-agent
 *     actor. A missing context, an unknown actor kind, or a non-actor
 *     field is a `security` failure (we cannot reason about a request
 *     whose identity we do not know).
 *   - The tool's `permission` MUST be `Read` for Phase 9.5. Write and
 *     destructive tools are not yet implemented; they are denied
 *     explicitly so the policy is the single source of "is this allowed?"
 *     truth, not the handler.
 *
 * Future phases can add additional policies (per-user ACLs, time-bound
 * grants, etc.) by composing `ToolPolicy` functions. The default
 * policy stays the same — a tool that is denied by the default is
 * denied; a tool that passes may still be denied by an additional
 * policy.
 */
import { ToolError, ToolErrorCode, type ToolErrorCategory } from "./errors.js";
import { ToolPermission, type ToolDefinition } from "./types.js";

/**
 * Who is making the tool call.
 *
 * Phase 9.5 supports exactly one actor kind: `ai-agent`. The actor kind
 * is intentionally a closed union so adding a new kind (e.g. `user`,
 * `system`) is a type-level change reviewed in code review, not a
 * silent runtime fallthrough.
 *
 * Future phases may extend this to include a per-user identity. The
 * Phase 9.5 design is a discriminated union so adding a richer actor
 * shape later does not break callers that pattern-match exhaustively.
 */
export type ToolActor =
  | { kind: "ai-agent" }
  | { kind: "user" };

/**
 * Per-call execution context the policy reads. This is distinct from
 * `ToolHandlerContext` (the handler's per-call context, which carries
 * the FilesystemExecutor) — the policy needs identity / actor
 * information; the handler needs its execution dependencies.
 *
 * The context is required to be present at dispatch time. A missing
 * or `null` context is itself a policy failure: the dispatcher must
 * always be able to identify the caller.
 */
export interface ToolExecutionContext {
  /**
   * Who is making the call. Required. A `null` or `undefined` actor is
   * a policy failure (the dispatcher cannot reason about an unknown
   * caller).
   */
  actor: ToolActor;
}

/**
 * The policy's verdict. Either the call is allowed, or it is denied
 * with a structured `ToolError`. The error carries a `category` so
 * callers can branch without parsing strings.
 *
 * `PolicyDecision` is intentionally a tagged union rather than a
 * throw — the policy is a pure decision function, not an effect
 * runner. Throwing would force every caller to wrap the call in a
 * try/catch; returning a verdict is the natural shape.
 */
export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: ToolError };

/**
 * The policy function. Pure: same `(definition, context)` ⇒ same
 * decision. A policy performs no I/O.
 *
 * A `ToolPolicy` is intentionally `(definition, context) => decision`
 * — it does NOT take the input or the handler. A policy that depends
 * on the input is a per-handler check, not a tool-level policy; the
 * Phase 9.5 design keeps the two concerns separate.
 */
export type ToolPolicy = (
  definition: ToolDefinition,
  context: ToolExecutionContext,
) => PolicyDecision;


/**
 * Default Phase 9.5 policy. See the module header for the rules.
 *
 * - Reject any missing/malformed context as a `security` failure with
 *   code `tools/policy-context-missing`. A dispatcher that calls
 *   without a context is itself a programming bug, but the policy
 *   treats it as a security failure rather than letting execution
 *   proceed with a half-formed identity.
 * - Reject any actor whose `kind` is not `ai-agent`. Today the
 *   only allowed kind is `ai-agent`; user-driven tools are out of
 *   scope and must not be added without an explicit policy change.
 * - Reject any tool whose `permission` is not `Read`.
 *
 * The function is exported as a factory so it can be composed with
 * additional policies in the future (e.g. per-tool allowlists,
 * rate limits, time-bound grants).
 */
export function defaultToolPolicy(): ToolPolicy {
  return function policy(definition, context) {
    // 1. Context must exist and carry an actor.
    if (!context || !context.actor || typeof context.actor.kind !== "string") {
      return deny(
        "security",
        ToolErrorCode.PolicyContextMissing,
        "Tool execution requires a valid execution context.",
      );
    }

    // 2. Only the AI-agent actor is allowed to invoke tools in Phase 9.5.
    //    User-driven tools will be added in a later phase with its own
    //    policy rule; the explicit `else if` here is intentional —
    //    adding a new actor kind is a code change reviewed in review.
    if (context.actor.kind !== "ai-agent") {
      return deny(
        "security",
        ToolErrorCode.PermissionDenied,
        `The actor "${context.actor.kind}" is not permitted to invoke tools.`,
      );
    }

    // 3. Only read tools exist in Phase 9.5. Write and destructive
    //    tools are not yet wired; deny them explicitly so a future
    //    tool author who registers a write tool gets a clear
    //    "permission denied" instead of a silent success.
    if (definition.permission !== ToolPermission.Read) {
      return deny(
        "security",
        ToolErrorCode.PermissionDenied,
        `Tool "${definition.name}" has permission "${definition.permission}" which is not enabled.`,
      );
    }

    return { allowed: true };
  };
}

/**
 * Convenience: enforce a policy against a tool definition. Returns
 * `null` if the policy allows the call, or a `ToolError` if the policy
 * denies it. The dispatcher (or any other caller) uses this to wire
 * the policy into the standard tool execution flow without repeating
 * the `if (!decision.allowed) return { ok: false, error: ... }`
 * boilerplate at every site.
 *
 * `policy` defaults to the Phase 9.5 default policy. Callers can
 * pass a custom policy for tests or for future composition.
 */
export function enforcePolicy(
  definition: ToolDefinition,
  context: ToolExecutionContext | null | undefined,
  policy: ToolPolicy = defaultToolPolicy(),
): ToolError | null {
  // A `null`/`undefined` context is itself a policy failure (we
  // cannot reason about an unknown caller). Synthesize the same
  // "missing context" error the default policy would emit.
  if (context === null || context === undefined) {
    return new ToolError(
      "security",
      ToolErrorCode.PolicyContextMissing,
      "Tool execution requires a valid execution context.",
    );
  }
  const decision = policy(definition, context);
  return decision.allowed ? null : decision.reason;
}

/**
 * Build a structured `PolicyDecision` denial. Internal helper that
 * centralizes the `category`, `code`, `message` triple so the policy
 * and its tests speak the same shape.
 */
function deny(
  category: ToolErrorCategory,
  code: string,
  message: string,
): PolicyDecision {
  // The policy emits a ToolError directly with the right category,
  // so the dispatcher can pass it through unchanged.
  return {
    allowed: false,
    reason: new ToolError(category, code, message),
  };
}

