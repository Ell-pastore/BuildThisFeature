import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Storage from "./Storage";
import { formatBytes } from "../../services/format";
import type { DiskUsage, StorageBreakdown } from "../../services/filesystem";

/** Real-shaped breakdown with deterministic byte values (1 KB / 2 KB / 3 KB). */
function breakdown(overrides: Partial<StorageBreakdown> = {}): StorageBreakdown {
  return {
    categories: [
      { category: "Documents", bytes: 1024 },
      { category: "Images", bytes: 2048 },
      { category: "Videos", bytes: 0 },
      { category: "Audio", bytes: 0 },
      { category: "Archives", bytes: 0 },
      { category: "Code", bytes: 0 },
      { category: "Other", bytes: 0 },
    ],
    totalBytes: 3072,
    scannedFileCount: 2,
    scanCapped: false,
    ...overrides,
  };
}

function diskUsage(): DiskUsage {
  // 1 GB total, 0.5 GB free, 0.5 GB used — real OS-style volume numbers.
  return { totalBytes: 1024 * 1024 * 1024, freeBytes: 512 * 1024 * 1024 };
}

function renderStorage(props: Partial<React.ComponentProps<typeof Storage>> = {}) {
  const onRetry = vi.fn();
  render(
    <Storage
      diskUsage={diskUsage()}
      breakdown={breakdown()}
      onRetry={onRetry}
      {...props}
    />,
  );
  return { onRetry };
}

describe("Storage", () => {
  afterEach(cleanup);

  it("keeps the real disk-capacity card, showing true used/free numbers", () => {
    renderStorage({ breakdown: null });

    const du = diskUsage();
    const used = formatBytes(du.totalBytes - du.freeBytes);
    const free = formatBytes(du.freeBytes);
    // Used and available are both 512.0 MB here, so that value appears twice.
    expect(screen.getAllByText(used)).toHaveLength(2);
    expect(screen.getAllByText(free)).toHaveLength(2);
    expect(screen.getByText(`used of ${formatBytes(du.totalBytes)}`)).toBeInTheDocument();
  });

  it("shows the loading state while the category scan is in flight", () => {
    renderStorage({ breakdown: null, loading: true });

    expect(screen.getByText("Scanning your folders…")).toBeInTheDocument();
  });

  it("lists REAL per-category byte totals from the breakdown", () => {
    renderStorage();

    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("Images")).toBeInTheDocument();
    expect(screen.getByText("1.0 KB")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(screen.getByText("Based on 2 scanned files · 3.0 KB total")).toBeInTheDocument();
  });

  it("shows the honest empty state when nothing was classified", () => {
    renderStorage({
      breakdown: { ...breakdown(), scannedFileCount: 0, totalBytes: 0 },
    });

    expect(screen.getByText("No scanned files found")).toBeInTheDocument();
  });

  it("surfaces a real scan error honestly with a retry", () => {
    const { onRetry } = renderStorage({ breakdown: null, error: "Scan failed" });

    expect(screen.getByText("Scan failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("discloses a capped scan instead of presenting it as a full total", () => {
    renderStorage({ breakdown: { ...breakdown(), scanCapped: true } });

    expect(
      screen.getByText(/stopped at its safety limit/i),
    ).toBeInTheDocument();
  });
});