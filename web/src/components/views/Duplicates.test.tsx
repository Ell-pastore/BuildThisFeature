import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DuplicateGroupsResult, FilesystemProvider } from "../../services/filesystem";

const getFilesystemProvider = vi.hoisted(() => vi.fn());

vi.mock("../../services/filesystem", () => ({
  getFilesystemProvider,
}));

import Duplicates from "./Duplicates";

function fileItem(name: string, path: string) {
  return {
    id: path,
    name,
    type: name.includes(".jpg") ? "jpg" : "txt",
    size: "13 B",
    sizeBytes: 13,
    modified: "Sep 1, 2026",
    created: "Sep 1, 2026",
    modifiedTs: 1000,
    createdTs: 1000,
    location: "/home/docs",
    path,
    starred: false,
    isFolder: false,
    itemCount: 0,
  };
}

function groupResult(overrides: Partial<DuplicateGroupsResult> = {}): DuplicateGroupsResult {
  return {
    groups: [
      {
        id: "/home/docs/z.txt",
        sizeBytes: 13,
        size: "13 B",
        items: [fileItem("z.txt", "/home/docs/z.txt"), fileItem("a.txt", "/home/docs/a.txt")],
      },
    ],
    truncated: false,
    ...overrides,
  };
}

function providerReturning(result: DuplicateGroupsResult) {
  const provider = { duplicateGroups: vi.fn().mockResolvedValue(result) };
  getFilesystemProvider.mockReturnValue(provider);
  return provider;
}

describe("Duplicates", () => {
  afterEach(cleanup);

  it("shows an honest loading state while the scan is in flight", () => {
    const provider = { duplicateGroups: vi.fn(() => new Promise(() => {})) };
    getFilesystemProvider.mockReturnValue(provider);

    render(<Duplicates />);

    expect(screen.getByText("Scanning your files…")).toBeInTheDocument();
    expect(
      screen.getByText("Hashing size-matched files across your allowed folders."),
    ).toBeInTheDocument();
    expect(provider.duplicateGroups).toHaveBeenCalledTimes(1);
  });

  it("renders real duplicate groups, preserving provider ordering exactly", async () => {
    const provider = providerReturning(
      groupResult({
        groups: [
          {
            id: "/home/docs/z.txt",
            sizeBytes: 13,
            size: "13 B",
            // Deliberately NOT alphabetical: the view must show provider order.
            items: [
              fileItem("z.txt", "/home/docs/z.txt"),
              fileItem("a.txt", "/home/docs/a.txt"),
            ],
          },
          {
            id: "/home/docs/q.jpg",
            sizeBytes: 9,
            size: "9 B",
            items: [fileItem("q.jpg", "/home/docs/q.jpg"), fileItem("w.jpg", "/home/docs/w.jpg")],
          },
        ],
        truncated: false,
      }),
    );

    render(<Duplicates />);

    expect(await screen.findByText("2 duplicate groups")).toBeInTheDocument();
    expect(provider.duplicateGroups).toHaveBeenCalledTimes(1);

    // Each group shows its shared total size and member count.
    expect(screen.getAllByText("shared total")).toHaveLength(2);
    expect(screen.getAllByText("2 duplicate files")).toHaveLength(2);

    // Members render with the existing file icon, name, location/date, size.
    expect(screen.getByText("z.txt")).toBeInTheDocument();
    expect(screen.getByText("a.txt")).toBeInTheDocument();
    expect(screen.getByText("q.jpg")).toBeInTheDocument();
    expect(screen.getAllByText(/\/home\/docs/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Sep 1, 2026/).length).toBeGreaterThan(0);

    // Provider ordering is preserved — configured as z.txt before a.txt.
    const members = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(members.findIndex((m) => m.includes("z.txt"))).toBeLessThan(
      members.findIndex((m) => m.includes("a.txt")),
    );

    // A scan that finished within budget shows no truncation notice.
    expect(screen.queryByText(/safety budget/)).not.toBeInTheDocument();
  });

  it("shows an honest empty state when the scan finds no duplicates", async () => {
    providerReturning(groupResult({ groups: [], truncated: false }));

    render(<Duplicates />);

    expect(await screen.findByText("No duplicate files found")).toBeInTheDocument();
    expect(screen.queryByText(/safety budget/)).not.toBeInTheDocument();
  });

  it("shows the error state and lets the user retry", async () => {
    const provider = {
      duplicateGroups: vi
        .fn()
        .mockRejectedValueOnce(new Error("scan backend unavailable"))
        .mockResolvedValueOnce(groupResult({ groups: [] })),
    };
    getFilesystemProvider.mockReturnValue(provider);

    render(<Duplicates />);

    expect(await screen.findByText("Couldn't scan for duplicates")).toBeInTheDocument();
    expect(screen.getByText("scan backend unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(await screen.findByText("No duplicate files found")).toBeInTheDocument();
    expect(provider.duplicateGroups).toHaveBeenCalledTimes(2);
  });

  it("reports truncated scans honestly as a non-error notice", async () => {
    providerReturning(groupResult({ truncated: true }));

    render(<Duplicates />);

    expect(await screen.findByText("1 duplicate group")).toBeInTheDocument();
    const notice = screen.getByText(/safety budget/);
    expect(notice).toBeInTheDocument();
    // It is informational, not an error: the real group still renders next to it.
    expect(screen.getByText("z.txt")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't scan for duplicates")).not.toBeInTheDocument();
  });
});