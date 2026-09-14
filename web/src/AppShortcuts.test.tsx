import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import type { FileItem } from "./types";

// The same provider mock lifted by the original App.test.tsx, so the real
// TopBar/Sidebar/Files/Duplicates/AIOrganization views get real data.
const providerMock = vi.hoisted(() => {
  const provider: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of [
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
    "duplicateGroups",
  ]) {
    provider[m] = vi.fn();
  }
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

// Real TopBar (search input), real Files (⌘N modal + Space preview), real
// Duplicates and AIOrganization (whose headings ⌘D / ⌘⇧O navigate to). The
// unrelated heavy views stay null-mocked like the original suite.
vi.mock("./components/AIAssistant", () => ({ default: () => null }));
vi.mock("./components/views/Recent", () => ({ default: () => null }));
vi.mock("./components/views/Starred", () => ({ default: () => null }));
vi.mock("./components/views/Search", () => ({ default: () => null }));
vi.mock("./components/views/AIHistoryView", () => ({ default: () => null }));
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
    createdTs: 1,
    modifiedTs: 2,
    location: "/Users/usr/Desktop",
    path: `/Users/usr/Desktop/${name}`,
    modified: "Sep 1, 2026",
    created: "Aug 1, 2026",
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

function fileListing() {
  return listing([fileItem("report.zip")]);
}

function navigateToFiles() {
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform ?? "");
function commandShortcut(e: KeyboardEvent) {
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

describe("App keyboard shortcuts", () => {
  beforeEach(async () => {
    // This is a real macOS desktop app: App.tsx decides ⌘-vs-Ctrl by reading
    // navigator.platform. jsdom defaults to "" (non-mac), which would flip the
    // whole suite into Ctrl-mode and silently make every ⌘ test pass-fail for
    // the wrong reason — so pin the platform the actual mac host reports.
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    providerMock.homeDirectory.mockResolvedValue("/Users/usr/Desktop");
    providerMock.listDirectory.mockResolvedValue(fileListing());
    providerMock.recentFiles.mockResolvedValue([fileItem("report.zip")]);
    providerMock.resolveStarredPaths.mockResolvedValue({ items: [], missing: [] });
    providerMock.diskUsage.mockResolvedValue({ totalBytes: 1000, freeBytes: 400 });
    providerMock.storageByCategory.mockResolvedValue([]);
    providerMock.searchFiles.mockResolvedValue({ items: [], truncated: false });
    providerMock.duplicateGroups.mockResolvedValue({ groups: [], truncated: false });
    providerMock.readFile.mockResolvedValue("pdf");
    providerMock.openItem.mockResolvedValue(undefined);
    starsHook.stars = [];
    starsHook.isStarred.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("⌘K focuses the existing Search input from any view", async () => {
    render(<App />);
    await screen.findByText("report.zip");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByPlaceholderText("Search files, folders, or ask anything…"),
      ),
    );
  });

  it("⌘N opens the existing New folder modal in the Files view", async () => {
    render(<App />);
    await screen.findByText("report.zip");
    navigateToFiles();
    await screen.findByText("report.zip");
    fireEvent.keyDown(document, { key: "n", metaKey: true });
    expect(await screen.findByText("New folder")).toBeInTheDocument();
  });

  it("Ctrl+N does nothing outside the Files view", async () => {
    render(<App />);
    await screen.findByText("report.zip");
    fireEvent.keyDown(document, { key: "n", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "New folder" })).not.toBeInTheDocument();
  });

  it("⌘D opens the existing Duplicates view", async () => {
    render(<App />);
    await screen.findByText("report.zip");
    fireEvent.keyDown(document, { key: "d", metaKey: true });
    expect(
      await screen.findByRole("heading", { name: "Duplicate Detection" }),
    ).toBeInTheDocument();
  });

  it("⌘⇧O opens the existing AI Organization view", async () => {
    render(<App />);
    await screen.findByText("report.zip");
    fireEvent.keyDown(document, { key: "o", metaKey: true, shiftKey: true });
    expect(
      await screen.findByRole("heading", { name: "AI Organization" }),
    ).toBeInTheDocument();
  });

  it("Space opens the existing preview for the selected item", async () => {
    render(<App />);
    await screen.findByText("report.zip");
    navigateToFiles();
    fireEvent.click(await screen.findByText("report.zip"));
    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();
  });

  it("Space does nothing with no selection", async () => {
    render(<App />);
    await screen.findByText("report.zip");
    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(screen.queryByText("Preview unavailable")).not.toBeInTheDocument();
  });

  it("ignores shortcuts while typing in an editable field", async () => {
    render(<App />);
    await screen.findByText("report.zip");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const input = screen.getByPlaceholderText("Search files, folders, or ask anything…");
    fireEvent.keyDown(input, { key: "d", metaKey: true });
    expect(
      screen.queryByRole("heading", { name: "Duplicate Detection" }),
    ).not.toBeInTheDocument();
  });

  it("uses Cmd on macOS and ignores bare Ctrl there", async () => {
    render(<App />);
    await screen.findByText("report.zip");
    fireEvent.keyDown(document, { key: "d", ctrlKey: true });
    expect(
      screen.queryByRole("heading", { name: "Duplicate Detection" }),
    ).not.toBeInTheDocument();
  });

  it("does nothing for unimplemented advertised shortcuts", async () => {
    render(<App />);
    await screen.findByText("report.zip");
    fireEvent.keyDown(document, { key: "z", metaKey: true });
    fireEvent.keyDown(document, { key: "u", metaKey: true });
    fireEvent.keyDown(document, { key: "o", metaKey: true });
    expect(screen.queryByText("Preview unavailable")).not.toBeInTheDocument();
  });
});
