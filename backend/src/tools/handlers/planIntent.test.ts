/**
 * plan_intent handler tests (Phase 11.1).
 *
 * The plan handler is PURE: it reads the flat fields the model populates,
 * validates them, assembles a nested `FileIntentPlan`, and returns it. These
 * tests run without any LLM, Tauri, or Node `fs` — the dispatch-level test
 * uses a spy `FilesystemExecutor` that throws if its bridge is ever touched,
 * proving planning never performs a filesystem operation.
 *
 * Coverage:
 *
 *   1. Natural-language MOVE → nested plan with preserved semantic
 *      references (no path invented).
 *   2. Absolute-path MOVE → the user-supplied path is passed through
 *      VERBATIM and marked `reference: "path"` (authoritative).
 *   3. Explicit file/folder kinds are preserved; an omitted kind defaults
 *      to "unknown" (never guessed).
 *   4. Destination references are preserved exactly as supplied.
 *   5. Deterministic flags: MOVE, RENAME, and COPY are approved+supported;
 *      SEARCH/DELETE/etc. are never supported by the planner (and write
 *      intents still require approval when executed later).
 *   6. Invalid/ambiguous inputs → structured validation ToolErrors:
 *      missing intent, unknown intent, missing source, MOVE without a
 *      destination, a relative source path, and an unknown entity kind.
 *   7. Dispatch end-to-end through the plan-only registry: a plan_intent
 *      call resolves through policy → handler with ZERO executor calls, and
 *      an errant filesystem-tool call in the same turn is unknown_tool
 *      (the registry never offers filesystem tools).
 */
import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../registry.js";
import { registerPlanTools } from "../definitions/planTools.js";
import { dispatchTool } from "./index.js";
import {
  buildFileIntentPlan,
  planIntentHandler,
  type FileIntentPlan,
} from "./planIntent.js";
import { ToolError, isToolError } from "../errors.js";
import { authenticatedAiAgent } from "../policy.js";
import type { FilesystemExecutor } from "../executor.js";
import type { DirectoryListing } from "../tauriShapes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  displayName: "Alice Example",
  status: "active",
};

/** A FilesystemExecutor that records every call (planning must never call it). */
function spyFilesystem(): FilesystemExecutor & { calls: string[] } {
  const calls: string[] = [];
  const fake: FilesystemExecutor & { calls: string[] } = {
    calls,
    async listDirectory(): Promise<DirectoryListing> {
      calls.push("listDirectory");
      return { path: "/", parentPath: null, isHome: true, items: [] };
    },
    async searchFiles() {
      calls.push("searchFiles");
      return [];
    },
    async getFileMetadata() {
      calls.push("getFileMetadata");
      throw new Error("fail-closed test executor");
    },
    async readFile() {
      calls.push("readFile");
      throw new Error("fail-closed test executor");
    },
    async moveFile() {
      calls.push("moveFile");
      throw new Error("fail-closed test executor");
    },
    async copyFile() {
      calls.push("copyFile");
      throw new Error("fail-closed test executor");
    },
  };
  return fake;
}

/** Assert that building the plan throws exactly a validation ToolError. */
function validationError(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (error) {
    if (isToolError(error)) {
      expect(error.category).toBe("validation");
      return error;
    }
    throw error;
  }
  throw new Error("expected buildFileIntentPlan to throw a ToolError");
}

function planRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerPlanTools(registry);
  return registry;
}

// ---------------------------------------------------------------------------
// 1. Natural-language MOVE
// ---------------------------------------------------------------------------

