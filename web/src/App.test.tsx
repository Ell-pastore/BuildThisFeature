import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "./App";
import type { FileItem } from "./types";

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
vi.mock("./components/views/Trash", () => ({ default: () => null }));
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

function listing(items: FileItem[]) {
  return {
    path: "/Users/usr/Desktop",
    parentPath: "/Users/usr",
    isHome: false,
    items,
  };
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
        fileItem("report.pdf"),
      ]),
    );
    providerMock.recentFiles.mockResolvedValue([]);
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

    fireEvent.click(await screen.findByText("report.pdf"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();

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
        "/Users/usr/Desktop/report.pdf",
        "/Users/usr/Desktop/Documents",
      );
    });
    expect(screen.getAllByText("/Users/usr/Desktop/Documents").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(starsHook.updateStarPath).toHaveBeenCalledWith(
        "/Users/usr/Desktop/report.pdf",
        "/Users/usr/Desktop/Documents/report.pdf",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(providerMock.openItem).toHaveBeenCalledWith(
        "/Users/usr/Desktop/Documents/report.pdf",
      );
    });
  });

  it("releases the stored star path when a previewed file is moved to trash", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByText("report.pdf"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(providerMock.trashItem).toHaveBeenCalledWith("/Users/usr/Desktop/report.pdf");
    });
    await waitFor(() => {
      expect(starsHook.removeStarPath).toHaveBeenCalledWith("/Users/usr/Desktop/report.pdf");
    });

    confirmSpy.mockRestore();
  });
});

describe("App rename preview synchronization", () => {
  beforeEach(() => {
    providerMock.listDirectory.mockResolvedValue(listing([fileItem("report.pdf")]));
    providerMock.recentFiles.mockResolvedValue([]);
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

    fireEvent.click(await screen.findByText("report.pdf"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("report.pdf"), {
      target: { value: "renamed.pdf" },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    await waitFor(() => {
      expect(providerMock.renameItem).toHaveBeenCalledWith(
        "/Users/usr/Desktop/report.pdf",
        "renamed.pdf",
      );
    });
    expect((await screen.findAllByText("renamed.pdf")).length).toBeGreaterThan(0);
    expect(screen.queryByDisplayValue("renamed.pdf")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(providerMock.openItem).toHaveBeenCalledWith("/Users/usr/Desktop/renamed.pdf");
    });
  });

  it("keeps the preview open with the inline error and never routes a rename failure into the folder error state", async () => {
    providerMock.renameItem.mockRejectedValue(
      new Error("A file or folder with that name already exists."),
    );
    render(<App />);

    fireEvent.click(await screen.findByText("report.pdf"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("report.pdf"), {
      target: { value: "renamed.pdf" },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    expect(
      await screen.findByText("A file or folder with that name already exists."),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("renamed.pdf")).toBeInTheDocument();
    expect(screen.getAllByText("report.pdf").length).toBeGreaterThan(0);
    expect(providerMock.openItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect((await screen.findAllByText("report.pdf")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Couldn't load this folder")).not.toBeInTheDocument();
  });

  it("keeps a starred file starred after a rename by migrating the stored path", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("report.pdf"));
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("report.pdf"), {
      target: { value: "renamed.pdf" },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    await waitFor(() => {
      expect(starsHook.updateStarPath).toHaveBeenCalledWith(
        "/Users/usr/Desktop/report.pdf",
        "/Users/usr/Desktop/renamed.pdf",
      );
    });
  });
});