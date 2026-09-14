import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "./App";
import type { FileItem, TrashItem } from "./types";

const providerMock = vi.hoisted(() => {
  const provider: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = [
    "listDirectory",
    "recentFiles",
    "resolveStarredPaths",
    "diskUsage",
    "storageByCategory",
    "openItem",
    "renameItem",
    "createFolder",
    "createFile",
    "moveItem",
    "copyItem",
    "duplicateItem",
    "trashItem",
    "listTrash",
    "restoreItem",
    "homeDirectory",
    "searchFiles",
    "readFile",
  ];
  for (const m of methods) provider[m] = vi.fn();
  return provider;
});

vi.mock("./services/filesystem", () => ({
  getFilesystemProvider: () => providerMock,
}));

const starsHook = vi.hoisted(() => ({
  stars: [] as string[],
  isStarred: vi.fn(() => false),
  toggleStar: vi.fn(),
  updateStarPath: vi.fn(),
  removeStarPath: vi.fn(),
}));

vi.mock("./services/stars", () => ({
  useStars: () => ({
    stars: starsHook.stars,
    isStarred: starsHook.isStarred,
    toggleStar: starsHook.toggleStar,
    updateStarPath: starsHook.updateStarPath,
    removeStarPath: starsHook.removeStarPath,
  }),
}));

vi.mock("./components/AIAssistant", () => ({ default: () => null }));
vi.mock("./components/views/Recent", () => ({ default: () => null }));
vi.mock("./components/views/Starred", () => ({ default: () => null }));
vi.mock("./components/views/Search", () => ({ default: () => null }));
vi.mock("./components/views/AIOrganization", () => ({ default: () => null }));
vi.mock("./components/views/AIHistoryView", () => ({ default: () => null }));
vi.mock("./components/views/Duplicates", () => ({ default: () => null }));
vi.mock("./components/views/SmartFolders", () => ({ default: () => null }));
vi.mock("./components/views/Storage", () => ({ default: () => null }));
vi.mock("./components/views/Settings", () => ({ default: () => null }));

function fileItem(name: string): FileItem {
  return {
    id: `/Users/usr/Desktop/${name}`,
    name,
    type: "zip",
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

function listing(items: FileItem[]) {
  return {
    path: "/Users/usr/Desktop",
    parentPath: "/Users/usr",
    isHome: false,
    items,
  };
}

function folderItem(name: string, path: string): FileItem {
  return {
    id: path,
    name,
    type: "folder",
    size: "—",
    sizeBytes: 0,
    modified: "Sep 1, 2026",
    created: "Aug 1, 2026",
    createdTs: 1,
    modifiedTs: 2,
    location: path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))),
    path,
    starred: false,
    isFolder: true,
    itemCount: 0,
  };
}

function pathListing(
  path: string,
  parentPath: string | null,
  isHome: boolean,
  items: FileItem[],
) {
  return { path, parentPath, isHome, items };
}

