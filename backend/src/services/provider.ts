/**
 * Provider-independent AI boundary (Phase 10.2).
 *
 * The smallest typed abstraction between the agent layer and ANY AI
 * provider. A provider implementation (a future adapter for OpenAI,
 * Gemini, Grok, Anthropic, OpenRouter, Ollama, ...) must satisfy the
 * `AgentProvider` interface:
 *
 *   - it RECEIVES a provider-agnostic request/context (`AgentProviderRequest`):
 *     the user's message plus plain tool metadata;
 *   - it RETURNS a provider-agnostic response (`AgentResponse`) containing
 *     text and/or tool-call intents in the EXACT Phase 10.1 `AgentToolCall`
 *     shape;
 *   - it reports failures through the typed `ProviderError` contract.
 *
 * Flow:
 *
 *   user message + tool metadata
 *   → provider.generate()                     (ANY provider; no coupling here)
 *   → AgentResponse { text?, toolCalls? }
 *   → routeAgentResponse / runAgentTurn        (agent layer — the ONLY callers)
 *   → runAgentRequest() → invokeTool()         (Phase 10.1 / 9.8 — authenticated)
 *   → dispatchTool (registry → policy → handler → executor)
 *
 * Design rules:
 *
 *   - PROVIDER-INDEPENDENT: no OpenAI/Gemini/Grok/Anthropic vocab, no API
 *     keys, no env vars, no network calls in this module. Providers are
 *     swapped behind the same interface.
 *   - TOOLS ARE NEVER EXECUTED BY THE PROVIDER: the boundary only returns
 *     intents. Execution belongs exclusively to the agent layer via
 *     `runAgentRequest()` / `invokeTool()` — policy and registry are never
 *     bypassed.
 *   - PROVIDER OUTPUT IS NOT TRUSTED: intents returned by `generate()` are
 *     re-validated through `parseAgentRequest` before they are routed.
 */
import type { ToolDefinition } from "../tools/types.js";
import { AppError } from "../core/errors.js";
import type { AgentToolCall, AgentToolResult } from "./agent.js";
import { parseAgentRequest, runAgentRequest } from "./agent.js";
import type {
  HostExecutionRequestInfo,
  InvokeToolOptions,
  ToolApprovalRequestInfo,
} from "./tools.js";

/**
 * The provider-agnostic context a provider receives to produce a reply.
 *
 * `tools` is plain metadata (name / description / input schema) — it does
 * NOT grant the provider any execution capability. The provider can only
 * name tools in its response; the agent layer decides whether to run them.
 */
export interface AgentProviderRequest {
  /** The user's goal / prompt. */
  message: string;
  /** Provider-agnostic metadata for the tools the agent may call. */
  tools: readonly ToolDefinition[];
  /**
   * Structured results of tool calls executed in previous rounds of a
   * bounded tool loop, in execution order. Present from the second
   * provider turn onward; omitted on the first turn. Used only as
   * context — the provider has no execution capability of its own.
   */
  toolResults?: AgentToolResult[];
  /**
   * Prior-conversation transcript (context continuity). An ordered list of
   * the turns already completed on a RESUMED conversation: user
   * instructions, assistant replies, and any assistant tool calls paired
   * with their structured results. Omitted on fresh single-turn requests;
   * when present, providers prepend it AFTER the system message and BEFORE
   * the current `message`. Additive and provider-neutral.
   */
  history?: readonly AgentHistoryMessage[];
}

/**
 * One prior turn of a resumed conversation, provider-agnostically. A user
 * instruction carries `text`; an assistant tool round carries `toolCalls`
 * (paired with the round's `toolResults`); an assistant reply carries
 * `text`. Exactly what the bounded loop persists per message row, so it is
 * reconstructible verbatim from stored conversation data.
 */
export interface AgentHistoryMessage {
  /** The speaker of this prior turn. */
  role: "user" | "assistant";
  /** Text content: the user's instruction or an assistant reply. */
  text?: string;
  /** Tool-call intents from a prior assistant round (with `toolResults`). */
  toolCalls?: readonly AgentToolCall[];
  /** Structured results of the round's tool calls, in execution order. */
  toolResults?: readonly AgentToolResult[];
}

