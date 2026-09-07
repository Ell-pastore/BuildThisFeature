/**
 * Environment-driven configuration.
 *
 * All secrets, including the Grok API key, must come from the environment —
 * never from source code or version control.
 */

function intFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envStringOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function listFromEnv(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const items = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * Browser/webview origins allowed to call the API when none are configured.
 * Covers the Vite dev servers used by this repo; Tauri webview origins can be
 * added via CORS_ORIGINS when the desktop app starts calling the API.
 */
const DEFAULT_DEV_ORIGINS: string[] = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8443",
  "http://127.0.0.1:8443",
  // Desktop webview origins (Tauri v2): macOS/Linux use tauri://localhost,
  // Windows uses http://tauri.localhost — needed when the desktop app calls the API.
  "tauri://localhost",
  "http://tauri.localhost",
];

export const config = {
  /** TCP port for the HTTP server. */
  port: intFromEnv(process.env.PORT) ?? 4000,
  /** Bind address. Loopback by default — never expose the API unintentionally. */
  host: process.env.HOST ?? "127.0.0.1",
  /** Browser/webview origins allowed by CORS. */
  corsOrigins: listFromEnv(process.env.CORS_ORIGINS) ?? DEFAULT_DEV_ORIGINS,
  /** Session lifetime in hours (Phase 7). Safe production-oriented default. */
  sessionTtlHours: Math.max(1, intFromEnv(process.env.SESSION_TTL_HOURS) ?? 12),
  /**
   * Grok (xAI) provider settings (Phase 10.9).
   *
   * The API key is a production secret: read from the environment only,
   * never committed. The model default lives HERE in configuration (not
   * in the adapter's logic) so operators can switch models via
   * `GROK_MODEL` without a code change.
   */
  grok: {
    /** xAI API key. `undefined` until `GROK_API_KEY` is set in env/.env. */
    apiKey: envStringOrUndefined(process.env.GROK_API_KEY),
    /** Model sent to the xAI API. Default via configuration. */
    model: process.env.GROK_MODEL ?? "grok-3",
    /** xAI API base URL. */
    baseUrl: process.env.GROK_BASE_URL ?? "https://api.x.ai/v1",
    /** Request timeout in milliseconds (Phase 10.9 HTTP client). */
    timeoutMs: Math.max(
      1000,
      intFromEnv(process.env.GROK_TIMEOUT_MS) ?? 60_000,
    ),
  },
  /**
   * The name of the AI provider requested via configuration (Phase 10.10).
   * Operators set `AI_PROVIDER` to choose among the providers registered in
   * the provider-selection layer; the value is validated against the known
   * provider ids at resolution time. Defaults to the built-in Grok adapter.
   */
  aiProvider: process.env.AI_PROVIDER ?? "grok",
};
