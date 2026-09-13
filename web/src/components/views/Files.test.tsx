import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function renderFiles(
  items: FileItem[] = [folder("Projects"), fileItem("report.pdf")],
  overrides: {
    defaultViewMode?: "list" | "grid";
    defaultSort?: "name" | "modified" | "size";
    confirmDelete?: boolean;
  } = {},
) {
  const onNewFolder = vi.fn();
  const onNewFile = vi.fn();
  const onRename = vi.fn();
  const onDuplicate = vi.fn();
  const onCopy = vi.fn();
  const onDelete = vi.fn();
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
      onDelete={onDelete}
      onMove={() => {}}
      onCopy={onCopy}
      onDuplicate={onDuplicate}
      onToggleStar={() => {}}
      onRefresh={() => {}}
      onUploaded={() => {}}
      {...overrides}
    />,
  );
  return { onNewFolder, onNewFile, onRename, onDuplicate, onCopy, onOpenFolder, onOpenPreview, onDelete };
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

  it("opens the upload picker from the toolbar Upload button", () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
    renderFiles();

    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
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

  it("opens and closes the filter panel from the Filter button", () => {
    renderFiles();

    expect(screen.queryByRole("group", { name: "Type" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getByRole("group", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Size" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Modified" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.queryByRole("group", { name: "Type" })).not.toBeInTheDocument();
  });

  it("filters the listing by file type", () => {
    const png = {
      ...fileItem("photo.png"),
      name: "photo.png",
      id: "/Users/usr/Desktop/photo.png",
      type: "png",
    };
    renderFiles([fileItem("report.pdf"), png, folder("Projects")]);

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "PDF" }),
    );

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.queryByText("photo.png")).not.toBeInTheDocument();
  });

  it("filters the listing by large size (≥ 100 MB)", () => {
    const big = {
      ...fileItem("big.mov"),
      name: "big.mov",
      id: "/Users/usr/Desktop/big.mov",
      type: "mov",
      size: "150 MB",
      sizeBytes: 150 * 1024 * 1024,
    };
    renderFiles([fileItem("report.pdf"), big]);

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Size" })).getByRole("button", { name: "Large" }),
    );

    expect(screen.getByText("big.mov")).toBeInTheDocument();
    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
  });

  it("filters the listing by recent modified date", () => {
    const now = Date.now() / 1000;
    const recent = {
      ...fileItem("notes.txt"),
      name: "notes.txt",
      id: "/Users/usr/Desktop/notes.txt",
      type: "txt",
      modifiedTs: now - 2 * 24 * 60 * 60,
    };
    const old = {
      ...fileItem("old.pdf"),
      name: "old.pdf",
      id: "/Users/usr/Desktop/old.pdf",
      modifiedTs: now - 60 * 24 * 60 * 60,
    };
    renderFiles([recent, old]);

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Modified" })).getByRole("button", {
        name: "Past 7 days",
      }),
    );

    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.queryByText("old.pdf")).not.toBeInTheDocument();
  });

  it("keeps folders visible while file-type filtering is active", () => {
    const png = {
      ...fileItem("photo.png"),
      name: "photo.png",
      id: "/Users/usr/Desktop/photo.png",
      type: "png",
    };
    renderFiles([folder("Projects"), png, fileItem("report.pdf")]);

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "Images" }),
    );

    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("photo.png")).toBeInTheDocument();
    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
  });

  it("composes type, size, and modified filters with AND semantics", () => {
    const now = Date.now() / 1000;
    const bigRecentPdf = {
      ...fileItem("matching.pdf"),
      name: "matching.pdf",
      id: "/Users/usr/Desktop/matching.pdf",
      sizeBytes: 150 * 1024 * 1024,
      modifiedTs: now - 2 * 24 * 60 * 60,
    };
    const smallRecentPdf = {
      ...fileItem("small.pdf"),
      name: "small.pdf",
      id: "/Users/usr/Desktop/small.pdf",
      modifiedTs: now - 2 * 24 * 60 * 60,
    };
    const oldBigPdf = {
      ...fileItem("old.pdf"),
      name: "old.pdf",
      id: "/Users/usr/Desktop/old.pdf",
      sizeBytes: 150 * 1024 * 1024,
      modifiedTs: now - 60 * 24 * 60 * 60,
    };
    renderFiles([
      bigRecentPdf,
      smallRecentPdf,
      oldBigPdf,
      { ...folder("Projects"), modifiedTs: now - 2 * 24 * 60 * 60 },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "PDF" }),
    );
    fireEvent.click(
      within(screen.getByRole("group", { name: "Size" })).getByRole("button", { name: "Large" }),
    );
    fireEvent.click(
      within(screen.getByRole("group", { name: "Modified" })).getByRole("button", {
        name: "Past 7 days",
      }),
    );

    expect(screen.getByText("matching.pdf")).toBeInTheDocument();
    expect(screen.queryByText("small.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("old.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
  });

  it("resets all filters and restores the full listing", () => {
    const now = Date.now() / 1000;
    const bigOldPdf = {
      ...fileItem("big.pdf"),
      name: "big.pdf",
      id: "/Users/usr/Desktop/big.pdf",
      sizeBytes: 150 * 1024 * 1024,
      modifiedTs: now - 60 * 24 * 60 * 60,
    };
    renderFiles([fileItem("report.pdf"), bigOldPdf, folder("Projects")]);

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "PDF" }),
    );
    fireEvent.click(
      within(screen.getByRole("group", { name: "Size" })).getByRole("button", { name: "Large" }),
    );
    fireEvent.click(
      within(screen.getByRole("group", { name: "Modified" })).getByRole("button", {
        name: "Past 7 days",
      }),
    );

    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("big.pdf")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("big.pdf")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
  });

  it("shows an honest no-match state when nothing meets the active filters", () => {
    renderFiles([fileItem("report.pdf")]);

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "Videos" }),
    );

    expect(screen.getByText("No matching results")).toBeInTheDocument();
    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
  });

  it("opens the listing in the persisted default view", () => {
    renderFiles([fileItem("report.pdf")], { defaultViewMode: "grid" });

    // Grid mode renders no "Name" column header, unlike list mode.
    expect(screen.queryByText("Name")).not.toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("sorts the listing by the persisted default sort key", () => {
    renderFiles([fileItem("z.pdf"), fileItem("a.pdf")], { defaultSort: "name" });

    const before = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(
      before(screen.getByText("a.pdf"), screen.getByText("z.pdf")),
    ).toBe(true);
  });

  it("asks for confirmation before deleting when confirm-before-delete is on", async () => {
    const { onDelete } = renderFiles([fileItem("report.pdf")], { confirmDelete: true });

    fireEvent.click(screen.getByRole("checkbox"));
    await screen.findByText("1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Move report.pdf to Trash?")).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(fileItem("report.pdf"));
  });

  it("deletes immediately without confirmation when confirm-before-delete is off", async () => {
    const { onDelete } = renderFiles([fileItem("report.pdf")], { confirmDelete: false });

    fireEvent.click(screen.getByRole("checkbox"));
    await screen.findByText("1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.queryByText("Move report.pdf to Trash?")).not.toBeInTheDocument();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(fileItem("report.pdf"));
  });
});