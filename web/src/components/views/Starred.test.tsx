import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Starred from "./Starred";
import type { FileItem } from "../../types";

function starredItem(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: "/Users/usr/Desktop/report.pdf",
    name: "report.pdf",
    type: "pdf",
    size: "1.2 MB",
    sizeBytes: 1200000,
    modified: "Sep 1, 2026",
    created: "Aug 1, 2026",
    modifiedTs: 2,
    createdTs: 1,
    location: "/Users/usr/Desktop",
    path: "/Users/usr/Desktop/report.pdf",
    starred: true,
    isFolder: false,
    itemCount: 0,
    ...overrides,
  };
}

describe("Starred", () => {
  afterEach(() => {
    cleanup();
  });

  it("lists resolved starred files from the persisted store", () => {
    const onOpenFile = vi.fn();

    render(
      <Starred
        onOpenFile={onOpenFile}
        items={[
          starredItem(),
          starredItem({
            id: "/A",
            name: "notes.txt",
            type: "txt",
            size: "200 B",
            location: "/A",
          }),
        ]}
      />,
    );

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("/Users/usr/Desktop")).toBeInTheDocument();
    expect(screen.getByText("1.2 MB")).toBeInTheDocument();
    expect(screen.getByText("200 B")).toBeInTheDocument();
  });

  it("opens the existing preview when a row is clicked", () => {
    const onOpenFile = vi.fn();
    render(<Starred onOpenFile={onOpenFile} items={[starredItem()]} />);

    fireEvent.click(screen.getByText("report.pdf"));

    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ name: "report.pdf" }));
  });

  it("navigates into a starred folder via onOpenFolder instead of opening the preview", () => {
    const folderItem: FileItem = starredItem({
      id: "/Users/usr/Desktop/Projects",
      name: "Projects",
      type: "folder",
      isFolder: true,
      itemCount: 3,
      size: "—",
      sizeBytes: 0,
    });
    const onOpenFile = vi.fn();
    const onOpenFolder = vi.fn();

    render(<Starred onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} items={[folderItem]} />);

    fireEvent.click(screen.getByText("Projects"));

    expect(onOpenFolder).toHaveBeenCalledTimes(1);
    expect(onOpenFolder).toHaveBeenCalledWith(expect.objectContaining({ name: "Projects" }));
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("shows the honest empty state when nothing is starred", () => {
    render(<Starred onOpenFile={() => {}} />);

    expect(screen.getByText("No starred files yet")).toBeInTheDocument();
  });

  it("shows the loading state while resolving persisted stars", () => {
    render(<Starred onOpenFile={() => {}} loading />);

    expect(screen.getByText("Loading starred files…")).toBeInTheDocument();
  });

  it("surfaces a real resolution error honestly with a retry", () => {
    const onRetry = vi.fn();
    render(<Starred onOpenFile={() => {}} error="Stars are not configured" onRetry={onRetry} />);

    expect(screen.getByText("Stars are not configured")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("reports missing starred paths without fabricating rows", () => {
    render(
      <Starred
        onOpenFile={() => {}}
        items={[starredItem()]}
        missingPaths={["/Users/usr/Desktop/gone.txt", "/Gone/dir"]}
      />,
    );

    expect(screen.queryByText("gone.txt")).not.toBeInTheDocument();
    expect(screen.getByText(/2 starred items can't be found/)).toBeInTheDocument();
  });

  it("unstars a file through the existing path and removes the row on success", () => {
    const onOpenFile = vi.fn();
    const onUnstar = vi.fn();

    const { rerender } = render(
      <Starred
        onOpenFile={onOpenFile}
        onUnstar={onUnstar}
        items={[
          starredItem(),
          starredItem({
            id: "/Users/usr/Desktop/notes.txt",
            name: "notes.txt",
            type: "txt",
            size: "200 B",
            location: "/Users/usr/Desktop",
            path: "/Users/usr/Desktop/notes.txt",
          }),
        ]}
      />,
    );

    expect(screen.getByText("report.pdf")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /unstar report\.pdf/i }));

    // The existing star mutation/persistence path is invoked with the row's item.
    expect(onUnstar).toHaveBeenCalledTimes(1);
    expect(onUnstar).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "report.pdf",
        path: "/Users/usr/Desktop/report.pdf",
      }),
    );
    // Unstarring is not the same as opening the preview.
    expect(onOpenFile).not.toHaveBeenCalled();
    // The other row is untouched.
    expect(screen.getByText("notes.txt")).toBeInTheDocument();

    // On success the parent drops the item from `items`; the row disappears
    // immediately without a re-scan.
    rerender(
      <Starred
        onOpenFile={onOpenFile}
        onUnstar={onUnstar}
        items={[
          starredItem({
            id: "/Users/usr/Desktop/notes.txt",
            name: "notes.txt",
            type: "txt",
            size: "200 B",
            location: "/Users/usr/Desktop",
            path: "/Users/usr/Desktop/notes.txt",
          }),
        ]}
      />,
    );
    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });

  it("keeps the row unchanged when an unstar fails", () => {
    const onOpenFile = vi.fn();
    const onUnstar = vi.fn(() => {
      throw new Error("save failed");
    });

    render(<Starred onOpenFile={onOpenFile} onUnstar={onUnstar} items={[starredItem()]} />);

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: /unstar report\.pdf/i })),
    ).not.toThrow();
    expect(onUnstar).toHaveBeenCalledTimes(1);
    // No fabricated state: the row stays and the preview was not opened.
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});