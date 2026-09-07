/**
 * Tool Registry types (Phase 9.1).
 *
 * Provider-agnostic definitions for describing, organizing, and looking up
 * tools that the AI agent will eventually invoke. These types carry only
 * metadata — no execution logic, no LLM coupling.
 */

// ---------------------------------------------------------------------------
// Permission classification
// ---------------------------------------------------------------------------

/** Permission classification stored alongside each tool definition. */
export enum ToolPermission {
  Read = "read",
  Write = "write",
  Destructive = "destructive",
}

// ---------------------------------------------------------------------------
// Input schema (simplified JSON-Schema-like representation)
// ---------------------------------------------------------------------------

/** Simplified, JSON-compatible representation of a tool's expected input. */
export type ToolInputSchema = {
  type: "object";
  properties?: Record<string, ToolInputSchemaProperty>;
  required?: string[];
};

export type ToolInputSchemaProperty =
  | { type: "string"; description?: string }
  | { type: "number"; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; items?: ToolInputSchemaProperty; description?: string };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/** A fully-described, self-contained tool ready for registry storage. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly permission: ToolPermission;
}
