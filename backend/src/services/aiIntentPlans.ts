/**
 * AI intent/plan boundary (Phase 11.1).
 *
 * `POST /api/ai/plans` turns a natural-language instruction into a structured
 * `FileIntentPlan` WITHOUT executing anything. The provider is offered exactly
 * one tool — the read-only, zero-side-effect `plan_intent` — and its output is
 * routed through the SAME authenticated `runAgentTurn()` → `routeAgentResponse`
 * → `invokeTool()` pipeline as every other agent turn. The handler is pure:
 * it validates and normalises the model-populated fields into a nested plan,
 * and never touches a filesystem.
 *
 * Design rules:
 *
 *   - NO EXECUTION: the plan registry contains ONLY `plan_intent`. An errant
 *     filesystem-tool call in the plan turn is routed to a registry that does
 *     not have the tool, so it returns `unknown_tool` and never reaches an
 *     executor. The injected filesystem defaults to the fail-closed
 *     `hostDelegatedFilesystemExecutor()`.
 *   - NO APPROVALS: `plan_intent` is ungated (`permission: Read`, no
 *     `requiresApproval`), so no `ai_tool_approvals` row is ever written and
 *     `move_file`'s own approval/execution path is untouched.
 *   - STRICT BODY: only `instruction` is accepted; unknown fields (including
 *     any user id) are rejected — identity comes exclusively from the session.
 *   - SINGLE BOUNDED TURN: one `runAgentTurn`, no loop. `requiresApproval` and
 *     `supported` are computed deterministically by the handler, never
 *     supplied by the model.
 *   - DETERMINISTIC OUTCOMES: a well-formed plan returns `{ plan }`; a
 *     text-only provider reply returns `{ plan: null, finalText }`; a
 *     malformed `plan_intent` call is rejected with 400 before anything else
 *     runs.
 *   - ERROR MAPPING: `AppError` passthrough; provider failures → 503
 *     `ai/provider-unavailable`; unexpected errors propagate unchanged so the
 *     HTTP layer's generic `internal/error` envelope hides internals.
 */
import { AppError } from "../core/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  planToolDefinitions,
  registerPlanTools,
} from "../tools/definitions/planTools.js";
import {
  hostDelegatedFilesystemExecutor,
  type FilesystemExecutor,
} from "../tools/executor.js";
import { createSessionExecutionContext } from "../tools/sessionContext.js";
import {
  runAgentTurn,
  isProviderError,
  type AgentProvider,
  type AgentTurnOutput,
} from "./provider.js";
import type { FileIntentPlan } from "../tools/handlers/planIntent.js";
import { composeDefaultProviderStack } from "./providerComposition.js";

// ---------------------------------------------------------------------------
// Validation constants (auth-service convention)
// ---------------------------------------------------------------------------

/** Reasonable server-side cap on a planning instruction / prompt. */
export const MAX_PLAN_INSTRUCTION_LENGTH = 4096;

/** Strict body shape: nothing outside `instruction` is accepted. */
const PLAN_BODY_FIELDS = new Set(["instruction"]);

// ---------------------------------------------------------------------------
// Typed request / response
// ---------------------------------------------------------------------------

/** The ONLY field accepted in `POST /api/ai/plans`. */
export interface AiIntentPlanBody {
  /** The authenticated user's instruction to plan (required). */
  instruction: string;
}

/**
 * The stable response for `POST /api/ai/plans`. Either the provider produced
 * a well-formed plan through `plan_intent` (`plan` is set), or it replied with
 * text only (`plan` is `null` and `finalText` carries the reply).
 */
export interface AiIntentPlanResponse {
  /** The normalised structured plan; `null` when the provider made no plan. */
  plan: FileIntentPlan | null;
  /** The provider's textual reply, when a plan was not produced. */
  finalText?: string;
}

// ---------------------------------------------------------------------------
// Strict body validation
// ---------------------------------------------------------------------------

/**
 * Parse and strictly validate the plan request body. Rejects missing/empty/
 * whitespace-only/oversized instructions, a non-object body, and ANY
 * unexpected field (a body-supplied user id is rejected — identity comes from
 * the session, never the body).
 *
 * @throws `AppError.badRequest` (400) on any violation.
 */
export function parseAiIntentPlanInput(raw: unknown): AiIntentPlanBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw AppError.badRequest("Request body must be a JSON object.");
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PLAN_BODY_FIELDS.has(key)) {
      throw AppError.badRequest(`Unexpected field "${key}" in request body.`);
    }
  }

  const instructionRaw = record.instruction;
  if (typeof instructionRaw !== "string") {
    throw AppError.badRequest("Instruction must be a string.");
  }
  const instruction = instructionRaw.trim();
  if (instruction.length === 0) {
    throw AppError.badRequest("Instruction must not be empty.");
  }
  if (instruction.length > MAX_PLAN_INSTRUCTION_LENGTH) {
    throw AppError.badRequest(
      `Instruction must be at most ${MAX_PLAN_INSTRUCTION_LENGTH} characters long.`,
    );
  }

  return { instruction };
}