describe("App move preview synchronization", () => {
  beforeEach(() => {
    providerMock.listDirectory.mockResolvedValue(
      listing([
        {
          ...fileItem("Documents"),
          type: "folder",
          isFolder: true,
          size: "—",
          sizeBytes: 0,
          location: "/Users/usr/Desktop",
          path: "/Users/usr/Desktop/Documents",
          id: "/Users/usr/Desktop/Documents",
        },
        fileItem("report.zip"),
      ]),
    );
    providerMock.recentFiles.mockResolvedValue([fileItem("report.zip")]);
    providerMock.resolveStarredPaths.mockResolvedValue({ items: [], missing: [] });
    providerMock.diskUsage.mockResolvedValue({ totalBytes: 1000, freeBytes: 400 });
    providerMock.openItem.mockResolvedValue(undefined);
    providerMock.moveItem.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("updates the open preview after a move so later actions target the new path", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("report.zip"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();
    const recentFetchedBefore = providerMock.recentFiles.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    const dialogCard = await screen.findByText("Selected destination").then((el) =>
      el.closest(".bg-card"),
    );
    expect(dialogCard).not.toBeNull();
    const dialog = within(dialogCard as HTMLElement);
    fireEvent.click(dialog.getByRole("button", { name: "Documents" }));
    expect(
      await dialog.findByText("/Users/usr/Desktop/Documents"),
    ).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Move here" }));

    await waitFor(() => {
      expect(providerMock.moveItem).toHaveBeenCalledWith(
        "/Users/usr/Desktop/report.zip",
        "/Users/usr/Desktop/Documents",
      );
    });
    expect(screen.getAllByText("/Users/usr/Desktop/Documents").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(starsHook.updateStarPath).toHaveBeenCalledWith(
        "/Users/usr/Desktop/report.zip",
        "/Users/usr/Desktop/Documents/report.zip",
      );
    });
    await waitFor(() => {
      expect(providerMock.recentFiles.mock.calls.length).toBeGreaterThan(recentFetchedBefore);
    });

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(providerMock.openItem).toHaveBeenCalledWith(
        "/Users/usr/Desktop/Documents/report.zip",
      );
    });
  });

  it("releases the stored star path when a previewed file is moved to trash", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByText("report.zip"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();
    const recentFetchedBefore = providerMock.recentFiles.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(providerMock.trashItem).toHaveBeenCalledWith("/Users/usr/Desktop/report.zip");
    });
    await waitFor(() => {
      expect(starsHook.removeStarPath).toHaveBeenCalledWith("/Users/usr/Desktop/report.zip");
    });
    await waitFor(() => {
      expect(providerMock.recentFiles.mock.calls.length).toBeGreaterThan(recentFetchedBefore);
    });

    confirmSpy.mockRestore();
  });
});