/**
 * A provider-independent response. A provider returns free-form `text`
 * and/or `toolCalls`. Both fields are optional; a text-only turn needs
 * no tool execution and a tool-only turn produces no prose.
 */
export interface AgentResponse {
  /** Free-form textual reply. Optional when tool calls are returned. */
  text?: string;
  /**
   * Tool-call intents in the Phase 10.1 `AgentToolCall` shape. These are
   * routed by the agent layer — never executed by the provider.
   */
  toolCalls?: AgentToolCall[];
}

/**
 * Hard per-result budget for tool results serialized into provider
 * conversation context (system prompt, history, and in-turn tool messages).
 *
 * A single `read_file` result can carry the ENTIRE contents of a file as
 * base64; embedding arbitrarily large results verbatim lets a request exceed
 * a provider's context window ("context_length_exceeded" → permanent
 * `InvalidResponse` in most adapters). To keep prompts bounded, any
 * serialized result longer than this constant is replaced by a fixed-shape,
 * short JSON envelope that keeps the truncation metadata and a real content
 * preview — never the unbounded payload.
 */
export const MAX_PROVIDER_TOOL_RESULT_CHARS = 8000;

/**
 * Length of the genuine content preview embedded in a truncated tool result.
 * Kept far below `MAX_PROVIDER_TOOL_RESULT_CHARS` so the whole envelope stays
 * comfortably bounded while still giving the model evidence the tool ran and
 * what it returned.
 */
const TRUNCATION_PREVIEW_CHARS = 600;

/**
 * The SINGLE shared system instruction every AI provider adapter sends.
 *
 * One constant instead of five per-adapter duplicates, so Groq, Gemini,
 * OpenRouter, Grok, and Ollama are all governed by the same behavior
 * contract. It preserves the original safety rules (never invent paths,
 * never fabricate tool results, discover genuinely unknown references,
 * only ask when ambiguous) and adds the minimality rules that stop the
 * agent from re-verifying information it already has:
 *
 *   - absolute filesystem paths the USER supplies verbatim are
 *     authoritative input and must be used directly — no "verify the
 *     user's own path" rediscovery with search/list/metadata tools;
 *   - before calling a tool, use what the conversation and earlier tool
 *     results already contain; do not repeat available information;
 *   - use the fewest tool calls necessary; no redundant discovery or
 *     verification;
 *   - the execution layer (policy → handler → executor → Tauri/Rust)
 *     validates inputs and enforces approval + allowlist gates locally, so
 *     execute directly when the arguments are known and use any returned
 *     error to decide the next action rather than re-validating up front;
 *   - never bypass approval requirements or filesystem allowlists, and
 *     never claim an operation succeeded that the tools did not confirm.
 */
export const AGENT_SYSTEM_INSTRUCTION =
  "You are an assistant that helps the user manage files. You may call " +
  "the provided tools to inspect and change the filesystem, but you never " +
  "execute tools yourself — every call is gated by the application's " +
  "approval, policy, and filesystem-allowlist controls.\n\n" +
  "Understand the request before acting. Use the information already " +
  "present in this conversation — earlier messages and the results of " +
  "tools you have already run — before asking the user or calling a tool.\n\n" +
  "Paths and references:\n" +
  "- Absolute filesystem paths provided verbatim by the user are " +
  "authoritative input. Use them directly; do not call search, list, or " +
  "metadata tools merely to verify a path the user explicitly supplied.\n" +
  "- When a path is not given verbatim, resolve the reference (files or " +
  "folders named earlier, or common named locations like the home or " +
  "Desktop) by discovering the actual path with list_directory, " +
  "search_files, or get_file_metadata. Never invent paths, file names, or " +
  "directory structures that were not returned by a tool, and never " +
  "fabricate tool results.\n" +
  "- Only ask the user for clarification when a reference is genuinely " +
  "ambiguous or cannot be safely discovered.\n\n" +
  "Efficiency:\n" +
  "- Before calling any tool, inspect the current user message and " +
  "previous tool results. Do not repeat information that is already " +
  "available.\n" +
  "- Use the fewest tool calls necessary to complete the assignment. Do " +
  "not perform redundant discovery or verification.\n" +
  "- Tools and the execution layer validate their own inputs (existence, " +
  "scope, allowlist, overwrite safety) and return errors when a condition " +
  "fails. When the required information is already known, execute the " +
  "appropriate operation directly, and use any returned error to decide " +
  "the next action rather than proactively repeating validation.\n" +
  "- Never try to bypass approval requirements or filesystem allowlists, " +
  "and never claim an operation succeeded that the tools did not confirm.";

