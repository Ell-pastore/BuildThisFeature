import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Trash from "./Trash";
import type { TrashItem } from "../../types";

const listTrashMock = vi.hoisted(() => vi.fn());
const restoreItemMock = vi.hoisted(() => vi.fn());
const permanentlyDeleteMock = vi.hoisted(() => vi.fn());

vi.mock("../../services/filesystem", () => ({
  getFilesystemProvider: () => ({
    listTrash: listTrashMock,
    restoreItem: restoreItemMock,
    permanentlyDeleteTrashItem: permanentlyDeleteMock,
  }),
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
    permanentlyDeleteMock.mockResolvedValue("/Users/usr/.trash-smart-file-manager/report.pdf");
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

  it("permanently deletes through the provider after confirmation and reloads", async () => {
    listTrashMock.mockResolvedValue([trashed()]);

    render(<Trash />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete report.pdf permanently?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => {
      expect(permanentlyDeleteMock).toHaveBeenCalledWith(
        "/Users/usr/.trash-smart-file-manager/report.pdf",
      );
    });
    // The list is re-read from the provider only after the deletion succeeds.
    expect(listTrashMock).toHaveBeenCalledTimes(2);
  });

  it("cancelling the confirmation deletes nothing and does not reload", async () => {
    listTrashMock.mockResolvedValue([trashed()]);

    render(<Trash />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Delete report.pdf permanently?")).not.toBeInTheDocument();
    expect(permanentlyDeleteMock).not.toHaveBeenCalled();
    expect(listTrashMock).toHaveBeenCalledTimes(1);
  });

  it("shows a deletion error honestly and keeps the row listed", async () => {
    listTrashMock.mockResolvedValue([trashed()]);
    permanentlyDeleteMock.mockRejectedValue(new Error("Unable to delete from trash: denied"));

    render(<Trash />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByText("Unable to delete from trash: denied")).toBeInTheDocument();
    // No optimistic removal and no reload on failure.
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(listTrashMock).toHaveBeenCalledTimes(1);
  });
});