/**
 * Tool handler / dispatch / bridge tests (Phase 9.3).
 *
 * Every test runs with a FakeFilesystemExecutor — no LLM, no Tauri, no
 * Node `fs`. The fake records every call so we can assert the bridge
 * passes inputs through unchanged and returns the executor's data
 * unchanged. Errors thrown by the executor are projected through the
 * bridge's `toAppError` so we can assert the public envelope.
 *
 * The full chain under test:
 *
 *   dispatchTool(registry, name, input, { filesystem: fake })
 *     -> registry.get(name)                          [Phase 9.1 gate]
 *     -> handlers[name](input, ctx)                   [Phase 9.3 bridge]
 *     -> requireString(input, field)                  [Phase 9.3 validation]
 *     -> fake.listDirectory|searchFiles|...           [Phase 9.3 executor]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../registry.js";
import {
  readToolDefinitions,
  registerReadTools,
} from "../definitions/readTools.js";
import { dispatchTool, handlers, handledToolNames } from "./index.js";
import { requireString } from "./handler.js";
import type { FilesystemExecutor } from "../executor.js";
import type {
  DirectoryListing,
  FileEntry,
  FileMetadata,
} from "../tauriShapes.js";

interface FakeOptions {
  listDirectory?: DirectoryListing;
  searchFiles?: FileEntry[];
  getFileMetadata?: FileMetadata;
  readFile?: { encoding: "base64"; data: string };
}

interface FakeErrorOptions {
  listDirectory?: Error;
  searchFiles?: Error;
  getFileMetadata?: Error;
  readFile?: Error;
}

interface Fake extends FilesystemExecutor {
  calls: {
    listDirectory: string[];
    searchFiles: string[];
    getFileMetadata: string[];
    readFile: string[];
  };
  respondWith: FakeOptions;
  throwFor: FakeErrorOptions;
}

function makeFake(): Fake {
  const calls = {
    listDirectory: [] as string[],
    searchFiles: [] as string[],
    getFileMetadata: [] as string[],
    readFile: [] as string[],
  };
  const respondWith: FakeOptions = {};
  const throwFor: FakeErrorOptions = {};
  const fake: Fake = {
    calls,
    respondWith,
    throwFor,
    async listDirectory(path: string) {
      calls.listDirectory.push(path);
      if (throwFor.listDirectory) throw throwFor.listDirectory;
      if (respondWith.listDirectory) return respondWith.listDirectory;
      return { path, parentPath: null, isHome: false, items: [] };
    },
    async searchFiles(query: string) {
      calls.searchFiles.push(query);
      if (throwFor.searchFiles) throw throwFor.searchFiles;
      if (respondWith.searchFiles) return respondWith.searchFiles;
      return [];
    },
    async getFileMetadata(path: string) {
      calls.getFileMetadata.push(path);
      if (throwFor.getFileMetadata) throw throwFor.getFileMetadata;
      if (respondWith.getFileMetadata) return respondWith.getFileMetadata;
      return {
        name: path,
        path,
        isFile: true,
        isFolder: false,
        sizeBytes: 0,
        extension: null,
        isHidden: false,
        modified: "\u2014",
        modifiedTs: 0,
        created: "\u2014",
        createdTs: 0,
        accessed: null,
        accessedTs: null,
      };
    },
    async readFile(path: string) {
      calls.readFile.push(path);
      if (throwFor.readFile) throw throwFor.readFile;
      if (respondWith.readFile) return respondWith.readFile;
      return { encoding: "base64", data: "" };
    },
  };
  return fake;
}

let registry: ToolRegistry;
let fake: Fake;

function makeContext() {
  return { filesystem: fake };
}

beforeEach(() => {
  fake = makeFake();
  registry = new ToolRegistry();
  registerReadTools(registry);
});

afterEach(() => {
  vi.restoreAllMocks();
});


// ---------------------------------------------------------------------------
// requireString (input validation)
// ---------------------------------------------------------------------------

describe("requireString", () => {
  it("returns the value when the field is a non-empty string", () => {
    const result = requireString({ path: "/tmp" }, "path");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("/tmp");
  });

  it("rejects missing fields", () => {
    const result = requireString({}, "path");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("common/bad-request");
      expect(result.error.status).toBe(400);
    }
  });

  it("rejects non-string values", () => {
    expect(requireString({ path: 42 }, "path").ok).toBe(false);
    expect(requireString({ path: [] }, "path").ok).toBe(false);
    expect(requireString({ path: {} }, "path").ok).toBe(false);
    expect(requireString({ path: null }, "path").ok).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(requireString({ path: "" }, "path").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

describe("list_directory handler", () => {
  it("delegates to the executor and returns its data", async () => {
    const canned: DirectoryListing = {
      path: "/home",
      parentPath: null,
      isHome: true,
      items: [
        {
          id: "/home/a.txt",
          name: "a.txt",
          path: "/home/a.txt",
          isFolder: false,
          sizeBytes: 4,
          itemCount: null,
          fileType: "txt",
          size: "4 B",
          created: "Jan 1, 2026",
          modified: "Jan 1, 2026",
          modifiedTs: 1,
          createdTs: 1,
        },
      ],
    };
    fake.respondWith.listDirectory = canned;
    const result = await handlers.list_directory(
      { path: "/home" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data).toEqual(canned);
    expect(fake.calls.listDirectory).toEqual(["/home"]);
  });

  it("rejects a missing path field", async () => {
    const result = await handlers.list_directory({}, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("common/bad-request");
    expect(fake.calls.listDirectory).toEqual([]);
  });

  it("rejects a non-string path", async () => {
    const result = await handlers.list_directory(
      { path: 42 },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("common/bad-request");
    expect(fake.calls.listDirectory).toEqual([]);
  });

  it("projects an executor 'not found' error to the public envelope", async () => {
    fake.throwFor.listDirectory = new Error(
      "The file or folder does not exist.",
    );
    const result = await handlers.list_directory(
      { path: "/missing" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("filesystem/not-found");
    expect(result.error.status).toBe(404);
  });

  it("projects an executor 'permission denied' error", async () => {
    fake.throwFor.listDirectory = new Error("Permission denied.");
    const result = await handlers.list_directory(
      { path: "/locked" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("filesystem/permission-denied");
    expect(result.error.status).toBe(403);
  });

  it("projects an unknown executor error without leaking internals", async () => {
    // Production-shaped error: the Rust service returns user-safe English
    // strings on failure. We project the "does not exist" shape to
    // filesystem/not-found and the public message is the same user-safe
    // text. Any internal detail would be a regression.
    fake.throwFor.listDirectory = new Error(
      "The file or folder does not exist.",
    );
    const result = await handlers.list_directory(
      { path: "/etc" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("filesystem/not-found");
    // No internal detail leaks.
    expect(result.error.message).not.toContain("ENOENT");
    expect(result.error.message).not.toContain("/etc/shadow");
  });
});

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

describe("search_files handler", () => {
  it("delegates to the executor and returns its data", async () => {
    const canned: FileEntry[] = [
      {
        id: "/home/notes.txt",
        name: "notes.txt",
        path: "/home/notes.txt",
        isFolder: false,
        sizeBytes: 4,
        itemCount: null,
        fileType: "txt",
        size: "4 B",
        created: "Jan 1, 2026",
        modified: "Jan 1, 2026",
        modifiedTs: 1,
        createdTs: 1,
      },
    ];
    fake.respondWith.searchFiles = canned;
    const result = await handlers.search_files(
      { query: "notes" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data).toEqual(canned);
    expect(fake.calls.searchFiles).toEqual(["notes"]);
  });

  it("rejects a missing query field", async () => {
    const result = await handlers.search_files({}, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("common/bad-request");
    expect(fake.calls.searchFiles).toEqual([]);
  });

  it("rejects an empty query", async () => {
    const result = await handlers.search_files({ query: "" }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("common/bad-request");
  });

  it("rejects a non-string query", async () => {
    const result = await handlers.search_files({ query: 42 }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("common/bad-request");
  });

  it("projects an executor 'not allowed' error", async () => {
    fake.throwFor.searchFiles = new Error(
      "Access to this path is not permitted.",
    );
    const result = await handlers.search_files(
      { query: "secret" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("filesystem/not-allowed");
    expect(result.error.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// get_file_metadata
// ---------------------------------------------------------------------------

describe("get_file_metadata handler", () => {
  it("delegates to the executor and returns its data", async () => {
    const canned: FileMetadata = {
      name: "notes.txt",
      path: "/home/notes.txt",
      isFile: true,
      isFolder: false,
      sizeBytes: 12,
      extension: "txt",
      isHidden: false,
      modified: "Jan 1, 2026",
      modifiedTs: 1,
      created: "Jan 1, 2026",
      createdTs: 1,
      accessed: null,
      accessedTs: null,
    };
    fake.respondWith.getFileMetadata = canned;
    const result = await handlers.get_file_metadata(
      { path: "/home/notes.txt" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data).toEqual(canned);
    expect(fake.calls.getFileMetadata).toEqual(["/home/notes.txt"]);
  });

  it("rejects a missing path field", async () => {
    const result = await handlers.get_file_metadata({}, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("common/bad-request");
  });

  it("rejects a non-string path", async () => {
    const result = await handlers.get_file_metadata(
      { path: 42 },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("common/bad-request");
  });

  it("projects an executor 'not found' error", async () => {
    fake.throwFor.getFileMetadata = new Error(
      "The file or folder does not exist.",
    );
    const result = await handlers.get_file_metadata(
      { path: "/nope" },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("filesystem/not-found");
  });
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe("read_file handler", () => {
  it("delegates to the executor and returns its base64 output", async () => {
    fake.respondWith.readFile = {
      encoding: "base64",
      data: Buffer.from("hello world", "utf8").toString("base64"),
    };
    const result = await handlers.read_file(
      { path: "/home/notes.txt" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data.encoding).toBe("base64");
    expect(Buffer.from(result.data.data, "base64").toString("utf8")).toBe(
      "hello world",
    );
    expect(fake.calls.readFile).toEqual(["/home/notes.txt"]);
  });

  it("rejects a missing path field", async () => {
    const result = await handlers.read_file({}, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("common/bad-request");
  });

  it("rejects a non-string path", async () => {
    const result = await handlers.read_file({ path: [] }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("common/bad-request");
  });

  it("projects an executor 'not a file' error", async () => {
    fake.throwFor.readFile = new Error(
      "The selected path is a folder, not a file.",
    );
    const result = await handlers.read_file({ path: "/home" }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("filesystem/not-a-file");
  });
});


// ---------------------------------------------------------------------------
// dispatchTool
// ---------------------------------------------------------------------------

describe("dispatchTool", () => {
  it("routes list_directory to the correct handler", async () => {
    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: "/home" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(fake.calls.listDirectory).toEqual(["/home"]);
  });

  it("routes search_files to the correct handler", async () => {
    const result = await dispatchTool(
      registry,
      "search_files",
      { query: "notes" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(fake.calls.searchFiles).toEqual(["notes"]);
  });

  it("routes get_file_metadata to the correct handler", async () => {
    const result = await dispatchTool(
      registry,
      "get_file_metadata",
      { path: "/home/notes.txt" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(fake.calls.getFileMetadata).toEqual(["/home/notes.txt"]);
  });

  it("routes read_file to the correct handler", async () => {
    const result = await dispatchTool(
      registry,
      "read_file",
      { path: "/home/notes.txt" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    expect(fake.calls.readFile).toEqual(["/home/notes.txt"]);
  });

  it("returns a structured failure for an unknown tool name", async () => {
    const result = await dispatchTool(
      registry,
      "non_existent_tool",
      {},
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("tools/unknown-tool");
    expect(result.error.status).toBe(400);
    expect(fake.calls).toEqual({
      listDirectory: [],
      searchFiles: [],
      getFileMetadata: [],
      readFile: [],
    });
  });
});


// ---------------------------------------------------------------------------
// Registry: read tools are correctly registered
// ---------------------------------------------------------------------------

describe("read tools — registry", () => {
  const toolNames = [
    "list_directory",
    "search_files",
    "get_file_metadata",
    "read_file",
  ];

  it("all four tools are registered", () => {
    expect(registry.size).toBe(4);
  });

  it.each(toolNames)("tool '%s' is registered", (name) => {
    expect(registry.get(name)).toBeDefined();
  });

  it.each(toolNames)("tool '%s' has the correct exact name", (name) => {
    expect(registry.get(name).name).toBe(name);
  });

  it.each(toolNames)("tool '%s' has a non-empty description", (name) => {
    expect(registry.get(name).description.length).toBeGreaterThan(10);
  });

  it.each(toolNames)("tool '%s' has the read permission", (name) => {
    expect(registry.get(name).permission).toBe("read");
  });

  it("handledToolNames lists all four tools", () => {
    expect(handledToolNames).toEqual(toolNames);
  });

  it("handlers map has entries for all four tools", () => {
    for (const name of toolNames) {
      expect(
        (handlers as unknown as Record<string, unknown>)[name],
      ).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Definitions export the same four tools the bridge handles
// ---------------------------------------------------------------------------

describe("definitions ↔ handlers wiring", () => {
  it("readToolDefinitions has the same names as handledToolNames", () => {
    const definedNames = readToolDefinitions.map((d) => d.name).sort();
    const handled = [...handledToolNames].sort();
    expect(handled).toEqual(definedNames);
  });

  it("every defined tool has a matching handler", () => {
    const handlerMap = handlers as unknown as Record<string, unknown>;
    for (const def of readToolDefinitions) {
      expect(handlerMap[def.name]).toBeDefined();
    }
  });

  it("every defined tool declares the read permission", () => {
    for (const def of readToolDefinitions) {
      expect(def.permission).toBe("read");
    }
  });
});

