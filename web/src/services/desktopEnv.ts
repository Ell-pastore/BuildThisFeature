/**
 * Desktop-environment detection (Phase 10.39).
 *
 * The same Vite app is served to a plain browser (via the preview/dev server)
 * and to the Tauri desktop webview. Tauri's runtime injects
 * `__TAURI_INTERNALS__` into the window; its presence is the ONLY signal we
 * use to decide whether the real Tauri IPC bridge is reachable. A plain
 * browser never has it, so every desktop-only code path (the
 * `x-desktop-host` header and the host-execution driver) stays OFF there and
 * the backend's fail-closed behavior remains authoritative.
 */
export function isTauriEnv(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}