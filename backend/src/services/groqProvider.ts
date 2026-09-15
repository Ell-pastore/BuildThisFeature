/**
 * Groq provider adapter.
 *
 * A production HTTP adapter that sits behind the provider-agnostic
 * `AgentProvider` boundary (`src/services/provider.ts`). It translates the
 * provider-independent request/context into Groq's OpenAI-compatible chat
 * completions shape, POSTs it to `https://api.groq.com/openai/v1/chat/completions`,
 * and maps the response back into `AgentResponse` (`text` and/or
 * `AgentToolCall` intents in the exact Phase 10.1 shape).
 *
 * Design rules (mirroring the boundary's contract):
 *
 *   - SERVER-SIDE ONLY: the Groq API key is read from server configuration
 *     (`config.groq`), which is environment-driven. No key ever reaches the
 *     client, and the adapter performs no authentication of its own.
 *   - TOOLS ARE NEVER EXECUTED HERE: the adapter only describes tools to the
 *     model and returns intents. Execution belongs exclusively to the agent
 *     layer via `runAgentTurn` / `invokeTool` — never here.
 *   - NO Groq BUILT-IN TOOLS: only the registered tools from the request are
 *     offered; browser search / code execution / file-system access are never
 *     enabled.
 *   - ALL OUTPUT IS VALIDATED: every response is runtime-checked before it
 *     becomes an `AgentResponse`. Malformed output is rejected with a
 *     permanent `ProviderError` (never propagated client-side as trust).
 *   - NO RETRIES / NO AUTONOMOUS EXECUTION: transient failures surface as
 *     typed, retryable `ProviderError`s and are left to the caller.
 *
 * Every failure is mapped into the typed `ProviderError` contract:
 *   - HTTP 4xx authentication problems      → Authentication (permanent)
 *   - HTTP 429 rate limiting                → RateLimited (transient)
 *   - other 4xx client errors               → InvalidResponse (permanent)
 *   - network / DNS failures                → Unavailable (transient)
 *   - aborted / timed-out requests          → Timeout (transient)
 *   - 5xx / unexpected HTTP status          → Internal (transient)
 *   - malformed body / tool calls           → InvalidResponse (permanent)
 *
 * `fetch` is injected (from `globalThis` by default) so tests can stub it
 * with `vi.stubGlobal("fetch", ...)` — no real key and no network needed.
 */
import type { ToolDefinition } from "../tools/types.js";
import type {
  AgentProvider,
  AgentProviderRequest,
  AgentResponse,
} from "./provider.js";
import {
  agentToolResultToContent,
  ProviderError,
  ProviderErrorCode,
} from "./provider.js";
import type { AgentToolCall } from "./agent.js";
import { validateToolCalls } from "./conversation.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Server-side Groq settings. Read from environment-driven config. */
export interface GroqProviderOptions {
  /** Groq API key. Must NOT be undefined when the adapter is used. */
  apiKey: string;
  /** Model sent to the Groq API. */
  model: string;
  /** Groq API base URL (default `https://api.groq.com/openai/v1`). */
  baseUrl?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * The HTTP transport. Defaults to the global `fetch`. Injectable so tests
   * can mock the network without a real key or outbound traffic.
   */
  fetch?: GroqFetch;
}

/**
 * Minimal fetch surface the adapter relies on. Matches the global `fetch`
 * used by Node 22 so the default injection is a plain `fetch` reference.
 */
export type GroqFetch = (
  input: string,
  init: GroqFetchInit,
) => Promise<GroqFetchResponse>;

/** Request init the adapter sends to Groq. JSON body, auth header. */
export interface GroqFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** The HTTP response interface the adapter consumes from the transport. */
export interface GroqFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Groq wire shapes
// ---------------------------------------------------------------------------

type GroqMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool";

type GroqMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: GroqToolCallWire[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type GroqToolCallWire = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type GroqRequest = {
  model: string;
  messages: GroqMessage[];
  tools?: GroqToolWire[];
};

type GroqToolWire = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type GroqChoice = {
  message?: {
    content?: unknown;
    tool_calls?: unknown;
  };
};

type GroqResponse = {
  choices?: unknown;
};

const GROQ_CHAT_COMPLETIONS_ENDPOINT = "/chat/completions";

function invalidResponse(message: string): ProviderError {
  return ProviderError.permanent(ProviderErrorCode.InvalidResponse, message);
}

/**
 * Normalize a request error (network / abort / unknown) into a `ProviderError`.
 * A bare `DOMException` named `AbortError` is how fetch signals a timeout or
 * abort — mapped to the transient `Timeout` code.
 */
function toProviderError(error: unknown): ProviderError {
  if (
    error instanceof Error &&
    "name" in error &&
    error.name === "AbortError"
  ) {
    return ProviderError.transient(ProviderErrorCode.Timeout, error.message);
  }
  if (error instanceof ProviderError) return error;
  return ProviderError.transient(
    ProviderErrorCode.Unavailable,
    error instanceof Error ? error.message : "Groq request failed.",
  );
}

/**
 * Map the provider-agnostic `ToolInputSchema` into an OpenAI-compatible JSON
 * Schema object for the Groq `tools` array. Since the schema is a plain,
 * subset JSON-Schema, its JSON representation is passed through as-is; the
 * object is wrapped (rather than deeply cloned) so repeated calls stay cheap.
 */
function toGroqTools(tools: readonly ToolDefinition[]): GroqToolWire[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties:
          tool.inputSchema.properties !== undefined
            ? tool.inputSchema.properties
            : undefined,
        required:
          tool.inputSchema.required !== undefined
            ? tool.inputSchema.required
            : undefined,
      },
    },
  }));
}

/**
 * Convert the request's messages (system context, prior conversation history,
 * user prompt, and any prior tool results) into the Groq message array in
 * conversation order.
 */
function toGroqMessages(request: AgentProviderRequest): GroqMessage[] {
  const messages: GroqMessage[] = [
    {
      role: "system",
      content:
        "You are an assistant that helps the user manage files. You may " +
        "call the provided tools when they help with the task.",
    },
  ];

  if (request.history !== undefined && request.history.length > 0) {
    for (const entry of request.history) {
      if (entry.role === "user") {
        messages.push({ role: "user", content: entry.text ?? "" });
        continue;
      }
      if (entry.toolCalls !== undefined && entry.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: entry.text ?? null,
          tool_calls: entry.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.toolName,
              arguments: JSON.stringify(call.input ?? {}),
            },
          })),
        });
        for (const result of entry.toolResults ?? []) {
          messages.push({
            role: "tool",
            tool_call_id: result.callId,
            content: agentToolResultToContent(result),
          });
        }
        continue;
      }
      messages.push({ role: "assistant", content: entry.text ?? null });
    }
  }

  messages.push({ role: "user", content: request.message });

  if (request.toolResults !== undefined && request.toolResults.length > 0) {
    const asAssistant: GroqMessage = {
      role: "assistant",
      content: null,
      tool_calls: request.toolResults.map((result) => ({
        id: result.callId,
        type: "function",
        function: {
          name: result.toolName ?? "unknown",
          arguments: JSON.stringify(result.toolInput ?? {}),
        },
      })),
    };
    messages.push(asAssistant);
    for (const result of request.toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: result.callId,
        content: result.ok
          ? JSON.stringify(result.data)
          : JSON.stringify({ error: result.error.message }),
      });
    }
  }

  return messages;
}

/**
 * Parse a raw Groq `choices[0].message` into provider-independent `text`.
 * `content` may be `null` (tool-only turns) — treated as no text.
 */
function parseGroqText(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined;
  if (typeof content !== "string") {
    throw invalidResponse("Groq message content must be a string or null.");
  }
  if (content.length === 0) return undefined;
  return content;
}

/**
 * Parse a raw Groq `choices[0].message.tool_calls` array into `AgentToolCall`
 * intents. Rejects any shape that does not conform, then re-validates the
 * batch through the shared `validateToolCalls` contract.
 */
