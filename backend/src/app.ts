/**
 * Hono application factory.
 *
 * Kept separate from index.ts so the app can be created without binding a
 * port (tests and future tooling).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { onError, onNotFound } from "./core/http.js";
import { apiRoutes } from "./routes/index.js";
import { bindProductionAiInstructionRuntime } from "./services/productionAiRuntime.js";
import type { PersistentAgentTurnRuntime } from "./services/persistentAgentTurn.js";

/**
 * Optional app construction inputs. Only the pieces a caller needs to
 * override must be supplied; production calls `createApp()` with no argument.
 */
export interface CreateAppOptions {
  /**
   * A pre-assembled AI instruction runtime to bind instead of composing the
   * configured provider stack (test doubles / host overrides). When omitted,
   * the production runtime is composed from the configured providers, tool
   * surface, and filesystem executor — and provider misconfiguration FAILS
   * STARTUP LOUDLY (a `ProviderCompositionError` propagates).
   */
  aiRuntime?: PersistentAgentTurnRuntime;
}

/**
 * Hono application factory.
 *
 * Kept separate from index.ts so the app can be created without binding a
 * port (tests and future tooling).
 *
 * The production AI instruction runtime is bound ONCE at startup before any
 * route is served; the same bound runtime (provider fallback/rotation/
 * cooldown + tool state) then serves every authenticated instruction.
 */
export function createApp(options: CreateAppOptions = {}): Hono {
  bindProductionAiInstructionRuntime(options.aiRuntime);

  const app = new Hono();

  // Browser/webview origins allowed to call the API (see config.ts).
  app.use("/api/*", cors({ origin: config.corsOrigins }));

  app.notFound(onNotFound);
  app.onError(onError);

  app.route("/api", apiRoutes);

  return app;
}
