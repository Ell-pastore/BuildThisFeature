import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Files from "./Files";
import type { FileItem } from "../../types";

const listDirectoryMock = vi.hoisted(() => vi.fn());

vi.mock("../../services/filesystem", () => ({
  getFilesystemProvider: () => ({ listDirectory: listDirectoryMock }),
}));

function folder(name: string): FileItem {
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

function renderFiles(items: FileItem[] = [folder("Projects"), fileItem("report.pdf")]) {
  const onNewFolder = vi.fn();
  const onNewFile = vi.fn();
  const onRename = vi.fn();
  const onDuplicate = vi.fn();
  const onCopy = vi.fn();
  const onOpenFolder = vi.fn();
  const onOpenPreview = vi.fn();
  render(
    <Files
      items={items}
      loading={false}
      error={null}
      path="/Users/usr/Desktop"
      isHome={false}
      onUp={() => {}}
      onOpenFolder={onOpenFolder}
      onOpenPreview={onOpenPreview}
      onOpenDisk={() => {}}
      onNewFolder={onNewFolder}
      onNewFile={onNewFile}
      onRename={onRename}
      onDelete={() => {}}
      onMove={() => {}}
      onCopy={onCopy}
      onDuplicate={onDuplicate}
      onToggleStar={() => {}}
      onRefresh={() => {}}
    />,
  );
  return { onNewFolder, onNewFile, onRename, onDuplicate, onCopy, onOpenFolder, onOpenPreview };
}

describe("Files", () => {
  beforeEach(() => {
    listDirectoryMock.mockResolvedValue({
      path: "/Users/usr/Desktop",
      parentPath: "/Users/usr",
      isHome: false,
      items: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("lists REAL items from the given directory data", () => {
    renderFiles();

    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("navigates into a folder row via onOpenFolder instead of opening the preview", () => {
    const { onOpenFolder, onOpenPreview } = renderFiles();

    fireEvent.click(screen.getByText("Projects"));

    expect(onOpenFolder).toHaveBeenCalledTimes(1);
    expect(onOpenFolder).toHaveBeenCalledWith(folder("Projects"));
    expect(onOpenPreview).not.toHaveBeenCalled();
  });

  it("opens the file preview when a file row is clicked", () => {
    const { onOpenFolder, onOpenPreview } = renderFiles();

    fireEvent.click(screen.getByText("report.pdf"));

    expect(onOpenPreview).toHaveBeenCalledTimes(1);
    expect(onOpenPreview).toHaveBeenCalledWith(fileItem("report.pdf"));
    expect(onOpenFolder).not.toHaveBeenCalled();
  });

  it("creates a folder through the existing onNewFolder flow", () => {
    const { onNewFolder } = renderFiles();

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByText("New folder")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Folder name"), {
      target: { value: "  Assets  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onNewFolder).toHaveBeenCalledWith("Assets");
  });

  it("creates a file through the new onNewFile flow", () => {
    const { onNewFile } = renderFiles();

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("button", { name: "file" }));
    expect(screen.getByText("New file")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("File name"), {
      target: { value: "notes.txt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onNewFile).toHaveBeenCalledWith("notes.txt");
  });

  it("duplicates every selected item through onDuplicate", async () => {
    const { onDuplicate } = renderFiles();

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    await screen.findByText("2 selected");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));

    expect(onDuplicate).toHaveBeenCalledTimes(2);
    expect(onDuplicate).toHaveBeenCalledWith(folder("Projects"));
    expect(onDuplicate).toHaveBeenCalledWith(fileItem("report.pdf"));
  });

  it("copies the selected items to a chosen destination via the Copy here picker", async () => {
    const { onCopy } = renderFiles();

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);

    await screen.findByText("1 selected");
    fireEvent.click(screen.getByRole("button", { name: "Copy to…" }));

    expect(await screen.findByText(/Copy "report.pdf" to/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy here" }));

    await waitFor(() => {
      expect(onCopy).toHaveBeenCalledTimes(1);
    });
    expect(onCopy).toHaveBeenCalledWith(fileItem("report.pdf"), "/Users/usr/Desktop");
  });

  it("renames a selected item, trims the name, and closes the dialog on success", async () => {
    const { onRename } = renderFiles([fileItem("report.pdf")]);
    onRename.mockResolvedValue(null);

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    await screen.findByText("1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("report.pdf"), {
      target: { value: "  notes.txt  " },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledTimes(1);
    });
    expect(onRename).toHaveBeenCalledWith(fileItem("report.pdf"), "notes.txt");
    expect(screen.queryByDisplayValue("notes.txt")).not.toBeInTheDocument();
  });

  it("keeps the rename dialog open and shows the error inline when the rename fails", async () => {
    const { onRename } = renderFiles([fileItem("report.pdf")]);
    onRename.mockResolvedValue("A file or folder with that name already exists.");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    await screen.findByText("1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("report.pdf"), {
      target: { value: "notes.txt" },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    expect(
      await screen.findByText("A file or folder with that name already exists."),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("notes.txt")).toBeInTheDocument();
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("does not submit a blank rename name and keeps the dialog open", async () => {
    const { onRename } = renderFiles([fileItem("report.pdf")]);
    onRename.mockResolvedValue(null);

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    await screen.findByText("1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("report.pdf"), {
      target: { value: "   " },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Rename" }).length).toBe(2);
  });
});