/**
 * Serialize one structured tool result to the plain string the adapters
 * embed in their wire messages. Locally executed failures carry a real
 * `ToolError` (whose `message` is used); persisted history results may carry
 * a restored plain error object, which is embedded as-is rather than lost.
 *
 * Successful results are bounded: a result whose serialized length fits
 * `MAX_PROVIDER_TOOL_RESULT_CHARS` is passed through EXACTLY as before;
 * anything larger fails closed into a short `{ truncated, reason, maxChars,
 * originalChars, preview }` envelope (preview is real JSON-prefix content,
 * never fabricated) so no provider request ever carries an unbounded tool
 * result.
 */
export function agentToolResultToContent(result: AgentToolResult): string {
  if (!result.ok) {
    const error = result.error as { message?: string };
    return JSON.stringify({
      error: typeof error?.message === "string" && error.message.length > 0 ? error.message : result.error,
    });
  }
  const serialized = JSON.stringify(result.data);
  if (serialized.length <= MAX_PROVIDER_TOOL_RESULT_CHARS) {
    return serialized;
  }
  return JSON.stringify({
    truncated: true,
    reason:
      "Tool result exceeded the provider input budget and was truncated before insertion into model context.",
    maxChars: MAX_PROVIDER_TOOL_RESULT_CHARS,
    originalChars: serialized.length,
    preview: serialized.slice(0, TRUNCATION_PREVIEW_CHARS),
  });
}

/**
 * The typed abstraction every AI provider adapter must implement.
 *
 * Implementations may call whatever external provider they wrap, but the
 * interface itself stays provider-agnostic: request and response carry no
 * provider-specific vocabulary, and failures are reported as `ProviderError`.
 */
export interface AgentProvider {
  generate(request: AgentProviderRequest): Promise<AgentResponse>;
}

/**
 * Stable, machine-readable codes for provider failures. Grouped so a
 * caller can branch without parsing messages. Retryability is carried
 * separately on each `ProviderError` instance.
 */
export const ProviderErrorCode = {
  /** Credentials / authorization rejected by the provider. Not retryable. */
  Authentication: "provider/authentication-failed",
  /** Provider rate-limited us. Transient — retry with backoff. */
  RateLimited: "provider/rate-limited",
  /** Provider did not answer in time. Transient — retry. */
  Timeout: "provider/timeout",
  /** Provider is unavailable / down. Transient — retry. */
  Unavailable: "provider/unavailable",
  /** The provider returned something the adapter could not parse/use. */
  InvalidResponse: "provider/invalid-response",
  /** The request input exceeded the provider's context/token window. A
   *  different provider with a larger context may still succeed, so the
   *  fallback orchestrator treats this as rotate-eligible. */
  ContextLengthExceeded: "provider/context-length-exceeded",
  /** Any other provider-side failure. */
  Internal: "provider/internal",
} as const;

export type ProviderErrorCode = (typeof ProviderErrorCode)[keyof typeof ProviderErrorCode];

