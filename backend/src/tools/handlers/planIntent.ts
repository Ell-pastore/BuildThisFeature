/**
 * plan_intent handler — pure plan builder, no filesystem.
 *
 * The handler reads a flat set of fields that the model populates, validates
 * them, assembles nested `EntityIntentReference` shapes (source + optional
 * destination), and returns a normalised `FileIntentPlan`.  It never touches
 * the filesystem: resolution, discovery, and execution are deferred to later
 * phases.
 *
 * MOVE carries a destination reference (an exact path is resolved at
 * execution). RENAME carries a required `newName` (stored in
 * `operation.newName`) instead — the execution layer derives the target path
 * from the resolved source's parent directory plus that new name, so a caller
 * can never steer the rename elsewhere. COPY carries a destination reference
 * (a folder) and keeps the source's own file name; the resolved destination
 * is always `destDirPath + basename(sourcePath)`.
 */
import { requireString } from "./handler.js";
import { validateToolPath } from "../paths.js";
import { ToolError, ToolErrorCode } from "../errors.js";
import type { ToolHandlerFunction } from "./handler.js";
import type { RawToolInput } from "./handler.js";

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export const IntentKind = {
  MOVE: "MOVE",
  COPY: "COPY",
  DELETE: "DELETE",
  RENAME: "RENAME",
  SEARCH: "SEARCH",
  ORGANIZE: "ORGANIZE",
} as const;
export type IntentKind = (typeof IntentKind)[keyof typeof IntentKind];

export const ENTITY_REFERENCE_KINDS = ["file", "folder", "any", "unknown"] as const;
export type EntityReferenceKind = (typeof ENTITY_REFERENCE_KINDS)[number];

export interface EntityIntentReference {
  reference: "path" | "semantic";
  kind: EntityReferenceKind;
  name?: string;
  location?: string;
  absolutePath?: string;
  description?: string;
}

export interface FileIntentPlan {
  intent: IntentKind;
  source: EntityIntentReference;
  destination?: EntityIntentReference;
  operation: Record<string, unknown>;
  requiresApproval: boolean;
  supported: boolean;
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const VALID_INTENTS: ReadonlySet<string> = new Set(Object.values(IntentKind));

const WRITE_INTENTS: ReadonlySet<IntentKind> = new Set([
  IntentKind.MOVE,
  IntentKind.COPY,
  IntentKind.DELETE,
  IntentKind.RENAME,
  IntentKind.ORGANIZE,
]);

/** Intents whose execution intrinsically needs a destination reference. */
const DESTINATION_INTENTS: ReadonlySet<IntentKind> = new Set([
  IntentKind.MOVE,
  IntentKind.COPY,
  IntentKind.ORGANIZE,
]);

const SUPPORTED_INTENTS: ReadonlySet<IntentKind> = new Set([
  IntentKind.MOVE,
  IntentKind.RENAME,
  IntentKind.COPY,
]);

const VALID_ENTITY_KINDS: ReadonlySet<string> = new Set(
  ENTITY_REFERENCE_KINDS,
);

// ------------------------------------------------------------------
// Pure input helpers
// ------------------------------------------------------------------

function optionalString(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw ToolError.validation(
      ToolErrorCode.InvalidInput,
      `The "${field}" field must be a string.`,
    );
  }
  return value.length > 0 ? value : undefined;
}

function buildEntityReference(
  fields: {
    kindRaw: string | undefined;
    name: string | undefined;
    location: string | undefined;
    absolutePath: string | undefined;
    description: string | undefined;
  },
  label: string,
): EntityIntentReference | undefined {
  if (
    fields.kindRaw === undefined &&
    fields.name === undefined &&
    fields.location === undefined &&
    fields.absolutePath === undefined &&
    fields.description === undefined
  ) {
    return undefined;
  }

  let kind: EntityReferenceKind = "unknown";
  if (fields.kindRaw !== undefined) {
    if (!VALID_ENTITY_KINDS.has(fields.kindRaw)) {
      throw ToolError.validation(
        ToolErrorCode.InvalidInput,
        `The ${label} kind must be one of: file, folder, any, unknown.`,
      );
    }
    kind = fields.kindRaw as EntityReferenceKind;
  }

  if (fields.absolutePath !== undefined) {
    const validated = validateToolPath(fields.absolutePath);
    if (!validated.ok) throw validated.error;
  }

  return {
    reference: fields.absolutePath !== undefined ? "path" : "semantic",
    kind,
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.location !== undefined ? { location: fields.location } : {}),
    ...(fields.absolutePath !== undefined
      ? { absolutePath: fields.absolutePath }
      : {}),
    ...(fields.description !== undefined
      ? { description: fields.description }
      : {}),
  };
}

