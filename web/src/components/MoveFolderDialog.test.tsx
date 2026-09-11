import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import MoveFolderDialog from "./MoveFolderDialog";
import type { FileItem } from "../types";

const listDirectoryMock = vi.hoisted(() => vi.fn());

vi.mock("../services/filesystem", () => ({
  getFilesystemProvider: () => ({ listDirectory: listDirectoryMock }),
}));

function folder(name: string, path: string): FileItem {
  return {
    id: path,
    name,
    type: "folder",
    size: "—",
    sizeBytes: 0,
    modified: "Sep 1, 2026",
    created: "Aug 1, 2026",
    createdTs: 1,
    modifiedTs: 1,
    location: path.slice(0, path.lastIndexOf("/")),
    path,
    starred: false,
    isFolder: true,
    itemCount: 1,
  };
}

function fileItem(name: string, path: string): FileItem {
  return {
    id: path,
    name,
    type: "txt",
    size: "1.2 KB",
    sizeBytes: 1200,
    modified: "Sep 1, 2026",
    created: "Aug 1, 2026",
    createdTs: 1,
    modifiedTs: 1,
    location: path.slice(0, path.lastIndexOf("/")),
    path,
    starred: false,
  };
}

function renderDialog(initialPath = "/Users/usr/Desktop") {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <MoveFolderDialog
      itemName="notes.txt"
      initialPath={initialPath}
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
  return { onConfirm, onClose };
}

describe("MoveFolderDialog", () => {
  beforeEach(() => {
    listDirectoryMock.mockResolvedValue({
      path: "/Users/usr/Desktop",
      parentPath: "/Users/usr",
      isHome: false,
      items: [
        folder("Projects", "/Users/usr/Desktop/Projects"),
        folder("Documents", "/Users/usr/Desktop/Documents"),
        // Files are real data but must never be offered as destinations.
        fileItem("notes.txt", "/Users/usr/Desktop/notes.txt"),
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("lists REAL subfolders from the provider and never offers files as destinations", async () => {
    renderDialog();

    expect(await screen.findByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("clearly shows the currently selected destination folder", async () => {
    renderDialog();

    expect(await screen.findByText("/Users/usr/Desktop")).toBeInTheDocument();
    expect(screen.getByText("Selected destination")).toBeInTheDocument();
  });

  it("navigates into a folder via real provider data", async () => {
    renderDialog();

    fireEvent.click(await screen.findByText("Projects"));

    expect(listDirectoryMock).toHaveBeenCalledWith("/Users/usr/Desktop/Projects");
    expect(await screen.findByText("/Users/usr/Desktop/Projects")).toBeInTheDocument();
  });

  it("moves up to the real parent folder", async () => {
    renderDialog();

    fireEvent.click(await screen.findByText("Up"));

    expect(listDirectoryMock).toHaveBeenCalledWith("/Users/usr");
    expect(await screen.findByText("/Users/usr")).toBeInTheDocument();
  });

  it("confirms with the currently selected destination through the existing onConfirm flow", async () => {
    const { onConfirm } = renderDialog();

    await screen.findByText("/Users/usr/Desktop");
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("/Users/usr/Desktop");
  });

  it("supports a copy variant that is clearly labelled Copy here", async () => {
    const onConfirm = vi.fn();
    render(
      <MoveFolderDialog
        itemName="report.pdf"
        initialPath="/Users/usr/Desktop"
        titleVerb="Copy"
        actionLabel="Copy here"
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText(/Copy "report.pdf" to/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy here" }));
    expect(onConfirm).toHaveBeenCalledWith("/Users/usr/Desktop");
  });

  it("shows a real listing error honestly", async () => {
    listDirectoryMock.mockRejectedValue(new Error("permission denied"));
    renderDialog();

    expect(await screen.findByText("Couldn't load this folder")).toBeInTheDocument();
    expect(screen.getByText("permission denied")).toBeInTheDocument();
  });

  it("cancels the move without invoking onConfirm", async () => {
    const { onConfirm, onClose } = renderDialog();

    await screen.findByText("/Users/usr/Desktop");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});