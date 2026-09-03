/**
 * Environment-driven configuration.
 *
 * No secrets exist yet — and when they arrive they must come from the
 * environment, never from source code or version control.
 */

function intFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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
};