function parseSourceReference(
  raw: Record<string, unknown>,
): EntityIntentReference | undefined {
  return buildEntityReference(
    {
      kindRaw: optionalString(raw, "sourceKind"),
      name: optionalString(raw, "sourceName"),
      location: optionalString(raw, "sourceLocation"),
      absolutePath: optionalString(raw, "sourceAbsolutePath"),
      description: optionalString(raw, "sourceDescription"),
    },
    "source",
  );
}

function parseDestinationReference(
  raw: Record<string, unknown>,
): EntityIntentReference | undefined {
  return buildEntityReference(
    {
      kindRaw: optionalString(raw, "destinationKind"),
      name: optionalString(raw, "destinationName"),
      location: optionalString(raw, "destinationLocation"),
      absolutePath: optionalString(raw, "destinationAbsolutePath"),
      description: optionalString(raw, "destinationDescription"),
    },
    "destination",
  );
}

// ------------------------------------------------------------------
// Core plan builder
// ------------------------------------------------------------------

export function buildFileIntentPlan(input: RawToolInput): FileIntentPlan {
  const raw = input as Record<string, unknown>;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw ToolError.validation(
      ToolErrorCode.InvalidInput,
      "The plan input must be an object.",
    );
  }

  const intentResult = requireString(raw, "intent");
  if (!intentResult.ok) throw intentResult.error;
  const intent = intentResult.value;
  if (!VALID_INTENTS.has(intent)) {
    throw ToolError.validation(
      ToolErrorCode.InvalidInput,
      `Unknown intent "${intent}". Supported intents: MOVE, COPY, DELETE, RENAME, SEARCH, ORGANIZE.`,
    );
  }
  const typedIntent = intent as IntentKind;

  const source = parseSourceReference(raw);
  if (source === undefined) {
    throw ToolError.validation(
      ToolErrorCode.InvalidInput,
      "A source reference is required. Provide an absolute path or a natural-language name/location.",
    );
  }

  const destination = parseDestinationReference(raw);

  if (DESTINATION_INTENTS.has(typedIntent) && destination === undefined) {
    throw ToolError.validation(
      ToolErrorCode.InvalidInput,
      `A destination reference is required for the ${typedIntent} intent.`,
    );
  }

  const operationNote = optionalString(raw, "operationNote");
  const operation: Record<string, unknown> =
    operationNote !== undefined ? { note: operationNote } : {};

  if (typedIntent === IntentKind.RENAME) {
    const newName = optionalString(raw, "newName");
    if (newName === undefined) {
      throw ToolError.validation(
        ToolErrorCode.InvalidInput,
        "The RENAME intent requires a newName field with the requested new file name.",
      );
    }
    operation.newName = newName;
  }

  return {
    intent: typedIntent,
    source,
    ...(destination !== undefined ? { destination } : {}),
    operation,
    requiresApproval: WRITE_INTENTS.has(typedIntent),
    supported: SUPPORTED_INTENTS.has(typedIntent),
  };
}

// ------------------------------------------------------------------
// Handler
// ------------------------------------------------------------------

/**
 * The plan_intent handler is entirely deterministic and pure. It reads a
 * flat set of model-populated fields, validates them, builds a nested
 * `FileIntentPlan`, and returns it. No filesystem is touched.
 */
export const planIntentHandler: ToolHandlerFunction<FileIntentPlan> = async (
  input: RawToolInput,
  _ctx,
) => {
  return buildFileIntentPlan(input);
};
