import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import FilePreview from "./FilePreview";
import type { FileItem } from "../types";

const readFileMock = vi.hoisted(() => vi.fn());
const listDirectoryMock = vi.hoisted(() => vi.fn());
const createObjectURLMock = vi.hoisted(() => vi.fn());
const revokeObjectURLMock = vi.hoisted(() => vi.fn());

vi.mock("../services/filesystem", () => ({
  getFilesystemProvider: () => ({ readFile: readFileMock, listDirectory: listDirectoryMock }),
}));

function file(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: "/Users/usr/Desktop/photo.png",
    name: "photo.png",
    type: "png",
    size: "2.4 MB",
    sizeBytes: 2400000,
    modified: "Sep 1, 2026",
    created: "Aug 1, 2026",
    createdTs: 1,
    modifiedTs: 1,
    location: "/Users/usr/Desktop",
    path: "/Users/usr/Desktop/photo.png",
    starred: false,
    ...overrides,
  };
}

interface PreviewActions {
  onOpen?: () => void;
  onStar?: () => void;
  onDelete?: () => void;
  onRename?: (name: string) => Promise<string | null> | string | null | void;
  onMove?: (dest: string) => void;
  onDuplicate?: () => void;
  onCopy?: (dest: string) => void;
}

function renderPreview(overrides: Partial<FileItem> = {}, actions: PreviewActions = {}) {
  return render(
    <FilePreview
      file={file(overrides)}
      onClose={() => {}}
      onOpen={actions.onOpen ?? (() => {})}
      onStar={actions.onStar ?? (() => {})}
      onDelete={actions.onDelete ?? (() => {})}
      onRename={actions.onRename ?? (() => {})}
      onMove={actions.onMove ?? (() => {})}
      onDuplicate={actions.onDuplicate ?? (() => {})}
      onCopy={actions.onCopy ?? (() => {})}
    />,
  );
}

describe("FilePreview", () => {
  beforeEach(() => {
    listDirectoryMock.mockResolvedValue({
      path: "/Users/usr/Desktop",
      parentPath: "/Users/usr",
      isHome: false,
      items: [],
    });
    createObjectURLMock.mockReturnValue("blob:mock-url");
    Object.defineProperty(URL, "createObjectURL", {
      writable: true,
      configurable: true,
      value: createObjectURLMock,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      writable: true,
      configurable: true,
      value: revokeObjectURLMock,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("reads the REAL file bytes and renders an <img> preview for a supported image", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));

    renderPreview({ name: "photo.png", type: "png" });

    // Real provider read, converted to a blob object URL.
    expect(await screen.findByRole("img")).toBeInTheDocument();
    expect(readFileMock).toHaveBeenCalledWith("/Users/usr/Desktop/photo.png");
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img")).toHaveAttribute("src", "blob:mock-url");
    expect(screen.getByRole("img")).toHaveAttribute("alt", "photo.png");
  });

  it("renders a <video controls> preview for a supported video", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([0, 0, 0, 18]));

    renderPreview({ name: "clip.mp4", type: "mp4", path: "/Users/usr/Desktop/clip.mp4" });

    const video = await screen.findByTestId("preview-video");
    expect(video).toHaveAttribute("src", "blob:mock-url");
    expect(video).toHaveAttribute("controls");
    expect(readFileMock).toHaveBeenCalledWith("/Users/usr/Desktop/clip.mp4");
  });

  it("keeps unsupported types as an honest unavailable state and never reads them", () => {
    renderPreview({ name: "report.pdf", type: "pdf", path: "/Users/usr/Desktop/report.pdf" });

    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(createObjectURLMock).not.toHaveBeenCalled();
  });

  it("shows the loading state while bytes are being read", () => {
    readFileMock.mockReturnValue(new Promise(() => {}));

    renderPreview();

    expect(screen.getByText("Loading preview…")).toBeInTheDocument();
  });

  it("surfaces a real read error honestly instead of inventing a preview", async () => {
    readFileMock.mockRejectedValue(new Error("permission denied"));

    renderPreview();

    expect(await screen.findByText("This file couldn't be previewed")).toBeInTheDocument();
    expect(screen.getByText("permission denied")).toBeInTheDocument();
    expect(createObjectURLMock).not.toHaveBeenCalled();
  });

  it("revokes the object URL when the preview unmounts", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const { unmount } = renderPreview();
    await screen.findByRole("img");

    const created = createObjectURLMock.mock.results[0]?.value;
    unmount();
    expect(revokeObjectURLMock).toHaveBeenCalledWith(created);
  });

  it("preserves the metadata and action controls", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));

    renderPreview();

    expect(await screen.findByRole("img")).toBeInTheDocument();
    for (const label of ["Open", "Rename", "Move", "Copy to…", "Duplicate", "Star", "Delete"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getAllByText("PNG").length).toBeGreaterThan(0);
    expect(screen.getByText("2.4 MB")).toBeInTheDocument();
    expect(screen.getAllByText("/Users/usr/Desktop").length).toBeGreaterThan(0);
  });

  it("runs the Duplicate action for the file", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const onDuplicate = vi.fn();

    renderPreview({}, { onDuplicate });
    await screen.findByRole("img");

    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it("opens the copy picker and confirms against a chosen destination as Copy here", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const onCopy = vi.fn();

    renderPreview({}, { onCopy });
    await screen.findByRole("img");

    fireEvent.click(screen.getByRole("button", { name: "Copy to…" }));

    expect(await screen.findByText(/Copy "photo.png" to/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy here" }));

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith("/Users/usr/Desktop");
  });

  it("uses an inline rename dialog instead of window.prompt, trims, and closes on success", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("hacked.png");
    const onRename = vi.fn().mockResolvedValue(null);

    renderPreview({}, { onRename });
    await screen.findByRole("img");

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByDisplayValue("photo.png");
    fireEvent.change(input, { target: { value: "  new.png  " } });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledTimes(1);
    });
    expect(onRename).toHaveBeenCalledWith("new.png");
    expect(promptSpy).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("new.png")).not.toBeInTheDocument();
  });

  it("keeps the inline rename dialog open and shows the error when the rename fails", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const onRename = vi
      .fn()
      .mockResolvedValue("A file or folder with that name already exists.");

    renderPreview({}, { onRename });
    await screen.findByRole("img");

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("photo.png"), {
      target: { value: "new.png" },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    expect(
      await screen.findByText("A file or folder with that name already exists."),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("new.png")).toBeInTheDocument();
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("does not submit a blank name through the inline rename dialog", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const onRename = vi.fn().mockResolvedValue(null);

    renderPreview({}, { onRename });
    await screen.findByRole("img");

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("photo.png"), {
      target: { value: "   " },
    });
    const renameButtons = screen.getAllByRole("button", { name: "Rename" });
    fireEvent.click(renameButtons[renameButtons.length - 1]);

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Rename" }).length).toBe(2);
  });
});