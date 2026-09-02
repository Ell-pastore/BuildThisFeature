/**
 * GET /api/health — the one endpoint in this foundation phase.
 *
 * It reports honest status: what is actually wired, and what is deliberately
 * not built yet. Statuses here are updated as each phase lands — never faked.
 */
import { Hono } from "hono";

const COMPONENT_STATUSES = {
  database: "not-configured",
  objectStorage: "not-configured",
  sync: "not-implemented",
  authentication: "not-implemented",
  ai: "not-implemented",
} as const;

export const healthRoutes = new Hono().get("/", (c) =>
  c.json({
    status: "ok",
    service: "smart-file-manager-backend",
    time: new Date().toISOString(),
    components: COMPONENT_STATUSES,
  }),
);
