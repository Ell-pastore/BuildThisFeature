/**
 * Plan-only tool definitions.
 *
 * `plan_intent` is the single read-only, zero-side-effect tool exposed to the
 * planning agent turn. The provider produces structured intent data; the
 * handler normalises it into a `FileIntentPlan` and returns it. No filesystem
 * is touched during planning.
 */
import { ToolPermission, type ToolDefinition } from "../types.js";
import { ToolRegistry } from "../registry.js";

export const planToolDefinitions: readonly ToolDefinition[] = [
  {
    name: "plan_intent",
    description:
      "Produce a structured file-operation intent/plan from the user's assignment. " +
      "This tool NEVER touches the filesystem: it classifies the request into a " +
      "normalised plan (intent, source reference, destination reference, operation " +
      "parameters, and whether execution will require approval). " +
      "KEEP natural-language references EXACTLY as the user gave them (for example " +
      'name "sound", location "Downloads"); do NOT invent an absolute path. ' +
      "When the user supplied an absolute path verbatim, pass it through unchanged " +
      "in the matching absolutePath field. The execution layer resolves references " +
      "and runs through approval, policy, and the filesystem allow-list later. " +
      "MOVEs name a destination; RENAMEs name the requested new file name in the " +
      "newName field — the target path is derived from the source's own directory, " +
      "so never supply a destination path for a rename. COPYs name a destination " +
      "FOLDER — the copy keeps the source's original file name.",
    inputSchema: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description:
            'The file operation the user asked for: MOVE, COPY, DELETE, RENAME, SEARCH, or ORGANIZE.',
        },
        sourceKind: {
          type: "string",
          description:
            "Known entity kind: file, folder, any, or unknown. Omit when uncertain.",
        },
        sourceName: {
          type: "string",
          description:
            'Best-effort name of the source entity, e.g. "report".',
        },
        sourceLocation: {
          type: "string",
          description:
            'Best-effort container reference, e.g. "Downloads" or "Documents/Reports".',
        },
        sourceAbsolutePath: {
          type: "string",
          description:
            "Only when the user supplied an absolute path verbatim; pass it through unchanged. " +
            "Never invent one.",
        },
        sourceDescription: {
          type: "string",
          description:
            "The original natural-language fragment describing the source, preserved verbatim.",
        },
        newName: {
          type: "string",
          description:
            'Required for RENAME: the exact new file name the user requested, e.g. "cross-final.jpg". ' +
            "Omit for every other intent. Never include a folder path — the target stays in the " +
            "source's own directory.",
        },
        destinationKind: {
          type: "string",
          description:
            "Known entity kind for the destination: file, folder, any, or unknown. Omit when uncertain.",
        },
        destinationName: {
          type: "string",
          description:
            'Best-effort name of the destination entity, e.g. "Desktop".',
        },
        destinationLocation: {
          type: "string",
          description:
            'Best-effort container reference for the destination, e.g. "Documents".',
        },
        destinationAbsolutePath: {
          type: "string",
          description:
            "Only when the user supplied an absolute destination path verbatim; " +
            "pass it through unchanged. Never invent one.",
        },
        destinationDescription: {
          type: "string",
          description:
            "The original natural-language fragment describing the destination, " +
            "preserved verbatim.",
        },
        operationNote: {
          type: "string",
          description:
            "Optional free-form user-stated operation parameter (overwrite/conflict " +
            "rule, priority, comment, etc.). Omit when the user stated none.",
        },
      },
      required: ["intent"],
    } as Record<string, unknown>,
    permission: ToolPermission.Read,
  } as ToolDefinition,
];

export function registerPlanTools(registry: ToolRegistry): void {
  for (const def of planToolDefinitions) {
    registry.register(def);
  }
}
