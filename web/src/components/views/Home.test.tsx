import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Home from "./Home";
import type { FileItem } from "../../types";

function fileItem(name: string): FileItem {
  return {
    id: `/Users/usr/Desktop/${name}`,
    name,
    type: "pdf",
    size: "1.2 MB",
    sizeBytes: 1200000,
    modified: "Sep 1, 2026",
    created: "Aug 1, 2026",
    createdTs: 1,
    modifiedTs: 2,
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

function renderHome(
  items: FileItem[],
  recents?: FileItem[],
  opts?: { loading?: boolean; error?: string | null },
) {
  const onOpenFile = vi.fn();
  const onOpenFolder = vi.fn();
  const onNavigate = vi.fn();
  render(
    <Home
      recentFiles={items}
      recents={recents ?? items}
      recentsLoading={opts?.loading ?? false}
      recentsError={opts?.error ?? null}
      onOpenFile={onOpenFile}
      onOpenFolder={onOpenFolder}
      onNavigate={onNavigate}
    />,
  );
  return { onOpenFile, onOpenFolder, onNavigate };
}

describe("Home", () => {
  afterEach(cleanup);

  it("renders the real recent files from recents", () => {
    renderHome([fileItem("report.pdf"), folderItem("Projects")]);

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
  });

  it("navigates into a folder via onOpenFolder instead of opening the preview", () => {
    const { onOpenFile, onOpenFolder } = renderHome([folderItem("Projects"), fileItem("report.pdf")]);

    fireEvent.click(screen.getByText("Projects"));

    expect(onOpenFolder).toHaveBeenCalledTimes(1);
    expect(onOpenFolder).toHaveBeenCalledWith(folderItem("Projects"));
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("opens the file preview when a file is clicked", () => {
    const { onOpenFile, onOpenFolder } = renderHome([folderItem("Projects"), fileItem("report.pdf")]);

    fireEvent.click(screen.getByText("report.pdf"));

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith(fileItem("report.pdf"));
    expect(onOpenFolder).not.toHaveBeenCalled();
  });

  it("limits the recent files section to 5 real items", () => {
    const many = Array.from({ length: 6 }, (_, i) => fileItem(`file-${i}.pdf`));
    renderHome([], many);

    expect(screen.getByText("file-0.pdf")).toBeInTheDocument();
    expect(screen.getByText("file-4.pdf")).toBeInTheDocument();
    expect(screen.queryByText("file-5.pdf")).not.toBeInTheDocument();
  });

  it("shows an honest loading state while the recent scan is in flight", () => {
    renderHome([], [], { loading: true });

    expect(screen.getByText("Loading recent files…")).toBeInTheDocument();
    expect(
      screen.getByText("Scanning your allowed folders for the most recently modified items."),
    ).toBeInTheDocument();
  });

  it("shows the recent scan error instead of the loader", () => {
    renderHome([], [], { loading: true, error: "Scan failed: permission denied" });

    expect(screen.getByText("Scan failed: permission denied")).toBeInTheDocument();
    expect(screen.queryByText("Loading recent files…")).not.toBeInTheDocument();
  });

  it("shows an honest empty state when there are no recent files", () => {
    renderHome([], []);

    expect(screen.getByText("No recent files yet")).toBeInTheDocument();
    expect(
      screen.getByText("Files you modify or create in your allowed folders will appear here."),
    ).toBeInTheDocument();
  });

  it("uses recents for the section while keeping the stats folder-scoped to recentFiles", () => {
    renderHome([fileItem("alpha.pdf"), fileItem("beta.pdf"), folderItem("Docs")], [folderItem("CrossRoot")]);

    expect(screen.getByText("CrossRoot")).toBeInTheDocument();
    expect(screen.queryByText("alpha.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("Docs")).not.toBeInTheDocument();

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getAllByText("in the current folder")).toHaveLength(2);
  });
});