function parseGroqToolCalls(rawToolCalls: unknown): AgentToolCall[] {
  if (rawToolCalls === undefined) return [];
  if (!Array.isArray(rawToolCalls)) {
    throw invalidResponse("Groq tool_calls must be an array.");
  }

  const candidates: AgentToolCall[] = rawToolCalls.map((entry) => {
    const call = entry as GroqToolCallWire;
    if (typeof call !== "object" || call === null || Array.isArray(call)) {
      throw invalidResponse("Each Groq tool call must be an object.");
    }
    if (call.type !== "function") {
      throw invalidResponse(
        `Groq returned a non-function tool call (type "${String(call.type)}").`,
      );
    }
    const functionName = call.function?.name;
    const argumentsText = call.function?.arguments;
    if (
      typeof functionName !== "string" ||
      functionName.trim().length === 0
    ) {
      throw invalidResponse(
        "Groq tool call function must include a non-empty name.",
      );
    }
    if (typeof argumentsText !== "string") {
      throw invalidResponse(
        "Groq tool call function arguments must be a JSON string.",
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(argumentsText);
    } catch {
      throw invalidResponse(
        "Groq tool call function arguments are not valid JSON.",
      );
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw invalidResponse(
        "Groq tool call function arguments must be a JSON object.",
      );
    }
    return {
      id: call.id === undefined ? `groq-${Date.now()}` : call.id,
      toolName: functionName,
      input: input as Record<string, unknown>,
    };
  });

  try {
    const validated = validateToolCalls(candidates);
    return validated === undefined ? [] : [...validated];
  } catch (error) {
    throw invalidResponse(
      `Groq tool calls failed validation: ${
        error instanceof Error ? error.message : "unknown reason"
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

/**
 * Create a Groq `AgentProvider` adapter.
 *
 * @throws `ProviderError.permanent(Authentication)` when no API key is
 *   configured — the adapter cannot reach Groq without a credential. Fails
 *   fast on construction rather than on the first request.
 */
export function createGroqProvider(
  options: GroqProviderOptions,
): AgentProvider {
  const apiKey = options.apiKey;
  const model = options.model;
  const baseUrl = options.baseUrl ?? "https://api.groq.com/openai/v1";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const transport: GroqFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  if (apiKey.length === 0) {
    throw ProviderError.permanent(
      ProviderErrorCode.Authentication,
      "Groq API key is not configured.",
    );
  }

  const url = `${baseUrl.replace(/\/$/, "")}${GROQ_CHAT_COMPLETIONS_ENDPOINT}`;

  async function generate(
    request: AgentProviderRequest,
  ): Promise<AgentResponse> {
    const payload: GroqRequest = {
      model,
      messages: toGroqMessages(request),
      tools: toGroqTools(request.tools),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: GroqFetchResponse;
    try {
      response = await transport(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      // Includes network failures, DNS errors, and aborted / timed-out
      // requests. Normalized into the typed ProviderError contract.
      throw toProviderError(error);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw mapHttpError(response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw invalidResponse("Groq returned a non-JSON response body.");
    }

    return parseGroqResponse(body);
  }

  return { generate };
}

/**
 * Map a non-OK HTTP status from Groq into a `ProviderError`.
 */
function mapHttpError(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return ProviderError.permanent(
      ProviderErrorCode.Authentication,
      `Groq rejected the API key (HTTP ${status}).`,
    );
  }
  if (status === 429) {
    return ProviderError.transient(
      ProviderErrorCode.RateLimited,
      `Groq rate-limited the request (HTTP ${status}).`,
    );
  }
  if (status >= 400 && status < 500) {
    return ProviderError.permanent(
      ProviderErrorCode.InvalidResponse,
      `Groq rejected the request (HTTP ${status}).`,
    );
  }
  return ProviderError.transient(
    ProviderErrorCode.Internal,
    `Groq request failed with HTTP ${status}.`,
  );
}

/**
 * Parse and validate a raw Groq chat-completions body into an `AgentResponse`.
 * Throws a permanent `InvalidResponse` `ProviderError` on any malformed shape.
 */
function parseGroqResponse(body: unknown): AgentResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalidResponse("Groq response body must be a JSON object.");
  }
  const response = body as GroqResponse;
  if (!Array.isArray(response.choices)) {
    throw invalidResponse("Groq response must include a choices array.");
  }
  if (response.choices.length === 0) {
    throw invalidResponse("Groq response choices array must not be empty.");
  }

  const first = response.choices[0];
  if (typeof first !== "object" || first === null) {
    throw invalidResponse("Groq response choice must be an object.");
  }
  const choice = first as GroqChoice;
  if (typeof choice.message !== "object" || choice.message === null) {
    throw invalidResponse("Groq response choice must include a message.");
  }

  const text = parseGroqText(choice.message.content);
  const toolCalls = parseGroqToolCalls(choice.message.tool_calls);

  return toolCalls.length > 0 ? { text, toolCalls } : { text };
}