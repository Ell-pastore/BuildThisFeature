/**
 * Tool handler integration tests (Phase 9.2).
 *
 * These tests prove the tool layer delegates to the FilesystemService correctly.
 * The service layer uses real temp directories so the full call chain
 * (tool → handler → service → AllowList → fs) is exercised.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ToolRegistry } from "../registry.js";
import { registerReadTools } from "../definitions/readTools.js";
import { dispatchTool, handlers, handledToolNames } from "./index.js";
import { FilesystemService } from "../../services/filesystem/filesystemService.js";
import { AllowList } from "../../services/filesystem/allowList.js";
import { requireString } from "./handler.js";

let scratch: string;
let service: FilesystemService;
let registry: ToolRegistry;

function makeContext() {
  return { filesystem: service };
}

beforeEach(async () => {
  // Canonicalize so paths returned by the service (which are also canonical)
  // match the strings we assert against on macOS where /var → /private/var.
  scratch = realpathSync(
    await fs.mkdtemp(path.join(os.tmpdir(), "handlers-test-")),
  );
  await fs.mkdir(path.join(scratch, "home", "sub"), { recursive: true });
  await fs.writeFile(path.join(scratch, "home", "notes.txt"), "hello world");
  await fs.writeFile(path.join(scratch, "home", "sub", "inner.txt"), "deep");
  await fs.mkdir(path.join(scratch, "outside"), { recursive: true });
  await fs.writeFile(
    path.join(scratch, "outside", "secret.txt"),
    "private",
  );

  const allowList = AllowList.withRoot(path.join(scratch, "home"))!;
  service = new FilesystemService({
    allowList,
    homePath: path.join(scratch, "home"),
  });

  registry = new ToolRegistry();
  registerReadTools(registry);
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("requireString", () => {
  it("returns the value when the field is a non-empty string", () => {
    const result = requireString({ path: "/tmp" }, "path");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("/tmp");
  });

  it("rejects missing fields", () => {
    const result = requireString({}, "path");
    expect(result.ok).toBe(false);
  });

  it("rejects non-string values", () => {
    const result = requireString({ path: 42 }, "path");
    expect(result.ok).toBe(false);
  });

  it("rejects empty strings", () => {
    const result = requireString({ path: "" }, "path");
    expect(result.ok).toBe(false);
  });

  it("rejects arrays", () => {
    const result = requireString({ path: [] }, "path");
    expect(result.ok).toBe(false);
  });

  it("rejects objects", () => {
    const result = requireString({ path: {} }, "path");
    expect(result.ok).toBe(false);
  });
});

describe("list_directory handler", () => {
  it("returns a DirectoryListing for a valid path", async () => {
    const result = await handlers.list_directory(
      { path: path.join(scratch, "home") },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data.items.map((i) => i.name).sort()).toEqual([
      "notes.txt",
      "sub",
    ]);
  });

  it("rejects a non-directory path", async () => {
    const result = await handlers.list_directory(
      { path: path.join(scratch, "home", "notes.txt") },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("filesystem/not-a-directory");
  });

  it("rejects a path outside the allowlist", async () => {
    const result = await handlers.list_directory(
      { path: path.join(scratch, "outside") },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("filesystem/not-allowed");
  });

  it("rejects a missing path field", async () => {
    const result = await handlers.list_directory({}, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("tools/invalid-input");
  });

  it("rejects a non-string path", async () => {
    const result = await handlers.list_directory(
      { path: 42 },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("tools/invalid-input");
  });
});

describe("search_files handler", () => {
  it("returns matching results for a valid query", async () => {
    const result = await handlers.search_files(
      { query: "notes" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.some((r) => r.name === "notes.txt")).toBe(true);
  });

  it("rejects an empty query (treated as missing input)", async () => {
    const result = await handlers.search_files({ query: "" }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("tools/invalid-input");
  });

  it("does not return files outside the allowlist", async () => {
    const result = await handlers.search_files(
      { query: "secret" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data).toEqual([]);
  });

  it("rejects a missing query field", async () => {
    const result = await handlers.search_files({}, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("tools/invalid-input");
  });

  it("rejects a non-string query", async () => {
    const result = await handlers.search_files({ query: 42 }, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("tools/invalid-input");
  });
});

describe("get_file_metadata handler", () => {
  it("returns FileMetadata for a file", async () => {
    const result = await handlers.get_file_metadata(
      { path: path.join(scratch, "home", "notes.txt") },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data.name).toBe("notes.txt");
    expect(result.data.isFile).toBe(true);
    expect(result.data.sizeBytes).toBe("hello world".length);
  });

  it("returns FileMetadata for a directory", async () => {
    const result = await handlers.get_file_metadata(
      { path: path.join(scratch, "home", "sub") },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data.isFolder).toBe(true);
    expect(result.data.isFile).toBe(false);
  });

  it("rejects a path outside the allowlist", async () => {
    const result = await handlers.get_file_metadata(
      { path: path.join(scratch, "outside", "secret.txt") },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("filesystem/not-allowed");
  });

  it("rejects a non-existent path", async () => {
    const result = await handlers.get_file_metadata(
      { path: path.join(scratch, "home", "nope.txt") },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("filesystem/not-found");
  });

  it("rejects a missing path field", async () => {
    const result = await handlers.get_file_metadata({}, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("tools/invalid-input");
  });
});

describe("read_file handler", () => {
  it("returns base64-encoded content for a valid file", async () => {
    const result = await handlers.read_file(
      { path: path.join(scratch, "home", "notes.txt") },
      makeContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data.encoding).toBe("base64");
    const decoded = Buffer.from(result.data.data, "base64").toString("utf8");
    expect(decoded).toBe("hello world");
  });

  it("rejects a directory", async () => {
    const result = await handlers.read_file(
      { path: path.join(scratch, "home", "sub") },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("filesystem/not-a-file");
  });

  it("rejects a path outside the allowlist", async () => {
    const result = await handlers.read_file(
      { path: path.join(scratch, "outside", "secret.txt") },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("filesystem/not-allowed");
  });

  it("rejects a missing path field", async () => {
    const result = await handlers.read_file({}, makeContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("tools/invalid-input");
  });
});


describe("dispatchTool", () => {
  it("routes list_directory to the correct handler", async () => {
    const result = await dispatchTool(
      registry,
      "list_directory",
      { path: path.join(scratch, "home") },
      makeContext(),
    );
    expect(result.ok).toBe(true);
  });

  it("routes search_files to the correct handler", async () => {
    const result = await dispatchTool(
      registry,
      "search_files",
      { query: "notes" },
      makeContext(),
    );
    expect(result.ok).toBe(true);
  });

  it("routes get_file_metadata to the correct handler", async () => {
    const result = await dispatchTool(
      registry,
      "get_file_metadata",
      { path: path.join(scratch, "home", "notes.txt") },
      makeContext(),
    );
    expect(result.ok).toBe(true);
  });

  it("routes read_file to the correct handler", async () => {
    const result = await dispatchTool(
      registry,
      "read_file",
      { path: path.join(scratch, "home", "notes.txt") },
      makeContext(),
    );
    expect(result.ok).toBe(true);
  });

  it("returns a failure for an unknown tool name", async () => {
    const result = await dispatchTool(
      registry,
      "non_existent_tool",
      {},
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("tools/unknown-tool");
  });
});

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
      // handlers is an exact-keyed object, so we narrow for the test loop.
      expect((handlers as Record<string, unknown>)[name]).toBeDefined();
    }
  });
});

