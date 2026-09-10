/**
 * Production AI instruction runtime assembly (Phase 10.38).
 *
 * The single place the HOST assembles the LONG-LIVED persistent agent-turn
 * runtime that `POST /api/ai/instructions` runs through. `createApp()` calls
 * `bindProductionAiInstructionRuntime()` once at startup so provider
 * fallback/rotation/cooldown state and the tool runtime survive across
 * requests.
 *
 * Design rules:
 *
 *   - SINGLE COMPOSITION POINT: the runtime is built from the EXISTING,
 *     tested production building blocks — `composeDefaultProviderStack()`
 *     (the Phase 10.17 composition root that validates the configured chain,
 *     per-provider settings, and credentials), the registered read+write tool
 *     surface (Phases 9.2 / 10.36), a fresh `ToolRegistry`, and the desktop
 *     `FilesystemExecutor` bridge (Phase 9.3, `tauriFilesystemExecutor`).
 *   - FAIL LOUD AT STARTUP: nothing swallows a provider composition error. If
 *     the configured provider system is invalid, the composition error
 *     propagates SYNC from `composeProductionAiRuntime()` and therefore from
 *     `createApp()` — the server refuses to start instead of serving a broken
 *     AI stack.
 *   - NO REDESIGN: this module only wires existing pieces together. It adds no
 *     providers, adapters, tools, retries, streaming, or approval/policy
 *     changes; it never catches or remaps a `ProviderCompositionError`.
 *   - HOST SEAM: the filesystem executor defaults to the Tauri IPC bridge.
 *     The `invoke` is resolved from the desktop host when it is available; a
 *     host or test can inject its own `invoke` / `filesystem` / `stack` so the
 *     same factory composes deterministically wherever it runs.
 */
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import {
  readToolDefinitions,
  registerReadTools,
} from "../tools/definitions/readTools.js";
import {
  writeToolDefinitions,
  registerWriteTools,
} from "../tools/definitions/writeTools.js";
import {
  tauriFilesystemExecutor,
  type FilesystemExecutor,
  type TauriInvoke,
} from "../tools/executor.js";
import {
  composeDefaultProviderStack,
  type ComposedProviderStack,
} from "./providerComposition.js";
import {
  createPersistentTurnRuntime,
  type PersistentAgentTurnRuntime,
} from "./persistentAgentTurn.js";
import { bindAiInstructionRuntime } from "./aiInstructions.js";

/**
 * The loop bound applied to NEW conversations created through the production
 * runtime. Kept identical to the existing lazy-default cap so the
 * conversation-round semantics are unchanged.
 */
export const PRODUCTION_AI_MAX_TOOL_ROUNDS = 3;

/**
 * Injectable construction inputs for the production runtime. Every field is
 * optional and falls back to the production default — a host supplies only
 * the pieces it needs (and tests supply scripted stand-ins).
 */
export interface ProductionAiRuntimeOptions {
  /**
   * The composed provider stack. Defaults to `composeDefaultProviderStack()`
   * (the environment-configured chain/settings/credentials). Composing throws
   * a typed `ProviderCompositionError` on any invalid configuration.
   */
  stack?: ComposedProviderStack;
  /**
   * The filesystem executor. Defaults to the Tauri IPC bridge built from
   * `invoke` (or the ambient desktop host when present).
   */
  filesystem?: FilesystemExecutor;
  /**
   * The Tauri `invoke` used to build the default filesystem executor. When
   * neither this nor an ambient host invoke is available, the executor is
   * fail-closed: every filesystem tool returns a clear error.
   */
  invoke?: TauriInvoke;
  /** Candidate tool metadata. Defaults to the registered read + write tools. */
  tools?: readonly ToolDefinition[];
  /** The tool registry. Defaults to a fresh registry with read + write tools. */
  registry?: ToolRegistry;
  /** Loop bound for NEW conversations. Defaults to `PRODUCTION_AI_MAX_TOOL_ROUNDS`. */
  maxToolRounds?: number;
}

/**
 * The desktop host's ambient shape. Only the `invoke` the filesystem bridge
 * needs is read; everything else is left untouched.
 */
interface TauriHostGlobal {
  __TAURI__?: { core?: { invoke?: TauriInvoke } };
}

/**
 * Read the desktop host's `invoke` when the server runs inside a Tauri
 * webview. Returns `undefined` when no host is present (standalone server,
 * tests).
 */
function ambientTauriInvoke(): TauriInvoke | undefined {
  const globals = globalThis as unknown as TauriHostGlobal;
  return globals.__TAURI__?.core?.invoke;
}

/**
 * A fail-closed stand-in used only when no host invoke is available. Tool
 * execution is never silently dropped — every filesystem call rejects with a
 * clear, non-secret error instead.
 */
function unavailableTauriInvoke(): TauriInvoke {
  return async <T>(_command: string, _args?: Record<string, unknown>): Promise<T> => {
    throw new Error(
      "The desktop filesystem host (Tauri invoke) is not available, so AI filesystem tools are disabled.",
    );
  };
}

/**
 * Build the default registered tool surface: read tools (Phase 9.2) plus the
 * approval-gated write tools (Phase 10.36), in the same fixed order the
 * existing lazy default used.
 */
function defaultProductionTools(): readonly ToolDefinition[] {
  return [...readToolDefinitions, ...writeToolDefinitions];
}

/**
 * Build a fresh `ToolRegistry` with exactly the registered read + write tools.
 */
function buildProductionToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  return registry;
}

/**
 * Assemble the production persistent agent-turn runtime (Phase 10.20) from the
 * configured provider stack, the registered tool surface, and the filesystem
 * executor.
 *
 * @throws `ProviderCompositionError` synchronously when the provider
 *         configuration is invalid (nothing is swallowed or remapped) — a
 *         misconfigured startup is loud, not a silent 503.
 */
export function composeProductionAiRuntime(
  options: ProductionAiRuntimeOptions = {},
): PersistentAgentTurnRuntime {
  const stack = options.stack ?? composeDefaultProviderStack();
  const registry = options.registry ?? buildProductionToolRegistry();
  const tools = options.tools ?? defaultProductionTools();
  const invoke = options.invoke ?? ambientTauriInvoke();
  const filesystem =
    options.filesystem ??
    tauriFilesystemExecutor(invoke ?? unavailableTauriInvoke());
  return createPersistentTurnRuntime({
    stack,
    tools,
    registry,
    filesystem,
    maxToolRounds: options.maxToolRounds ?? PRODUCTION_AI_MAX_TOOL_ROUNDS,
  });
}

function isPersistentAgentTurnRuntime(
  value: PersistentAgentTurnRuntime | ProductionAiRuntimeOptions,
): value is PersistentAgentTurnRuntime {
  return typeof (value as PersistentAgentTurnRuntime).run === "function";
}

/**
 * Compose (unless a runtime is supplied) and bind the LONG-LIVED production
 * AI instruction runtime via the existing `bindAiInstructionRuntime` seam.
 *
 * @throws `ProviderCompositionError` synchronously on provider
 *         misconfiguration (when composing the default stack).
 */
export function bindProductionAiInstructionRuntime(
  runtimeOrOptions: PersistentAgentTurnRuntime | ProductionAiRuntimeOptions = {},
): PersistentAgentTurnRuntime {
  const runtime = isPersistentAgentTurnRuntime(runtimeOrOptions)
    ? runtimeOrOptions
    : composeProductionAiRuntime(runtimeOrOptions);
  bindAiInstructionRuntime(runtime);
  return runtime;
}