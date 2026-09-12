import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { DesktopFilesystemProvider } from "./desktop";

/** Raw `DirEntryResponse` shape serialized by Rust for a group member. */
function rawEntry(
  name: string,
  path: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: path,
    name,
    path,
    isFolder: false,
    sizeBytes: 13,
    itemCount: null,
    fileType: "txt",
    size: "13 B",
    created: "Sep 1, 2026",
    modified: "Sep 1, 2026",
    modifiedTs: 1000,
    createdTs: 1000,
    ...overrides,
  };
}

const a = rawEntry("a.txt", "/home/docs/a.txt");
const b = rawEntry("b.txt", "/home/docs/b.txt");
const c = rawEntry("c.txt", "/home/docs/c.txt");

describe("DesktopFilesystemProvider.duplicateGroups", () => {
  it("invokes duplicate_groups with no arguments", async () => {
    invoke.mockResolvedValue({ groups: [], truncated: false });

    await new DesktopFilesystemProvider().duplicateGroups();

    expect(invoke).toHaveBeenCalledWith("duplicate_groups");
  });

  it("maps groups and truncated exactly as returned by Rust", async () => {
    invoke.mockResolvedValue({
      groups: [
        {
          id: "/home/docs/a.txt",
          sizeBytes: 13,
          size: "13 B",
          items: [a, b],
        },
      ],
      truncated: true,
    });

    const result = await new DesktopFilesystemProvider().duplicateGroups();

    // Group-level fields and the truncation flag pass through unchanged.
    expect(result.truncated).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      id: "/home/docs/a.txt",
      sizeBytes: 13,
      size: "13 B",
    });

    // Members are mapped into the shared FileItem model, keeping order.
    expect(result.groups[0].items).toHaveLength(2);
    expect(result.groups[0].items[0]).toMatchObject({
      id: "/home/docs/a.txt",
      name: "a.txt",
      type: "txt",
      sizeBytes: 13,
      location: "/home/docs",
      path: "/home/docs/a.txt",
      starred: false,
    });
    expect(result.groups[0].items[1].id).toBe("/home/docs/b.txt");
  });

  it("preserves an untruncated empty result", async () => {
    invoke.mockResolvedValue({ groups: [], truncated: false });

    const result = await new DesktopFilesystemProvider().duplicateGroups();

    expect(result.truncated).toBe(false);
    expect(result.groups).toEqual([]);
  });

  it("keeps all groups and the member order returned by Rust", async () => {
    invoke.mockResolvedValue({
      groups: [
        { id: "/home/docs/a.txt", sizeBytes: 13, size: "13 B", items: [a, c, b] },
        { id: "/home/docs/x.jpg", sizeBytes: 9, size: "9 B", items: [] },
      ],
      truncated: true,
    });

    const result = await new DesktopFilesystemProvider().duplicateGroups();

    expect(result.groups.map((g) => g.id)).toEqual([
      "/home/docs/a.txt",
      "/home/docs/x.jpg",
    ]);
    expect(result.groups[0].items.map((i) => i.id)).toEqual([
      "/home/docs/a.txt",
      "/home/docs/c.txt",
      "/home/docs/b.txt",
    ]);
    expect(result.truncated).toBe(true);
  });
});

describe("DesktopFilesystemProvider.permanentlyDeleteTrashItem", () => {
  it("invokes permanently_delete_trash_item with the trashed path", async () => {
    invoke.mockResolvedValue("/home/.trash-smart-file-manager/report.pdf");

    const deleted =
      await new DesktopFilesystemProvider().permanentlyDeleteTrashItem(
        "/home/.trash-smart-file-manager/report.pdf",
      );

    expect(invoke).toHaveBeenCalledWith("permanently_delete_trash_item", {
      trashedPath: "/home/.trash-smart-file-manager/report.pdf",
    });
    expect(deleted).toBe("/home/.trash-smart-file-manager/report.pdf");
  });

  it("propagates the Rust denial or error unchanged", async () => {
    invoke.mockRejectedValue(new Error("Not a trash entry"));

    await expect(
      new DesktopFilesystemProvider().permanentlyDeleteTrashItem(
        "/home/.trash-smart-file-manager/report.pdf",
      ),
    ).rejects.toThrow("Not a trash entry");
  });
});