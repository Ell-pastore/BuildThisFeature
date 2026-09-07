/**
 * FilesystemService unit tests (Phase 9.2).
 *
 * The service is the seam between tool handlers and the OS. These tests
 * prove that:
 *   - listDirectory returns structured entries for a real directory;
 *   - searchFiles walks allowed roots and respects the gate;
 *   - getFileMetadata returns metadata without reading contents;
 *   - readFile returns raw bytes gated by the AllowList;
 *   - every method rejects paths outside the allowlist with a structured
 *     FilesystemError, NOT a 500 or a leaked internal exception.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AllowList } from "./allowList.js";
import {
  FilesystemError,
  FilesystemErrorCode,
  FilesystemService,
} from "./filesystemService.js";

let scratch: string;
let service: FilesystemService;

function mkService() {
  const allowList = AllowList.withRoot(path.join(scratch, "home"))!;
  return new FilesystemService({
    allowList,
    homePath: path.join(scratch, "home"),
  });
}

beforeEach(async () => {
  // Canonicalize so paths returned by the service (which are also canonical)
  // match the strings we assert against on macOS where /var → /private/var.
  scratch = realpathSync(
    await fs.mkdtemp(path.join(os.tmpdir(), "filesystemService-")),
  );
  await fs.mkdir(path.join(scratch, "home", "sub"), { recursive: true });
  await fs.writeFile(path.join(scratch, "home", "notes.txt"), "hello world");
  await fs.writeFile(
    path.join(scratch, "home", "sub", "inner.txt"),
    "deep",
  );
  await fs.mkdir(path.join(scratch, "outside"), { recursive: true });
  await fs.writeFile(
    path.join(scratch, "outside", "secret.txt"),
    "private",
  );
  service = mkService();
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("FilesystemService — listDirectory", () => {
  it("returns entries for the listed directory", async () => {
    const listing = await service.listDirectory(
      path.join(scratch, "home"),
    );
    expect(listing.path).toBe(path.join(scratch, "home"));
    const names = listing.items.map((i) => i.name).sort();
    expect(names).toEqual(["notes.txt", "sub"]);
  });

  it("marks the home directory as isHome", async () => {
    const listing = await service.listDirectory(
      path.join(scratch, "home"),
    );
    expect(listing.isHome).toBe(true);
  });

  it("does not mark non-home directories as isHome", async () => {
    const listing = await service.listDirectory(
      path.join(scratch, "home", "sub"),
    );
    expect(listing.isHome).toBe(false);
  });

  it("populates size, modified, created on each entry", async () => {
    const listing = await service.listDirectory(
      path.join(scratch, "home"),
    );
    const file = listing.items.find((i) => i.name === "notes.txt")!;
    expect(file.isFile).toBe(true);
    expect(file.isFolder).toBe(false);
    // "hello world" is 11 bytes — single-digit bytes round to "11 B".
    expect(file.sizeBytes).toBe(11);
    expect(file.size).toBe("11 B");
    expect(typeof file.modified).toBe("string");
    expect(typeof file.created).toBe("string");
    expect(file.modifiedTs).toBeGreaterThan(0);
  });

  it("rejects paths outside the allowlist", async () => {
    await expect(
      service.listDirectory(path.join(scratch, "outside")),
    ).rejects.toMatchObject({ code: FilesystemErrorCode.NotAllowed });
  });

  it("rejects traversal that lands outside the allowlist", async () => {
    const escape = path.join(scratch, "home", "..", "outside");
    await expect(service.listDirectory(escape)).rejects.toMatchObject({
      code: FilesystemErrorCode.NotAllowed,
    });
  });

  it("rejects non-directory targets", async () => {
    await expect(
      service.listDirectory(path.join(scratch, "home", "notes.txt")),
    ).rejects.toMatchObject({ code: FilesystemErrorCode.NotADirectory });
  });

  it("rejects empty paths", async () => {
    await expect(service.listDirectory("")).rejects.toMatchObject({
      code: FilesystemErrorCode.InvalidPath,
    });
  });

  it("rejects non-existent paths", async () => {
    await expect(
      service.listDirectory(path.join(scratch, "home", "nope")),
    ).rejects.toMatchObject({ code: FilesystemErrorCode.NotFound });
  });
});

describe("FilesystemService — searchFiles", () => {
  it("finds files by case-insensitive substring match", async () => {
    const results = await service.searchFiles("NOTES");
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("notes.txt");
  });

  it("finds files in nested directories", async () => {
    const results = await service.searchFiles("inner");
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("inner.txt");
  });

  it("returns no results for an empty query", async () => {
    expect(await service.searchFiles("")).toEqual([]);
    expect(await service.searchFiles("   ")).toEqual([]);
  });

  it("does not return files outside the allowlist", async () => {
    const results = await service.searchFiles("secret");
    expect(results).toEqual([]);
  });

  it("returns sorted results (deterministic ordering)", async () => {
    await fs.writeFile(path.join(scratch, "home", "a.txt"), "a");
    await fs.writeFile(path.join(scratch, "home", "b.txt"), "b");
    const results = await service.searchFiles(".txt");
    const paths = results.map((r) => r.path);
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });
});

describe("FilesystemService — getFileMetadata", () => {
  it("returns metadata for a file", async () => {
    const meta = await service.getFileMetadata(
      path.join(scratch, "home", "notes.txt"),
    );
    expect(meta.name).toBe("notes.txt");
    expect(meta.isFile).toBe(true);
    expect(meta.isFolder).toBe(false);
    expect(meta.sizeBytes).toBe("hello world".length);
    expect(meta.extension).toBe("txt");
    expect(meta.isHidden).toBe(false);
  });

  it("returns metadata for a directory", async () => {
    const meta = await service.getFileMetadata(
      path.join(scratch, "home", "sub"),
    );
    expect(meta.isFolder).toBe(true);
    expect(meta.isFile).toBe(false);
    expect(meta.extension).toBeNull();
    expect(meta.sizeBytes).toBe(0);
  });

  it("marks hidden files", async () => {
    await fs.writeFile(path.join(scratch, "home", ".env"), "x");
    const meta = await service.getFileMetadata(
      path.join(scratch, "home", ".env"),
    );
    expect(meta.isHidden).toBe(true);
  });

  it("rejects paths outside the allowlist", async () => {
    await expect(
      service.getFileMetadata(
        path.join(scratch, "outside", "secret.txt"),
      ),
    ).rejects.toMatchObject({ code: FilesystemErrorCode.NotAllowed });
  });

  it("rejects non-existent paths", async () => {
    await expect(
      service.getFileMetadata(path.join(scratch, "home", "nope.txt")),
    ).rejects.toMatchObject({ code: FilesystemErrorCode.NotFound });
  });
});

describe("FilesystemService — readFile", () => {
  it("returns the raw bytes of a file", async () => {
    const buffer = await service.readFile(
      path.join(scratch, "home", "notes.txt"),
    );
    expect(buffer.toString("utf8")).toBe("hello world");
  });

  it("rejects paths outside the allowlist", async () => {
    await expect(
      service.readFile(path.join(scratch, "outside", "secret.txt")),
    ).rejects.toMatchObject({ code: FilesystemErrorCode.NotAllowed });
  });

  it("rejects directories", async () => {
    await expect(
      service.readFile(path.join(scratch, "home", "sub")),
    ).rejects.toMatchObject({ code: FilesystemErrorCode.NotAFile });
  });

  it("rejects non-existent files", async () => {
    await expect(
      service.readFile(path.join(scratch, "home", "nope.txt")),
    ).rejects.toMatchObject({ code: FilesystemErrorCode.NotFound });
  });

  it("rejects files larger than the configured maxBytes", async () => {
    const bigPath = path.join(scratch, "home", "big.bin");
    await fs.writeFile(bigPath, Buffer.alloc(1024, 0xab));
    await expect(
      service.readFile(bigPath, { maxBytes: 16 }),
    ).rejects.toMatchObject({ code: FilesystemErrorCode.IoError });
  });
});

describe("FilesystemService — error type guard", () => {
  it("FilesystemError has the correct name and code", async () => {
    let caught: unknown;
    try {
      await service.readFile(path.join(scratch, "home", "nope"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilesystemError);
    expect((caught as FilesystemError).code).toBe(
      FilesystemErrorCode.NotFound,
    );
  });
});

