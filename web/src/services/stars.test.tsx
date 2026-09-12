import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useStars } from "./stars";

const LEGACY_KEY = "smartfile.stars";

const loadStarredPathsMock = vi.hoisted(() => vi.fn());
const saveStarredPathsMock = vi.hoisted(() => vi.fn());

vi.mock("./filesystem", () => ({
  getFilesystemProvider: () => ({
    loadStarredPaths: loadStarredPathsMock,
    saveStarredPaths: saveStarredPathsMock,
  }),
}));

function seedLegacy(paths: string[]): void {
  localStorage.setItem(LEGACY_KEY, JSON.stringify(paths));
}

describe("useStars", () => {
  beforeEach(() => {
    localStorage.clear();
    loadStarredPathsMock.mockReset().mockResolvedValue([]);
    saveStarredPathsMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("hydrates star state from the provider, ignoring any legacy seed", async () => {
    loadStarredPathsMock.mockResolvedValue([
      "/Users/usr/Desktop/report.pdf",
      "/Users/usr/Docs/notes.txt",
    ]);
    seedLegacy(["/Users/usr/legacy.txt"]);

    const { result } = renderHook(() => useStars());

    await waitFor(() => {
      expect(result.current.stars).toEqual([
        "/Users/usr/Desktop/report.pdf",
        "/Users/usr/Docs/notes.txt",
      ]);
    });
    expect(result.current.isStarred("/Users/usr/Desktop/report.pdf")).toBe(true);
    expect(result.current.isStarred("/Users/usr/legacy.txt")).toBe(false);
    // The provider is the authoriative source, so the legacy key is removed.
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("migrates legacy localStorage stars into the provider once", async () => {
    seedLegacy(["/Users/usr/legacy.txt"]);

    const { result } = renderHook(() => useStars());

    await waitFor(() => {
      expect(result.current.isStarred("/Users/usr/legacy.txt")).toBe(true);
    });
    expect(saveStarredPathsMock.mock.calls.length).toBeGreaterThan(0);
    expect(saveStarredPathsMock.mock.calls.at(-1)?.[0]).toEqual([
      "/Users/usr/legacy.txt",
    ]);
    await waitFor(() => {
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    });
  });

  it("persists star/unstar changes through the provider", async () => {
    loadStarredPathsMock.mockResolvedValue(["/Users/usr/Desktop/report.pdf"]);
    seedLegacy(["/Users/usr/legacy.txt"]);

    const { result } = renderHook(() => useStars());

    await waitFor(() => {
      expect(result.current.stars).toEqual(["/Users/usr/Desktop/report.pdf"]);
    });

    act(() => {
      result.current.toggleStar("/Users/usr/Desktop/photo.png");
    });

    await waitFor(() => {
      expect(result.current.isStarred("/Users/usr/Desktop/photo.png")).toBe(true);
    });
    await waitFor(() => {
      const saved = saveStarredPathsMock.mock.calls;
      expect(saved.some((call) => call[0]?.includes("/Users/usr/Desktop/photo.png"))).toBe(true);
    });

    act(() => {
      result.current.toggleStar("/Users/usr/Desktop/photo.png");
    });
    await waitFor(() => {
      const saved = saveStarredPathsMock.mock.calls;
      expect(
        saved.some((call) => call[0] !== undefined && !call[0].includes("/Users/usr/Desktop/photo.png")),
      ).toBe(true);
    });
  });

  it("keeps working (and keeps the seed key) when the provider is unavailable", async () => {
    loadStarredPathsMock.mockRejectedValue(new Error("Stars are not configured"));
    seedLegacy(["/Users/usr/offline.txt"]);

    const { result } = renderHook(() => useStars());

    await waitFor(() => {
      expect(result.current.isStarred("/Users/usr/offline.txt")).toBe(true);
    });

    act(() => {
      result.current.toggleStar("/Users/usr/added.txt");
    });
    expect(result.current.isStarred("/Users/usr/added.txt")).toBe(true);
    // Never treated as the ongoing source of truth: the legacy key is kept
    // only as long as the provider cannot take over.
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });

  it("migrates a starred path to its new path on rename", async () => {
    loadStarredPathsMock.mockResolvedValue(["/Users/usr/Desktop/report.pdf"]);

    const { result } = renderHook(() => useStars());

    await waitFor(() => {
      expect(result.current.isStarred("/Users/usr/Desktop/report.pdf")).toBe(true);
    });

    act(() => {
      result.current.updateStarPath(
        "/Users/usr/Desktop/report.pdf",
        "/Users/usr/Desktop/renamed.pdf",
      );
    });

    expect(result.current.isStarred("/Users/usr/Desktop/renamed.pdf")).toBe(true);
    expect(result.current.isStarred("/Users/usr/Desktop/report.pdf")).toBe(false);
    await waitFor(() => {
      expect(
        saveStarredPathsMock.mock.calls.some((call) =>
          call[0]?.includes("/Users/usr/Desktop/renamed.pdf"),
        ),
      ).toBe(true);
    });
  });

  it("does not migrate when the old path was never starred", async () => {
    loadStarredPathsMock.mockResolvedValue(["/Users/usr/Desktop/other.txt"]);

    const { result } = renderHook(() => useStars());

    await waitFor(() => {
      expect(result.current.isStarred("/Users/usr/Desktop/other.txt")).toBe(true);
    });

    act(() => {
      result.current.updateStarPath(
        "/Users/usr/Desktop/notes.txt",
        "/Users/usr/Desktop/renamed.txt",
      );
    });

    expect(result.current.isStarred("/Users/usr/Desktop/renamed.txt")).toBe(false);
    expect(
      saveStarredPathsMock.mock.calls.some((call) => call[0]?.includes("renamed.txt")),
    ).toBe(false);
  });

  it("removes the starred path for an item sent to trash", async () => {
    loadStarredPathsMock.mockResolvedValue(["/Users/usr/Desktop/report.pdf"]);

    const { result } = renderHook(() => useStars());

    await waitFor(() => {
      expect(result.current.isStarred("/Users/usr/Desktop/report.pdf")).toBe(true);
    });

    act(() => {
      result.current.removeStarPath("/Users/usr/Desktop/report.pdf");
    });

    expect(result.current.isStarred("/Users/usr/Desktop/report.pdf")).toBe(false);
    await waitFor(() => {
      expect(
        saveStarredPathsMock.mock.calls.some(
          (call) => call[0] !== undefined && !call[0].includes("/Users/usr/Desktop/report.pdf"),
        ),
      ).toBe(true);
    });
  });
});