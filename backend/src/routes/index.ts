/**
 * API route registry.
 *
 * Each future feature (files, sync, stars, search, ...) gets its own module
 * mounted here under /api. Routes stay thin and delegate to services; services
 * delegate to the database/storage layers (Phases 6 and 8).
 */
import { Hono } from "hono";
import { healthRoutes } from "./health.js";

export const apiRoutes = new Hono().route("/health", healthRoutes);
