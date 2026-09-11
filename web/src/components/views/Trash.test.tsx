import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Trash from "./Trash";
import type { TrashItem } from "../../types";

const listTrashMock = vi.hoisted(() => vi.fn());
const restoreItemMock = vi.hoisted(() => vi.fn());

vi.mock("../../services/filesystem", () => ({
  getFilesystemProvider: () => ({ listTrash: listTrashMock, restoreItem: restoreItemMock }),
}));

function trashed(overrides: Partial<TrashItem> = {}): TrashItem {
  return {
    id: "/Users/usr/.trash-smart-file-manager/report.pdf",
    name: "report.pdf",
    path: "/Users/usr/.trash-smart-file-manager/report.pdf",
    isFolder: false,
    size: "1.2 MB",
    sizeBytes: 1200000,
    fileType: "pdf",
    created: "Aug 1, 2026",
    modified: "Sep 1, 2026",
    createdTs: 1,
    modifiedTs: 2,
    originalPath: "/Users/usr/Desktop/report.pdf",
    ...overrides,
  };
}

describe("Trash", () => {
  beforeEach(() => {
    listTrashMock.mockResolvedValue([]);
    restoreItemMock.mockResolvedValue("/Users/usr/Desktop/report.pdf");
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("shows the loading state while reading the trash", () => {
    listTrashMock.mockReturnValue(new Promise(() => {}));

    render(<Trash />);

    expect(screen.getByText("Loading trash…")).toBeInTheDocument();
  });

  it("lists REAL trash contents from the provider", async () => {
    listTrashMock.mockResolvedValue([trashed()]);

    render(<Trash />);

    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("1.2 MB")).toBeInTheDocument();
    expect(screen.getByText("/Users/usr/Desktop/report.pdf")).toBeInTheDocument();
  });

  it("shows the honest empty state when the trash is actually empty", async () => {
    render(<Trash />);

    expect(await screen.findByText("Trash is empty")).toBeInTheDocument();
  });

  it("surfaces a real listing error honestly with a retry", async () => {
    listTrashMock.mockRejectedValue(new Error("Trash is not configured"));

    render(<Trash />);

    expect(await screen.findByText("Trash is not configured")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /Retry/ });

    listTrashMock.mockResolvedValue([trashed()]);
    fireEvent.click(retry);

    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
  });

  it("restores through the existing restoreItem flow and refreshes the view", async () => {
    listTrashMock.mockResolvedValue([trashed()]);

    render(<Trash />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    await waitFor(() => {
      expect(restoreItemMock).toHaveBeenCalledWith("/Users/usr/.trash-smart-file-manager/report.pdf");
    });
    // After a successful restore the list is re-read from the provider.
    expect(listTrashMock).toHaveBeenCalledTimes(2);
  });

  it("shows 'Unknown' as the honest original location when sidecar metadata is missing", async () => {
    listTrashMock.mockResolvedValue([trashed({ originalPath: null })]);

    render(<Trash />);

    expect(await screen.findByText("Unknown")).toBeInTheDocument();
  });
});