// ---------------------------------------------------------------------------
// Plan extraction
// ---------------------------------------------------------------------------

/**
 * Find the provider's `plan_intent` outcome in the single-turn results. The
 * FIRST `plan_intent` call is authoritative: a successful call exposes the
 * nested plan; a rejected call (malformed fields) is a client-format problem
 * and becomes a 400. A successful plan is trusted because it was produced by
 * the pure validation handler — the model output never reaches this function.
 *
 * @returns `"plan"` with the nested plan, `"badRequest"` with the safe error,
 *          or `null` when the provider made no `plan_intent` call.
 */
function extractPlan(
  output: AgentTurnOutput,
):
  | { kind: "plan"; plan: FileIntentPlan }
  | { kind: "badRequest"; error: AppError }
  | null {
  for (const result of output.results) {
    if (result.toolName !== "plan_intent") continue;
    if (result.ok) {
      return { kind: "plan", plan: result.data as FileIntentPlan };
    }
    // Error messages from the validation handler are safe by construction.
    return {
      kind: "badRequest",
      error: AppError.badRequest(result.error.message),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Run one bounded planning turn against an explicit provider. The provider is
 * authenticated first (fail-closed: no provider call without a valid session),
 * offered ONLY the `plan_intent` tool, routed through the unchanged
 * `runAgentTurn()` → `invokeTool()` pipeline via a plan-only registry, and
 * served a fail-closed filesystem.
 */
export async function runAiIntentPlanWithProvider(
  provider: AgentProvider,
  c: { get: (key: string) => unknown },
  raw: unknown,
  options?: { filesystem?: FilesystemExecutor },
): Promise<AiIntentPlanResponse> {
  const input = parseAiIntentPlanInput(raw);

  // Fail closed before spending a provider call: without a valid
  // authenticated ToolExecutionContext, even a text-only turn is rejected.
  createSessionExecutionContext(c);

  const registry = new ToolRegistry();
  registerPlanTools(registry);
  const filesystem = options?.filesystem ?? hostDelegatedFilesystemExecutor();

  const output = await runAgentTurn(
    c,
    provider,
    { message: input.instruction, tools: planToolDefinitions },
    { registry, filesystem },
  );

  const found = extractPlan(output);
  if (found !== null) {
    if (found.kind === "badRequest") throw found.error;
    return { plan: found.plan };
  }
  return { plan: null, ...(output.text !== undefined ? { finalText: output.text } : {}) };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map KNOWN plan failures to safe, typed `AppError`s.
 *
 *   - `AppError`    → passthrough (already safe + enveloped).
 *   - `ProviderError` → 503 `ai/provider-unavailable`, provider-agnostic
 *     message.
 *   - anything else → returned UNCHANGED so the HTTP layer's generic
 *     `internal/error` envelope (no stack, no message) protects internals.
 */
export function mapAiIntentPlanError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (isProviderError(error)) {
    console.error(
      `[ai] plan provider failure (${error.code}) mapped to 503 ai/provider-unavailable: ${error.message}`,
    );
    return new AppError(
      503,
      "ai/provider-unavailable",
      "The AI provider is temporarily unavailable. Please try again later.",
    );
  }
  return error;
}

// ---------------------------------------------------------------------------
// Provider seam (production binding)
// ---------------------------------------------------------------------------

let boundPlanner: AgentProvider | undefined;

/**
 * Bind the LONG-LIVED planner provider used by the plan route. The production
 * composition binds the SAME composed stack's provider as the instruction
 * runtime so fallback/rotation/cooldown state is shared across surfaces. Pass
 * `undefined` to clear (for tests).
 */
export function bindAiIntentPlanner(provider: AgentProvider | undefined): void {
  boundPlanner = provider;
}

function resolveAiIntentPlanner(): AgentProvider {
  if (boundPlanner !== undefined) return boundPlanner;
  let provider: AgentProvider;
  try {
    provider = composeDefaultProviderStack().provider;
  } catch (error) {
    // Provider composition failure (e.g. no credentials configured) surfaces
    // as a safe, generic "not configured" rather than a raw config error.
    throw AppError.notConfigured("The AI provider");
  }
  boundPlanner = provider;
  return provider;
}

/**
 * Production entry point used by the route: resolves the bound (or lazily
 * default) planner provider, then runs one planning turn through it.
 */
export async function runAiIntentPlan(
  c: { get: (key: string) => unknown },
  raw: unknown,
): Promise<AiIntentPlanResponse> {
  try {
    return await runAiIntentPlanWithProvider(resolveAiIntentPlanner(), c, raw);
  } catch (error) {
    throw mapAiIntentPlanError(error);
  }
}