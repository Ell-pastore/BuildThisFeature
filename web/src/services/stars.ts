import { useEffect, useRef, useState } from "react";
import { getFilesystemProvider } from "./filesystem";

/**
 * Application metadata persistence — starred files.
 *
 * The filesystem itself is the source of truth for files. Starred status is
 * *application metadata* about files, so it is stored separately from the
 * files themselves. The Desktop provider persists the set to a `stars.json`
 * file in the Tauri app-local data directory (atomic writes) and is the
 * authoritative, ongoing source of truth. The absolute path is the key so
 * stars survive across directory navigation.
 *
 * The legacy webview `localStorage` store is used only as a one-time seed:
 * on the first mount where the provider reports an empty store, any legacy
 * stars are migrated into provider storage and the legacy key is removed.
 * localStorage is never read or written afterwards.
 */
const LEGACY_KEY = "smartfile.stars";

function readLegacyStars(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((p) => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

function clearLegacyStars(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Ignore storage failures; the map still persists through the provider.
  }
}

export function useStars() {
  const provider = getFilesystemProvider();
  const hydrated = useRef(false);
  const dirtyBeforeHydration = useRef(false);
  // The legacy store only gives the UI an instant seed while the provider
  // hydrates; the provider becomes the source of truth once loaded.
  const [stars, setStars] = useState<string[]>(readLegacyStars);

  useEffect(() => {
    if (hydrated.current) {
      return;
    }
    hydrated.current = true;
    let cancelled = false;

    provider
      .loadStarredPaths()
      .then((loaded) => {
        if (cancelled || dirtyBeforeHydration.current) {
          return;
        }
        if (loaded.length === 0) {
          // One-time migration: move any legacy localStorage stars into the
          // provider store, then consume the legacy key so those stars can
          // never resurrect themselves later.
          const legacy = readLegacyStars();
          if (legacy.length > 0) {
            setStars(legacy);
            provider
              .saveStarredPaths(legacy)
              .then(() => clearLegacyStars())
              .catch(() => {
                // Keep the legacy key so the seed is retried next launch.
              });
            return;
          }
        }
        setStars(loaded);
        clearLegacyStars();
      })
      .catch(() => {
        // Provider unavailable (e.g. web preview): keep the legacy seed so the
        // app still works, but never treat it as the ongoing source of truth.
        if (cancelled) {
          return;
        }
        setStars(readLegacyStars());
      });

    return () => {
      cancelled = true;
    };
  }, [provider]);

  // Persist every change through the provider once hydrated. The legacy store
  // is neither read nor written here.
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    provider.saveStarredPaths(stars).catch(() => {
      // The desktop app stays usable if a save fails transiently; the next
      // toggle retries.
    });
  }, [provider, stars]);

  function isStarred(path: string): boolean {
    return stars.includes(path);
  }

  function toggleStar(path: string): void {
    if (!hydrated.current) {
      dirtyBeforeHydration.current = true;
    }
    setStars((prev) =>
      prev.includes(path)
        ? prev.filter((p) => p !== path)
        : [...prev, path],
    );
  }

  return { stars, isStarred, toggleStar };
}