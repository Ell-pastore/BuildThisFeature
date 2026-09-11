import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Recent from "./Recent";
import type { FileItem } from "../../types";

function fileItem(name: string, modified = "Sep 1, 2026"): FileItem {
  return {
    id: `/Users/usr/Desktop/${name}`,
    name,
    type: "pdf",
    size: "1.2 MB",
    sizeBytes: 1200000,
    modified,
    created: "Aug 1, 2026",
    createdTs: 1,
    modifiedTs: 1,
    location: "/Users/usr/Desktop",
    path: `/Users/usr/Desktop/${name}`,
    starred: false,
  };
}

function folderItem(name: string): FileItem {
  return {
    id: `/Users/usr/Desktop/${name}`,
    name,
    type: "folder",
    size: "—",
    sizeBytes: 0,
    modified: "Sep 1, 2026",
    created: "Aug 1, 2026",
    createdTs: 1,
    modifiedTs: 2,
    location: "/Users/usr/Desktop",
    path: `/Users/usr/Desktop/${name}`,
    starred: false,
    isFolder: true,
    itemCount: 3,
  };
}

function renderRecent(props: Partial<React.ComponentProps<typeof Recent>> = {}) {
  const onOpenFile = vi.fn();
  render(<Recent items={[]} onOpenFile={onOpenFile} {...props} />);
  return { onOpenFile };
}

describe("Recent", () => {
  afterEach(cleanup);

  it("shows the loading state while the recent-files scan is in flight", () => {
    renderRecent({ loading: true });

    expect(screen.getByText("Loading recent files…")).toBeInTheDocument();
  });

  it("lists REAL recent items provided by the app", () => {
    renderRecent({ items: [fileItem("report.pdf"), folderItem("Projects")] });

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getAllByText("/Users/usr/Desktop").length).toBeGreaterThan(0);
    expect(screen.getAllByText("PDF").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Folder").length).toBeGreaterThan(0);
    expect(screen.getByText("1.2 MB")).toBeInTheDocument();
  });

  it("opens the file preview when a row is clicked", () => {
    const { onOpenFile } = renderRecent({ items: [fileItem("photo.jpg")] });

    fireEvent.click(screen.getByText("photo.jpg"));

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith(fileItem("photo.jpg"));
  });

  it("shows the honest empty state when nothing has been modified yet", () => {
    renderRecent();

    expect(screen.getByText("No recent files yet")).toBeInTheDocument();
  });

  it("surfaces a real scan error honestly with a retry", () => {
    const onRetry = vi.fn();
    renderRecent({ error: "Scan failed", onRetry });

    expect(screen.getByText("Scan failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});