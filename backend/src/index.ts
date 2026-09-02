/**
 * Server bootstrap — the only entrypoint. All application wiring lives in
 * app.ts; this file reads config, binds the port, and handles shutdown.
 */
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();

const server = serve(
  { fetch: app.fetch, port: config.port, hostname: config.host },
  (info) => {
    console.log(`[backend] listening on http://${info.address}:${info.port}`);
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[backend] ${signal} received, shutting down`);
    server.close((error) => {
      process.exit(error ? 1 : 0);
    });
  });
}
