import { useEffect, useState } from "react";

/**
 * Application settings persistence.
 *
 * Settings are webview-level application preferences (how the Files view opens
 * and whether destructive actions ask first), so they live in localStorage —
 * the same client-side pattern the rest of the app uses for app metadata.
 * They are NOT filesystem facts and never go through the Rust/Tauri backend.
 *
 * Hydration is synchronous on first render (lazy initial state), so the stored
 * values are stable across navigation and view remounts: a freshly mounted
 * Files view reads the current settings from the very first render.
 */

export type DefaultView = "List" | "Grid";
export type SortFilesBy = "Name" | "Modified" | "Size";

export interface AppSettings {
  defaultView: DefaultView;
  sortFilesBy: SortFilesBy;
  confirmDelete: boolean;
}

const STORAGE_KEY = "smartfile.settings";

export const DEFAULT_SETTINGS: AppSettings = {
  defaultView: "List",
  sortFilesBy: "Modified",
  confirmDelete: true,
};

function isDefaultView(v: unknown): v is DefaultView {
  return v === "List" || v === "Grid";
}

function isSortFilesBy(v: unknown): v is SortFilesBy {
  return v === "Name" || v === "Modified" || v === "Size";
}

/** Read persisted settings, falling back to defaults on any corrupt value. */
export function readSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SETTINGS;
    const p = parsed as Partial<AppSettings>;
    return {
      defaultView: isDefaultView(p.defaultView)
        ? p.defaultView
        : DEFAULT_SETTINGS.defaultView,
      sortFilesBy: isSortFilesBy(p.sortFilesBy)
        ? p.sortFilesBy
        : DEFAULT_SETTINGS.sortFilesBy,
      confirmDelete:
        typeof p.confirmDelete === "boolean"
          ? p.confirmDelete
          : DEFAULT_SETTINGS.confirmDelete,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(readSettings);

  // Persist every change; the next mount hydrates from the same store, so the
  // settings never reset when navigating between views.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // A full storage failure shouldn't break the session; the in-memory
      // value still drives behavior for this run.
    }
  }, [settings]);

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings((prev) => ({ ...prev, ...patch }));
  }

  return { settings, updateSettings };
}