describe("plan_intent — natural-language MOVE", () => {
  it("builds a nested plan with preserved semantic references", () => {
    const plan = buildFileIntentPlan({
      intent: "MOVE",
      sourceKind: "folder",
      sourceName: "sound",
      sourceLocation: "Downloads",
      sourceDescription: 'the "sound" folder',
      destinationKind: "folder",
      destinationName: "Desktop",
    });

    expect(plan).toEqual({
      intent: "MOVE",
      source: {
        reference: "semantic",
        kind: "folder",
        name: "sound",
        location: "Downloads",
        description: 'the "sound" folder',
      },
      destination: {
        reference: "semantic",
        kind: "folder",
        name: "Desktop",
      },
      operation: {},
      requiresApproval: true,
      supported: true,
    });
  });

  it("carries an optional free-form operation note when supplied", () => {
    const plan = buildFileIntentPlan({
      intent: "MOVE",
      sourceName: "notes.txt",
      destinationName: "Desktop",
      operationNote: "overwrite if the destination is occupied",
    });

    expect(plan.operation).toEqual({
      note: "overwrite if the destination is occupied",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Absolute-path MOVE (authoritative, verbatim)
// ---------------------------------------------------------------------------

describe("plan_intent — absolute-path MOVE", () => {
  it("passes user-supplied absolute paths through verbatim and marks path references", () => {
    const plan = buildFileIntentPlan({
      intent: "MOVE",
      sourceKind: "folder",
      sourceName: "sound",
      sourceAbsolutePath: "/Users/apple/Downloads/sound",
      destinationKind: "folder",
      destinationAbsolutePath: "/Users/apple/Desktop",
    });

    expect(plan.source).toEqual({
      reference: "path",
      kind: "folder",
      name: "sound",
      absolutePath: "/Users/apple/Downloads/sound",
    });
    expect(plan.destination).toEqual({
      reference: "path",
      kind: "folder",
      absolutePath: "/Users/apple/Desktop",
    });
  });

  it("does NOT rediscover or expand an absolute path", () => {
    const plan = buildFileIntentPlan({
      intent: "MOVE",
      sourceAbsolutePath: "/Users/apple/Downloads/sound",
      destinationAbsolutePath: "/Users/apple/Desktop",
    });

    expect(plan.source.reference).toBe("path");
    expect(plan.source.absolutePath).toBe("/Users/apple/Downloads/sound");
    expect(plan.destination?.absolutePath).toBe("/Users/apple/Desktop");
    // No search/list/metadata intent, no filesystem, no execution field.
    expect(Object.keys(plan).sort()).toEqual(
      ["destination", "intent", "operation", "requiresApproval", "source", "supported"],
    );
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. Kinds and destination references
// ---------------------------------------------------------------------------

describe("plan_intent — entity kinds and destination references", () => {
  it("preserves an explicit folder vs file distinction", () => {
    const folder = buildFileIntentPlan({
      intent: "MOVE",
      sourceKind: "folder",
      sourceName: "photos",
      destinationKind: "folder",
      destinationName: "Backups",
    });
    const file = buildFileIntentPlan({
      intent: "MOVE",
      sourceKind: "file",
      sourceName: "notes.txt",
      destinationKind: "folder",
      destinationName: "Desktop",
    });

    expect(folder.source.kind).toBe("folder");
    expect(file.source.kind).toBe("file");
    expect(folder.destination?.kind).toBe("folder");
  });

  it("defaults an omitted kind to unknown without guessing", () => {
    const plan = buildFileIntentPlan({
      intent: "MOVE",
      sourceName: "notes.txt",
      destinationName: "Desktop",
    });

    expect(plan.source.kind).toBe("unknown");
    expect(plan.destination?.kind).toBe("unknown");
  });

  it("preserves destination references exactly as supplied", () => {
    const plan = buildFileIntentPlan({
      intent: "MOVE",
      sourceName: "sound",
      sourceLocation: "Downloads",
      destinationName: "Desktop",
      destinationDescription: 'the "Desktop" folder',
    });

    expect(plan.destination).toEqual({
      reference: "semantic",
      kind: "unknown",
      name: "Desktop",
      description: 'the "Desktop" folder',
    });
  });
});

// ---------------------------------------------------------------------------
// RENAME — new name in operation, no destination required
// ---------------------------------------------------------------------------

describe("plan_intent — RENAME", () => {
  it("builds a plan with the source reference and the new name in operation", () => {
    const plan = buildFileIntentPlan({
      intent: "RENAME",
      sourceKind: "file",
      sourceName: "cross.jpg",
      sourceLocation: "Downloads",
      newName: "cross-final.jpg",
    });

    expect(plan).toEqual({
      intent: "RENAME",
      source: {
        reference: "semantic",
        kind: "file",
        name: "cross.jpg",
        location: "Downloads",
      },
      operation: { newName: "cross-final.jpg" },
      requiresApproval: true,
      supported: true,
    });
    // The target path is derived from the source's own directory; the planner
    // must NOT require (or invent) a destination reference for a rename.
    expect(plan.destination).toBeUndefined();
  });

  it("preserves a user-supplied destination reference when provided", () => {
    const plan = buildFileIntentPlan({
      intent: "RENAME",
      sourceName: "cross.jpg",
      newName: "cross-final.jpg",
      destinationName: "cross-final.jpg",
    });

    expect(plan.destination).toEqual({
      reference: "semantic",
      kind: "unknown",
      name: "cross-final.jpg",
    });
    expect(plan.operation).toEqual({ newName: "cross-final.jpg" });
  });

  it("passes a user-supplied absolute source path through verbatim", () => {
    const plan = buildFileIntentPlan({
      intent: "RENAME",
      sourceKind: "file",
      sourceAbsolutePath: "/Users/apple/Downloads/cross.jpg",
      newName: "cross-final.jpg",
    });

    expect(plan.source).toEqual({
      reference: "path",
      kind: "file",
      absolutePath: "/Users/apple/Downloads/cross.jpg",
    });
    expect(plan.operation).toEqual({ newName: "cross-final.jpg" });
  });

  it("rejects a RENAME without a new name (and without a destination)", () => {
    const error = validationError(() =>
      buildFileIntentPlan({
        intent: "RENAME",
        sourceName: "cross.jpg",
      }),
    );
    expect(error.message).toContain("newName");
  });
});

// ---------------------------------------------------------------------------
// COPY — destination FOLDER, keeps the source name
// ---------------------------------------------------------------------------

describe("plan_intent — COPY", () => {
  it("builds a nested plan with preserved semantic references", () => {
    const plan = buildFileIntentPlan({
      intent: "COPY",
      sourceKind: "file",
      sourceName: "receipt.pdf",
      sourceLocation: "Downloads",
      destinationKind: "folder",
      destinationName: "Backups",
    });

    expect(plan).toEqual({
      intent: "COPY",
      source: {
        reference: "semantic",
        kind: "file",
        name: "receipt.pdf",
        location: "Downloads",
      },
      destination: {
        reference: "semantic",
        kind: "folder",
        name: "Backups",
      },
      operation: {},
      requiresApproval: true,
      supported: true,
    });
  });

  it("passes user-supplied absolute paths through verbatim", () => {
    const plan = buildFileIntentPlan({
      intent: "COPY",
      sourceKind: "file",
      sourceAbsolutePath: "/Users/apple/Downloads/receipt.pdf",
      destinationKind: "folder",
      destinationAbsolutePath: "/Users/apple/Backups",
    });

    expect(plan.source).toEqual({
      reference: "path",
      kind: "file",
      absolutePath: "/Users/apple/Downloads/receipt.pdf",
    });
    expect(plan.destination).toEqual({
      reference: "path",
      kind: "folder",
      absolutePath: "/Users/apple/Backups",
    });
    expect(plan.requiresApproval).toBe(true);
    expect(plan.supported).toBe(true);
  });

  it("rejects a COPY with no destination reference", () => {
    const error = validationError(() =>
      buildFileIntentPlan({ intent: "COPY", sourceName: "receipt.pdf" }),
    );
    expect(error.message).toContain("destination reference is required");
  });
});

// ---------------------------------------------------------------------------
// 5. Deterministic approval / support flags
// ---------------------------------------------------------------------------

describe("plan_intent — deterministic requiresApproval and supported flags", () => {
  it("marks MOVE as approval-requiring AND supported", () => {
    const plan = buildFileIntentPlan({
      intent: "MOVE",
      sourceName: "sound",
      destinationName: "Desktop",
    });
    expect(plan.requiresApproval).toBe(true);
    expect(plan.supported).toBe(true);
  });

  it("marks RENAME as approval-requiring AND supported (with a newName)", () => {
    const plan = buildFileIntentPlan({
      intent: "RENAME",
      sourceName: "cross.jpg",
      sourceLocation: "Downloads",
      newName: "cross-final.jpg",
    });
    expect(plan.requiresApproval).toBe(true);
    expect(plan.supported).toBe(true);
    expect(plan.operation).toEqual({ newName: "cross-final.jpg" });
  });

  it("marks COPY as approval-requiring AND supported", () => {
    const plan = buildFileIntentPlan({
      intent: "COPY",
      sourceName: "receipt.pdf",
      destinationName: "Backups",
    });
    expect(plan.requiresApproval).toBe(true);
    expect(plan.supported).toBe(true);
  });

  it("marks every other intent as unsupported by the planner (deterministic)", () => {
    const cases: Array<[string, Record<string, string>, boolean]> = [
      ["DELETE", { sourceName: "sound" }, true],
      ["ORGANIZE", { sourceName: "Downloads", destinationName: "Folder" }, true],
      ["SEARCH", { sourceName: "sound" }, false],
    ];
    for (const [intent, fields, approval] of cases) {
      const plan = buildFileIntentPlan({ intent, ...fields }) as FileIntentPlan;
      expect(plan.requiresApproval).toBe(approval);
      expect(plan.supported).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Invalid / ambiguous inputs
// ---------------------------------------------------------------------------

describe("plan_intent — invalid and ambiguous inputs", () => {
  it("rejects a missing intent", () => {
    const error = validationError(() =>
      buildFileIntentPlan({ sourceName: "sound", destinationName: "Desktop" }),
    );
    expect(error.code).toBe("tools/invalid-input");
  });

  it("rejects an unknown intent", () => {
    const error = validationError(() =>
      buildFileIntentPlan({
        intent: "explode",
        sourceName: "sound",
        destinationName: "Desktop",
      }),
    );
    expect(error.message).toContain('Unknown intent "explode"');
  });

  it("rejects a missing source reference", () => {
    const error = validationError(() =>
      buildFileIntentPlan({ intent: "MOVE", destinationName: "Desktop" }),
    );
    expect(error.message).toContain("source reference is required");
  });

  it("rejects a MOVE with no destination reference", () => {
    const error = validationError(() =>
      buildFileIntentPlan({ intent: "MOVE", sourceName: "sound" }),
    );
    expect(error.message).toContain("destination reference is required");
  });

  it("rejects a relative source path (never trusted)", () => {
    const error = validationError(() =>
      buildFileIntentPlan({
        intent: "MOVE",
        sourceName: "sound",
        sourceAbsolutePath: "Downloads/sound",
        destinationName: "Desktop",
      }),
    );
    // The message must not leak the raw path.
    expect(error.message).not.toContain("Downloads/sound");
  });

  it("rejects an unknown entity kind", () => {
    const error = validationError(() =>
      buildFileIntentPlan({
        intent: "MOVE",
        sourceKind: "symlink",
        sourceName: "sound",
        destinationName: "Desktop",
      }),
    );
    expect(error.message).toContain("source kind must be one of");
  });
});

// ---------------------------------------------------------------------------
// 7. Dispatch end-to-end — no filesystem, plan-only registry
// ---------------------------------------------------------------------------

describe("plan_intent — dispatch never touches the filesystem", () => {
  it("resolves through policy + handler with zero executor calls", async () => {
    const filesystem = spyFilesystem();
    const registry = planRegistry();

    const result = await dispatchTool(
      registry,
      "plan_intent",
      { intent: "MOVE", sourceName: "sound", destinationName: "Desktop" },
      { filesystem },
      { actor: authenticatedAiAgent(ACTIVE_USER) },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        intent: "MOVE",
        requiresApproval: true,
        supported: true,
      });
    }
    expect(filesystem.calls).toEqual([]);
  });

  it("returns unknown_tool for an errant filesystem-tool call in the plan turn", async () => {
    const filesystem = spyFilesystem();
    const registry = planRegistry();

    const errant = await dispatchTool(
      registry,
      "list_directory",
      { path: "/Users/apple" },
      { filesystem },
      { actor: authenticatedAiAgent(ACTIVE_USER) },
    );

    expect(errant.ok).toBe(false);
    if (!errant.ok) {
      expect(errant.error.category).toBe("unknown_tool");
    }
    expect(filesystem.calls).toEqual([]);
  });

  it("runs the registered handler directly without a filesystem dependency", async () => {
    const filesystem = spyFilesystem();
    const result = await planIntentHandler(
      { intent: "MOVE", sourceName: "sound", destinationName: "Desktop" },
      { filesystem },
    );

    expect(result).toEqual({
      intent: "MOVE",
      source: { reference: "semantic", kind: "unknown", name: "sound" },
      destination: { reference: "semantic", kind: "unknown", name: "Desktop" },
      operation: {},
      requiresApproval: true,
      supported: true,
    });
    expect(filesystem.calls).toEqual([]);
  });
});