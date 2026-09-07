/**
 * AllowList unit tests — basic behavior (Phase 9.2).
 *
 * Covers: empty registry, `withRoot`, `registerRoot`, `isAllowed` (allow/deny),
 * `tryCanonicalize`, `fromCanonicalRoots`, idempotency.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AllowList } from "./allowList.js";

let scratch: string;

beforeEach(async () => {
  // mkdtemp may return a path that contains symlinks (e.g. /var → /private/var
  // on macOS). Canonicalize so the rest of the test suite can use scratch
  // interchangeably with the canonical form returned by AllowList.
  scratch = realpathSync(
    await fs.mkdtemp(path.join(os.tmpdir(), "allowList-")),
  );
  await fs.mkdir(path.join(scratch, "root", "child"), { recursive: true });
  await fs.mkdir(path.join(scratch, "outside"), { recursive: true });
  await fs.writeFile(path.join(scratch, "root", "child", "file.txt"), "hi");
  await fs.writeFile(path.join(scratch, "outside", "secret.txt"), "no");
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("AllowList — empty registry", () => {
  it("denies every path (fail closed)", () => {
    const list = AllowList.empty();
    expect(list.length).toBe(0);
    expect(list.isAllowed("/anything")).toBe(false);
    expect(list.isAllowed("/")).toBe(false);
  });

  it("getRoots returns an empty snapshot", () => {
    expect(AllowList.empty().getRoots()).toEqual([]);
  });
});

describe("AllowList — withRoot", () => {
  it("canonicalizes and stores a real directory", () => {
    const list = AllowList.withRoot(path.join(scratch, "root"));
    expect(list).not.toBeNull();
    expect(list!.length).toBe(1);
    expect(list!.getRoots()[0]).toBe(
      realpathSync(path.join(scratch, "root")),
    );
  });

  it("returns null for a non-existent path", () => {
    expect(
      AllowList.withRoot(path.join(scratch, "does-not-exist")),
    ).toBeNull();
  });

  it("returns null for a file (not a directory)", async () => {
    const file = path.join(scratch, "root", "child", "file.txt");
    expect(AllowList.withRoot(file)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(AllowList.withRoot("")).toBeNull();
  });
});

describe("AllowList — isAllowed", () => {
  it("allows the registered root", () => {
    const list = AllowList.withRoot(path.join(scratch, "root"))!;
    expect(list.isAllowed(list.getRoots()[0]!)).toBe(true);
  });

  it("allows a strict descendant", () => {
    const list = AllowList.withRoot(path.join(scratch, "root"))!;
    const child = path.join(list.getRoots()[0]!, "child", "file.txt");
    expect(list.isAllowed(child)).toBe(true);
  });

  it("denies a sibling (component-aware boundary)", async () => {
    const list = AllowList.withRoot(path.join(scratch, "root"))!;
    const sibling = path.join(scratch, "rootSibling", "child", "file.txt");
    await fs.mkdir(path.dirname(sibling), { recursive: true });
    await fs.writeFile(sibling, "x");
    expect(list.isAllowed(sibling)).toBe(false);
  });

  it("denies a path outside the registry", () => {
    const list = AllowList.withRoot(path.join(scratch, "root"))!;
    expect(
      list.isAllowed(path.join(scratch, "outside", "secret.txt")),
    ).toBe(false);
  });
});

describe("AllowList — registerRoot", () => {
  it("adds a new canonical root", () => {
    const list = AllowList.empty();
    expect(list.registerRoot(path.join(scratch, "root"))).toBe(true);
    expect(list.length).toBe(1);
  });

  it("returns false for a non-directory", async () => {
    const list = AllowList.empty();
    const file = path.join(scratch, "root", "child", "file.txt");
    expect(list.registerRoot(file)).toBe(false);
    expect(list.length).toBe(0);
  });

  it("is idempotent — duplicate canonical roots are ignored", () => {
    const list = AllowList.empty();
    expect(list.registerRoot(path.join(scratch, "root"))).toBe(true);
    expect(list.registerRoot(path.join(scratch, "root"))).toBe(false);
    expect(list.length).toBe(1);
  });
});

describe("AllowList — getRoots", () => {
  it("returns a snapshot that does not affect the registry", () => {
    const list = AllowList.withRoot(path.join(scratch, "root"))!;
    const roots = list.getRoots();
    // Mutating the snapshot in any way must not change the registry.
    (roots as string[]).push("/evil");
    expect(list.length).toBe(1);
    expect(list.getRoots()).not.toContain("/evil");
  });

  it("returns a fresh array on each call", () => {
    const list = AllowList.withRoot(path.join(scratch, "root"))!;
    const a = list.getRoots();
    const b = list.getRoots();
    expect(a).not.toBe(b);
  });
});

describe("AllowList — tryCanonicalize", () => {
  it("returns realpath for an existing path", () => {
    const canonical = AllowList.tryCanonicalize(
      path.join(scratch, "root", "child", "file.txt"),
    );
    expect(canonical).toBe(
      path.join(scratch, "root", "child", "file.txt"),
    );
  });

  it("returns null for a non-existent path", () => {
    expect(
      AllowList.tryCanonicalize(path.join(scratch, "does-not-exist")),
    ).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(AllowList.tryCanonicalize("")).toBeNull();
  });
});

describe("AllowList — fromCanonicalRoots", () => {
  it("deduplicates", () => {
    const root = realpathSync(path.join(scratch, "root"));
    const list = AllowList.fromCanonicalRoots([root, root, root]);
    expect(list.length).toBe(1);
  });

  it("stores the canonical path", () => {
    const list = AllowList.fromCanonicalRoots([
      path.join(scratch, "root"),
    ]);
    expect(list.getRoots()[0]).toBe(
      realpathSync(path.join(scratch, "root")),
    );
  });
});

