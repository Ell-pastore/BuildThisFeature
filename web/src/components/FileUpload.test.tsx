import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import FileUpload from "./FileUpload";

const writeFileMock = vi.hoisted(() => vi.fn());

vi.mock("../services/filesystem", () => ({
  getFilesystemProvider: () => ({ writeFile: writeFileMock }),
}));

function renderUpload(destDir = "/Users/usr/Desktop") {
  const onUploaded = vi.fn();
  render(
    <FileUpload
      destDir={destDir}
      onUploaded={onUploaded}
      renderTrigger={(openPicker) => (
        <button type="button" onClick={openPicker}>
          Upload
        </button>
      )}
    />,
  );
  return { onUploaded };
}

describe("FileUpload", () => {
  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("opens the file picker when the trigger is clicked", () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
    renderUpload();

    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });

  it("writes the selected file into the current directory via the provider", async () => {
    const { onUploaded } = renderUpload();
    writeFileMock.mockResolvedValue(undefined);

    fireEvent.change(screen.getByTestId("file-upload-input"), {
      target: { files: [new File(["hello"], "notes.txt")] },
    });

    await waitFor(() => {
      expect(writeFileMock).toHaveBeenCalledTimes(1);
    });
    expect(writeFileMock).toHaveBeenCalledWith(
      "/Users/usr/Desktop/notes.txt",
      new Uint8Array([104, 101, 108, 108, 111]),
    );
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("handles multiple selected files", async () => {
    const { onUploaded } = renderUpload();
    writeFileMock.mockResolvedValue(undefined);

    fireEvent.change(screen.getByTestId("file-upload-input"), {
      target: {
        files: [new File(["a"], "a.txt"), new File(["bb"], "b.png")],
      },
    });

    await waitFor(() => {
      expect(writeFileMock).toHaveBeenCalledTimes(2);
    });
    expect(writeFileMock).toHaveBeenCalledWith("/Users/usr/Desktop/a.txt", new Uint8Array([97]));
    expect(writeFileMock).toHaveBeenCalledWith("/Users/usr/Desktop/b.png", new Uint8Array([98, 98]));
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the picker is cancelled", async () => {
    const { onUploaded } = renderUpload();

    fireEvent.change(screen.getByTestId("file-upload-input"), {
      target: { files: [] },
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces a failed write without reporting the file as uploaded", async () => {
    const { onUploaded } = renderUpload();
    writeFileMock.mockRejectedValue(new Error("Permission denied"));

    fireEvent.change(screen.getByTestId("file-upload-input"), {
      target: { files: [new File(["x"], "blocked.txt")] },
    });

    expect(
      await screen.findByText("Couldn't upload blocked.txt: Permission denied"),
    ).toBeInTheDocument();
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("reports only the files that actually uploaded when some writes fail", async () => {
    const { onUploaded } = renderUpload();
    writeFileMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Denied"));

    fireEvent.change(screen.getByTestId("file-upload-input"), {
      target: {
        files: [new File(["ok"], "ok.txt"), new File(["bad"], "bad.txt")],
      },
    });

    expect(await screen.findByText("Couldn't upload bad.txt: Denied")).toBeInTheDocument();
    expect(writeFileMock).toHaveBeenCalledTimes(2);
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("calls onUploaded once a write succeeds so the parent can refresh", async () => {
    const { onUploaded } = renderUpload();
    writeFileMock.mockResolvedValue(undefined);

    fireEvent.change(screen.getByTestId("file-upload-input"), {
      target: { files: [new File(["data"], "data.bin")] },
    });

    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledTimes(1);
    });
  });
});