describe("App rename preview synchronization", () => {
  beforeEach(() => {
    providerMock.listDirectory.mockResolvedValue(listing([fileItem("report.zip")]));
    providerMock.recentFiles.mockResolvedValue([fileItem("report.zip")]);
    providerMock.resolveStarredPaths.mockResolvedValue({ items: [], missing: [] });
    providerMock.diskUsage.mockResolvedValue({ totalBytes: 1000, freeBytes: 400 });
    providerMock.openItem.mockResolvedValue(undefined);
    providerMock.renameItem.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("updates the open preview after a successful rename so later actions target the new path", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("report.zip"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("report.zip"), {
      target: { value: "renamed.zip" },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    await waitFor(() => {
      expect(providerMock.renameItem).toHaveBeenCalledWith(
        "/Users/usr/Desktop/report.zip",
        "renamed.zip",
      );
    });
    expect((await screen.findAllByText("renamed.zip")).length).toBeGreaterThan(0);
    expect(screen.queryByDisplayValue("renamed.zip")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(providerMock.openItem).toHaveBeenCalledWith("/Users/usr/Desktop/renamed.zip");
    });
  });

  it("keeps the preview open with the inline error and never routes a rename failure into the folder error state", async () => {
    providerMock.renameItem.mockRejectedValue(
      new Error("A file or folder with that name already exists."),
    );
    render(<App />);

    fireEvent.click(await screen.findByText("report.zip"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("report.zip"), {
      target: { value: "renamed.zip" },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    expect(
      await screen.findByText("A file or folder with that name already exists."),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("renamed.zip")).toBeInTheDocument();
    expect(screen.getAllByText("report.zip").length).toBeGreaterThan(0);
    expect(providerMock.openItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect((await screen.findAllByText("report.zip")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Couldn't load this folder")).not.toBeInTheDocument();
  });

  it("keeps a starred file starred after a rename by migrating the stored path", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("report.zip"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("report.zip"), {
      target: { value: "renamed.zip" },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    await waitFor(() => {
      expect(starsHook.updateStarPath).toHaveBeenCalledWith(
        "/Users/usr/Desktop/report.zip",
        "/Users/usr/Desktop/renamed.zip",
      );
    });
  });

  it("refreshes recent files after a successful rename", async () => {
    render(<App />);
    const fetchedBefore = providerMock.recentFiles.mock.calls.length;

    fireEvent.click(await screen.findByText("report.zip"));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("report.zip"), {
      target: { value: "renamed.zip" },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    await waitFor(() => {
      expect(providerMock.recentFiles.mock.calls.length).toBeGreaterThan(fetchedBefore);
    });
  });
});

function trashedItem(): TrashItem {
  return {
    id: "/Users/usr/.trash-smart-file-manager/report.zip",
    name: "report.zip",
    path: "/Users/usr/.trash-smart-file-manager/report.zip",
    isFolder: false,
    size: "1.2 MB",
    sizeBytes: 1200000,
    fileType: "zip",
    created: "Aug 1, 2026",
    modified: "Sep 1, 2026",
    createdTs: 1,
    modifiedTs: 2,
    originalPath: "/Users/usr/Desktop/report.zip",
  };
}

describe("App trash view synchronization", () => {
  beforeEach(() => {
    providerMock.listDirectory.mockResolvedValue(
      listing([
        {
          ...fileItem("Documents"),
          type: "folder",
          isFolder: true,
          size: "—",
          sizeBytes: 0,
          location: "/Users/usr/Desktop",
          path: "/Users/usr/Desktop/Documents",
          id: "/Users/usr/Desktop/Documents",
        },
        fileItem("report.zip"),
      ]),
    );
    providerMock.recentFiles.mockResolvedValue([fileItem("report.zip")]);
    providerMock.resolveStarredPaths.mockResolvedValue({ items: [], missing: [] });
    providerMock.diskUsage.mockResolvedValue({ totalBytes: 1000, freeBytes: 400 });
    providerMock.openItem.mockResolvedValue(undefined);
    providerMock.trashItem.mockResolvedValue(undefined);
    providerMock.listTrash.mockResolvedValue([]);
    providerMock.restoreItem.mockResolvedValue("/Users/usr/Desktop/report.zip");
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("reloads an already-open Trash view after a previewed file is deleted", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByText("report.zip"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await waitFor(() => {
      expect(providerMock.listTrash.mock.calls.length).toBe(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(providerMock.trashItem).toHaveBeenCalledWith("/Users/usr/Desktop/report.zip");
    });
    // The Trash view itself re-reads the real trash without a manual Retry.
    await waitFor(() => {
      expect(providerMock.listTrash.mock.calls.length).toBe(2);
    });
    expect(await screen.findByText("Trash is empty")).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  it("refreshes the Trash view after a successful restore", async () => {
    providerMock.listTrash.mockResolvedValue([trashedItem()]);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    await waitFor(() => {
      expect(providerMock.restoreItem).toHaveBeenCalledWith(
        "/Users/usr/.trash-smart-file-manager/report.zip",
      );
    });
    // The Trash view re-reads the list after restore, no manual Retry needed.
    expect(providerMock.listTrash.mock.calls.length).toBe(2);
    expect((await screen.findAllByText("report.zip")).length).toBeGreaterThan(0);
  });
});

describe("App dead-directory recovery", () => {
  beforeEach(() => {
    providerMock.homeDirectory.mockResolvedValue("/Users/usr");
    providerMock.recentFiles.mockResolvedValue([]);
    providerMock.resolveStarredPaths.mockResolvedValue({ items: [], missing: [] });
    providerMock.diskUsage.mockResolvedValue({ totalBytes: 1000, freeBytes: 400 });
    providerMock.openItem.mockResolvedValue(undefined);
    providerMock.listDirectory.mockImplementation((path?: string) => {
      if (path === "/Users/usr/Desktop") {
        return Promise.resolve(
          pathListing("/Users/usr/Desktop", "/Users/usr", false, [
            folderItem("Projects", "/Users/usr/Desktop/Projects"),
          ]),
        );
      }
      if (path === "/Users/usr/Desktop/Projects") {
        return Promise.resolve(
          pathListing("/Users/usr/Desktop/Projects", "/Users/usr/Desktop", false, [
            { ...fileItem("notes.txt"), path: "/Users/usr/Desktop/Projects/notes.txt", id: "/Users/usr/Desktop/Projects/notes.txt", location: "/Users/usr/Desktop/Projects" },
          ]),
        );
      }
      return Promise.resolve(
        pathListing("/Users/usr", null, true, [folderItem("Desktop", "/Users/usr/Desktop")]),
      );
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  async function openFolderRow(name: string) {
    // Wait for the Files-view row to appear (skip the Sidebar Smart-Folders
    // label which can share the same name).
    await waitFor(() => {
      const el = screen.getAllByText(name).find((e) => !e.closest("aside"));
      expect(el).toBeTruthy();
    });
    const row = screen.getAllByText(name).find((e) => !e.closest("aside")) as HTMLElement;
    fireEvent.click(row);
  }

  it("recovers from a current directory renamed/moved/deleted elsewhere to its nearest valid parent", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    await openFolderRow("Desktop");
    await openFolderRow("Projects");
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    // The folder being viewed no longer exists; its parent is still there.
    providerMock.listDirectory.mockImplementation((path?: string) => {
      if (path === "/Users/usr/Desktop") {
        return Promise.resolve(
          pathListing("/Users/usr/Desktop", "/Users/usr", false, [
            { ...fileItem("budget.zip"), path: "/Users/usr/Desktop/budget.zip", id: "/Users/usr/Desktop/budget.zip" },
          ]),
        );
      }
      return Promise.reject(
        new Error("Unable to open this folder: The file or folder no longer exists."),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh folder" }));

    expect(await screen.findByText("budget.zip")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load this folder")).not.toBeInTheDocument();
    // Breadcrumbs reflect the recovered parent path, not the dead folder.
    expect(screen.getByRole("button", { name: "Desktop" })).toBeInTheDocument();
  });

  it("climbs to the app home directory when intermediate parents are also gone", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    await openFolderRow("Desktop");
    await openFolderRow("Projects");
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    // Both the folder and its parent are gone; only the app home survives.
    providerMock.listDirectory.mockImplementation((path?: string) => {
      if (path === "/Users/usr") {
        return Promise.resolve(
          pathListing("/Users/usr", null, true, [folderItem("Library", "/Users/usr/Library")]),
        );
      }
      return Promise.reject(
        new Error("Unable to open this folder: The file or folder no longer exists."),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh folder" }));

    expect(await screen.findByText("Library")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load this folder")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "usr" })).toBeInTheDocument();
  });

  it("preserves the normal error state for a genuine filesystem error, without recovering", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    await openFolderRow("Desktop");
    await openFolderRow("Projects");
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    providerMock.listDirectory.mockImplementation((path?: string) => {
      if (path === "/Users/usr/Desktop") {
        return Promise.resolve(pathListing("/Users/usr/Desktop", "/Users/usr", false, []));
      }
      return Promise.reject(new Error("Unable to open this folder: Permission denied."));
    });

    // Clear call history from the navigation phase so only refresh-triggered
    // calls are checked — we want to verify recovery did NOT fire for a
    // genuine (non-dead) error.
    providerMock.listDirectory.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Refresh folder" }));

    expect(await screen.findByText("Couldn't load this folder")).toBeInTheDocument();
    expect(
      screen.getByText("Unable to open this folder: Permission denied."),
    ).toBeInTheDocument();
    // Recovery must not silently jump elsewhere for a genuine error.
    expect(providerMock.listDirectory).not.toHaveBeenCalledWith("/Users/usr/Desktop");
  });
});

describe("App derived-view refresh after mutations", () => {
  beforeEach(() => {
    providerMock.listDirectory.mockResolvedValue(
      listing([
        {
          ...fileItem("Documents"),
          type: "folder",
          isFolder: true,
          size: "—",
          sizeBytes: 0,
          location: "/Users/usr/Desktop",
          path: "/Users/usr/Desktop/Documents",
          id: "/Users/usr/Desktop/Documents",
        },
        fileItem("report.zip"),
      ]),
    );
    providerMock.recentFiles.mockResolvedValue([fileItem("report.zip")]);
    providerMock.resolveStarredPaths.mockResolvedValue({ items: [], missing: [] });
    providerMock.diskUsage.mockResolvedValue({ totalBytes: 1000, freeBytes: 400 });
    providerMock.openItem.mockResolvedValue(undefined);
    providerMock.searchFiles.mockResolvedValue({ entries: [], truncated: false });
    providerMock.duplicateItem.mockResolvedValue("/Users/usr/Desktop/report (copy).zip");
    providerMock.copyItem.mockResolvedValue(undefined);
    providerMock.storageByCategory.mockResolvedValue({
      categories: [],
      totalBytes: 0,
      scannedFileCount: 0,
      scanCapped: false,
    });
    providerMock.createFolder.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("re-reads Recent after duplicating a previewed file", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("report.zip"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();
    const recentBefore = providerMock.recentFiles.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));

    await waitFor(() => {
      expect(providerMock.duplicateItem).toHaveBeenCalledWith("/Users/usr/Desktop/report.zip");
    });
    await waitFor(() => {
      expect(providerMock.recentFiles.mock.calls.length).toBeGreaterThan(recentBefore);
    });
  });

  it("re-reads Recent after creating a folder in the Files view", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    const recentBefore = providerMock.recentFiles.mock.calls.length;

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.change(screen.getByPlaceholderText("Folder name"), {
      target: { value: "Assets" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(providerMock.createFolder).toHaveBeenCalledWith("/Users/usr/Desktop", "Assets");
    });
    await waitFor(() => {
      expect(providerMock.recentFiles.mock.calls.length).toBeGreaterThan(recentBefore);
    });
  });

  it("re-runs an open Search after a rename so results stay live", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("report.zip"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();

    const searchBox = screen.getByPlaceholderText("Search files, folders, or ask anything…");
    fireEvent.change(searchBox, { target: { value: "report" } });
    fireEvent.submit(searchBox.closest("form") as HTMLFormElement);
    await waitFor(() => {
      expect(providerMock.searchFiles).toHaveBeenCalledWith("report");
    });
    const searchBefore = providerMock.searchFiles.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("report.zip"), {
      target: { value: "renamed.zip" },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    await waitFor(() => {
      expect(providerMock.renameItem).toHaveBeenCalledWith(
        "/Users/usr/Desktop/report.zip",
        "renamed.zip",
      );
    });
    // The already-open Search view re-queried the real filesystem.
    await waitFor(() => {
      expect(providerMock.searchFiles.mock.calls.length).toBeGreaterThan(searchBefore);
    });
    expect(providerMock.searchFiles).toHaveBeenLastCalledWith("report");
  });

  it("rescans Storage after a mutation while the Storage view is open", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByText("report.zip"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Storage" }));
    await waitFor(() => {
      expect(providerMock.storageByCategory.mock.calls.length).toBeGreaterThan(0);
    });
    const storageBefore = providerMock.storageByCategory.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(providerMock.trashItem).toHaveBeenCalledWith("/Users/usr/Desktop/report.zip");
    });
    await waitFor(() => {
      expect(providerMock.storageByCategory.mock.calls.length).toBeGreaterThan(storageBefore);
    });

    confirmSpy.mockRestore();
  });

  it("does not rescan Storage when the Storage view is not open", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("report.zip"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await waitFor(() => {
      expect(providerMock.duplicateItem).toHaveBeenCalledWith("/Users/usr/Desktop/report.zip");
    });
    expect(providerMock.storageByCategory).not.toHaveBeenCalled();
  });
});