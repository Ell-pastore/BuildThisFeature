import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { DEFAULT_SETTINGS, readSettings, useSettings } from "./settings";

describe("settings persistence", () => {
  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  it("returns defaults when nothing is stored yet", () => {
    expect(readSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("persists every change to localStorage", () => {
    const { result } = renderHook(() => useSettings());

    act(() => {
      result.current.updateSettings({ defaultView: "Grid", sortFilesBy: "Size" });
    });

    const stored = localStorage.getItem("smartfile.settings");
    expect(stored).toBe(
      JSON.stringify({
        defaultView: "Grid",
        sortFilesBy: "Size",
        confirmDelete: true,
        aiQuality: "Low",
      }),
    );
  });

  it("hydrates a fresh mount from the persisted values (stable across remounts)", () => {
    localStorage.setItem(
      "smartfile.settings",
      JSON.stringify({ defaultView: "Grid", sortFilesBy: "Name", confirmDelete: false }),
    );

    // A previous session's settings survive for the next component lifetime.
    expect(readSettings()).toEqual({
      defaultView: "Grid",
      sortFilesBy: "Name",
      confirmDelete: false,
      aiQuality: "Low",
    });

    const { result, unmount } = renderHook(() => useSettings());
    expect(result.current.settings).toEqual({
      defaultView: "Grid",
      sortFilesBy: "Name",
      confirmDelete: false,
      aiQuality: "Low",
    });

    // Unmounting and mounting again (view navigation remounts) keeps values.
    unmount();
    const remounted = renderHook(() => useSettings());
    expect(remounted.result.current.settings).toEqual({
      defaultView: "Grid",
      sortFilesBy: "Name",
      confirmDelete: false,
      aiQuality: "Low",
    });
  });

  it("falls back to defaults on corrupt stored data", () => {
    localStorage.setItem("smartfile.settings", "{not json");
    expect(readSettings()).toEqual(DEFAULT_SETTINGS);

    localStorage.setItem("smartfile.settings", JSON.stringify({ defaultView: "Bogus" }));
    expect(readSettings().defaultView).toBe("List");
  });

  it("reads a persisted AI Quality preference", () => {
    localStorage.setItem(
      "smartfile.settings",
      JSON.stringify({ aiQuality: "High" }),
    );
    expect(readSettings().aiQuality).toBe("High");
  });

  it("falls back to the default AI Quality on an unknown stored value", () => {
    localStorage.setItem(
      "smartfile.settings",
      JSON.stringify({ aiQuality: "Bogus" }),
    );
    expect(readSettings().aiQuality).toBe("Low");
  });
});

describe("useSettings", () => {
  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  it("accepts partial updates without losing other settings", () => {
    const { result } = renderHook(() => useSettings());

    act(() => {
      result.current.updateSettings({ confirmDelete: false });
    });

    expect(result.current.settings).toEqual({
      ...DEFAULT_SETTINGS,
      confirmDelete: false,
    });
  });

  it("updates each supported setting independently and persists them", () => {
    const { result } = renderHook(() => useSettings());

    act(() => {
      result.current.updateSettings({ defaultView: "Grid" });
    });
    expect(result.current.settings.defaultView).toBe("Grid");
    expect(result.current.settings.sortFilesBy).toBe("Modified");

    act(() => {
      result.current.updateSettings({ sortFilesBy: "Name" });
    });
    expect(result.current.settings.defaultView).toBe("Grid");
    expect(result.current.settings.sortFilesBy).toBe("Name");

    act(() => {
      result.current.updateSettings({ aiQuality: "High" });
    });
    expect(result.current.settings.aiQuality).toBe("High");

    expect(JSON.parse(localStorage.getItem("smartfile.settings") ?? "{}")).toEqual({
      defaultView: "Grid",
      sortFilesBy: "Name",
      confirmDelete: true,
      aiQuality: "High",
    });
  });
});