/**
 * The typed error contract for provider failures.
 *
 * Distinct from `ToolError` (Phase 9.4, tool execution failures) and from
 * `AppError` (HTTP envelope): this type is what a provider adapter throws
 * when the OUTSIDE provider cannot be reached or misbehaves.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  /**
   * True when a simple retry (with backoff) may succeed: transient
   * failures such as timeouts, rate limits, or unavailability. False for
   * permanent failures such as invalid credentials or malformed output.
   */
  readonly retryable: boolean;

  constructor(code: ProviderErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }

  /** Convenience for transient, retryable failures. */
  static transient(code: ProviderErrorCode, message: string): ProviderError {
    return new ProviderError(code, message, true);
  }

  /** Convenience for permanent, non-retryable failures. */
  static permanent(code: ProviderErrorCode, message: string): ProviderError {
    return new ProviderError(code, message, false);
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** A single agent turn: the user's goal plus the tools the agent may use. */
export interface AgentTurn {
  /** The user's goal / prompt. */
  message: string;
  /** Plain tool metadata available to the provider for tool selection. */
  tools: readonly ToolDefinition[];
}

/**
 * The result of one agent turn: the provider's text (if any) plus the
 * routed per-intent execution results (if any).
 */
export interface AgentTurnOutput {
  /** Textual reply from the provider, when one was returned. */
  text?: string;
  /** Per-intent results of any tool calls the provider requested. */
  results: AgentToolResult[];
}

/**
 * The structured return from `routeAgentResponse`: per-intent execution
 * results plus any pending approval metadata collected during the round.
 * Pending approvals are extracted from `approval_required` outcomes so
 * callers can surface them to the authenticated client without coupling
 * to the internal error shape.
 */
export interface RouteAgentResponseResult {
  /** Per-intent execution results, in request order. */
  readonly results: AgentToolResult[];
  /**
   * Pending approval metadata collected from any `approval_required` results
   * in this round. Empty when no tools required approval.
   */
  readonly pendingApprovals: readonly ToolApprovalRequestInfo[];
  /**
   * Host-execution metadata collected from any `host_execution_required`
   * results in this round (Phase 10.39). The bounded loop PAUSES when this
   * is non-empty.
   */
  readonly pendingExecutions: readonly HostExecutionRequestInfo[];
}

/**
 * Validate a provider response's tool-call intents and route them through
 * the authenticated pipeline (`runAgentRequest()` → `invokeTool()`).
 *
 * This is the routing half of `runAgentTurn()`, split out so the bounded
 * agent loop (Phase 10.4) can reuse the exact same authenticated,
 * policy-gated execution path on every round.
 *
 * - Executes nothing from inside the provider.
 * - Re-validates provider output through `parseAgentRequest`.
 * - Returns an empty results array when the response requested no tools.
 * - Collects pending approval metadata from `approval_required` results
 *   (Phase 10.29) so callers can surface them to the authenticated client.
 *
 * @throws `AppError.badRequest` when the provider returned malformed intents.
 * @throws `AppError.unauthorized()` when `c` has no session identity.
 */
export async function routeAgentResponse(
  c: { get: (key: string) => unknown },
  response: AgentResponse,
  options: InvokeToolOptions,
): Promise<RouteAgentResponseResult> {
  if (!response.toolCalls || response.toolCalls.length === 0) {
    return { results: [], pendingApprovals: [], pendingExecutions: [] };
  }
  const request = parseAgentRequest({ calls: response.toolCalls });
  const agentResult = await runAgentRequest(c, request, options);
  return {
    results: agentResult.results,
    pendingApprovals: agentResult.pendingApprovals,
    pendingExecutions: agentResult.pendingExecutions,
  };
}

/**
 * Run one agent turn: ask the provider for a reply, then route any
 * tool-call intents it returned through the authenticated pipeline.
 *
 * - Executes NOTHING from inside the provider. Tool execution happens
 *   here, in the agent layer, only via `runAgentRequest()` → `invokeTool()`.
 * - Provider output is re-validated through `parseAgentRequest` before
 *   routing: malformed intents are rejected rather than trusted.
 * - Identity comes from the authenticated session (`c`), never from the
 *   provider. Unauthenticated turns throw `AppError.unauthorized()`.
 *
 * @throws `ProviderError` when `generate()` fails with one (propagated).
 * @throws `AppError.badRequest` when the provider returned malformed intents.
 * @throws `AppError.unauthorized()` when `c` has no session identity.
 */
export async function runAgentTurn(
  c: { get: (key: string) => unknown },
  provider: AgentProvider,
  turn: AgentTurn,
  options: InvokeToolOptions,
): Promise<AgentTurnOutput> {
  const response = await provider.generate({
    message: turn.message,
    tools: turn.tools,
  });

  const { results } = await routeAgentResponse(c, response, options);
  return { text: response.text, results };
}
