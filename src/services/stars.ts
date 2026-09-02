import { useEffect, useState } from "react";

/**
 * Application metadata persistence — starred files.
 *
 * The filesystem itself is the source of truth for files. Starred status is
 * *application metadata* about files, so it is stored separately. We use the
 * simplest local mechanism (localStorage) rather than a database: the set is
 * tiny and must persist across app restarts within the Tauri webview. The
 * absolute path is the key so stars survive across directory navigation.
 */
const STORAGE_KEY = "smartfile.stars";

function loadStars(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((p) => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

export function useStars() {
  const [stars, setStars] = useState<string[]>(loadStars);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stars));
    } catch {
      // Ignore persistence failures (e.g. storage disabled); app still works.
    }
  }, [stars]);

  function isStarred(path: string): boolean {
    return stars.includes(path);
  }

  function toggleStar(path: string): void {
    setStars((prev) =>
      prev.includes(path)
        ? prev.filter((p) => p !== path)
        : [...prev, path],
    );
  }

  return { stars, isStarred, toggleStar };
}