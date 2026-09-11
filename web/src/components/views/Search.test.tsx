import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import Search from "./Search";
import type { FileItem } from "../../types";

function file(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: "/Users/usr/Desktop/notes.txt",
    name: "notes.txt",
    type: "txt",
    size: "1.2 KB",
    sizeBytes: 1200,
    modified: "Sep 1, 2026",
    created: "Aug 1, 2026",
    modifiedTs: 1,
    createdTs: 1,
    location: "/Users/usr/Desktop",
    path: "/Users/usr/Desktop/notes.txt",
    starred: false,
    ...overrides,
  };
}

describe("Search", () => {
  afterEach(cleanup);

  it("renders real search results without fabricated scores or AI framing", () => {
    const results = [
      file(),
      file({
        id: "/Users/usr/Documents/report.pdf",
        name: "report.pdf",
        type: "pdf",
        location: "/Users/usr/Documents",
      }),
    ];

    render(<Search query="re" results={results} onOpenFile={() => {}} />);

    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("2 results")).toBeInTheDocument();
    // No fake relevance artifacts.
    expect(screen.queryByText(/% match/i)).toBeNull();
    expect(screen.queryByText(/AI Understanding/i)).toBeNull();
    // Real metadata shown.
    expect(screen.getByText(/\/Users\/usr\/Desktop · Sep 1, 2026/)).toBeInTheDocument();
  });

  it("shows the honest prompt on an empty query and never a fake result set", () => {
    render(<Search query="" results={[]} onOpenFile={() => {}} />);

    expect(screen.getByText("Search across all your folders")).toBeInTheDocument();
    expect(screen.queryByText(/results/)).toBeNull();
  });

  it("shows the loading state while a search is in flight", () => {
    render(<Search query="re" searching results={[]} onOpenFile={() => {}} />);

    expect(screen.getByText("Searching your folders…")).toBeInTheDocument();
  });

  it("surfaces a real search error honestly", () => {
    render(<Search query="re" error="Cannot reach the filesystem bridge." results={[]} onOpenFile={() => {}} />);

    expect(screen.getByText("Couldn't search your folders")).toBeInTheDocument();
    expect(screen.getByText("Cannot reach the filesystem bridge.")).toBeInTheDocument();
  });

  it("shows the honest empty state when the recursive search finds nothing", () => {
    render(<Search query="zzzz" results={[]} onOpenFile={() => {}} />);

    expect(screen.getByText("No files found")).toBeInTheDocument();
    expect(screen.getByText(/Nothing in your folders matches/)).toBeInTheDocument();
  });
});