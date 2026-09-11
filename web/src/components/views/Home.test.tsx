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

function renderHome(items: FileItem[]) {
  const onOpenFile = vi.fn();
  const onOpenFolder = vi.fn();
  const onNavigate = vi.fn();
  render(
    <Home recentFiles={items} onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} onNavigate={onNavigate} />,
  );
  return { onOpenFile, onOpenFolder, onNavigate };
}

describe("Home", () => {
  afterEach(cleanup);

  it("renders the real recent files from the loaded directory", () => {
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
});