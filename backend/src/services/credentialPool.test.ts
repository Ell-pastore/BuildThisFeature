/**
 * Provider credential pool tests (Phase 10.11).
 *
 * All values are FAKE test credentials — never real API keys. These tests
 * prove the pool:
 *
 *   1. Registers credentials per provider and hands back opaque handles.
 *   2. Reveals a registered value through the controlled `reveal()` path.
 *   3. Supports MULTIPLE credentials per provider.
 *   4. Selects DETERMINISTICALLY (first registered; stable ordering).
 *   5. Fails clearly with a typed error when a provider has no credentials.
 *   6. ISOLATES providers — a credential is never visible under another id.
 *   7. Rejects duplicate credential ids and empty values.
 *   8. Keeps credential VALUES out of handles, JSON, errors, and provider
 *      construction results (opacity / no-secrets guarantees).
 */
import { describe, expect, it, vi } from "vitest";

import {
  CredentialPool,
  CredentialPoolError,
  isCredentialPoolError,
  type OpaqueCredential,
} from "./credentialPool.js";
import { ProviderId, ProviderRegistry } from "./providerSelection.js";
import { createGrokProvider } from "./grokProvider.js";

// ---------------------------------------------------------------------------
// Fixtures (FAKE values only — no real keys anywhere)
// ---------------------------------------------------------------------------

const FAKE_GROK_KEY = "xai-fake-secret-1";
const FAKE_GROK_KEY_2 = "xai-fake-secret-2";
const FAKE_SECRET = "super-secret-fake-value";

function poolWithGrok(): { pool: CredentialPool } {
  const pool = new CredentialPool();
  pool.register(ProviderId.Grok, FAKE_GROK_KEY, "primary");
  pool.register(ProviderId.Grok, FAKE_GROK_KEY_2, "backup");
  return { pool };
}

function expectNoSecret(either: unknown): void {
  const message =
    typeof either === "string"
      ? either
      : (either as { message?: unknown } | null | undefined)?.message;
  const haystack = typeof message === "string" ? message : "";
  expect(haystack).not.toContain(FAKE_SECRET);
}

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------

describe("CredentialPool — registration", () => {
  it("registers a credential and hands back an opaque handle", () => {
    const pool = new CredentialPool();
    const handle = pool.register(ProviderId.Grok, FAKE_GROK_KEY, "primary");

    expect(pool.has(ProviderId.Grok)).toBe(true);
    expect(pool.registeredProviders).toEqual(["grok"]);
    expect(handle.id).toBe("primary");
    expect(handle.provider).toBe("grok");
  });

  it("auto-assigns a stable credential id when none is given", () => {
    const pool = new CredentialPool();
    const first = pool.register(ProviderId.Grok, FAKE_GROK_KEY);
    const second = pool.register(ProviderId.Grok, FAKE_GROK_KEY_2);

    expect(first.id).toBe("credential-1");
    expect(second.id).toBe("credential-2");
  });

  it("rejects empty or non-string credential values", () => {
    const pool = new CredentialPool();
    expect(() =>
      pool.register(ProviderId.Grok, ""),
    ).toThrowError(CredentialPoolError);
    expect(() =>
      pool.register(ProviderId.Grok, "   "),
    ).toThrowError(CredentialPoolError);
    expect(() =>
      pool.register(ProviderId.Grok, 42 as unknown as string),
    ).toThrowError(CredentialPoolError);
  });

  it("rejects a duplicate credential id within a provider", () => {
    const pool = new CredentialPool();
    pool.register(ProviderId.Grok, FAKE_GROK_KEY, "primary");

    try {
      pool.register(ProviderId.Grok, FAKE_GROK_KEY_2, "primary");
      expect.unreachable("duplicate id must throw");
    } catch (error) {
      expect(isCredentialPoolError(error)).toBe(true);
      const err = error as CredentialPoolError;
      expect(err.code).toBe("credential-pool/duplicate-credential-id");
      expect(err.providerId).toBe("grok");
      expect(err.credentialId).toBe("primary");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Lookup / reveal
// ---------------------------------------------------------------------------

describe("CredentialPool — lookup and reveal", () => {
  it("reveals the exact registered value through a genuine handle", () => {
    const { pool } = poolWithGrok();
    const handle = pool.obtain(ProviderId.Grok);
    expect(pool.reveal(handle)).toBe(FAKE_GROK_KEY);
  });

  it("reveals each of several credentials independently", () => {
    const { pool } = poolWithGrok();
    const [primary, backup] = pool.all(ProviderId.Grok);
    expect(primary).toBeDefined();
    expect(backup).toBeDefined();
    if (!primary || !backup) return;
    expect(pool.reveal(primary)).toBe(FAKE_GROK_KEY);
    expect(pool.reveal(backup)).toBe(FAKE_GROK_KEY_2);
  });

  it("reveals nothing for a handle from a different pool", () => {
    const a = new CredentialPool();
    const b = new CredentialPool();
    a.register(ProviderId.Grok, FAKE_GROK_KEY, "primary");
    const handle = a.obtain(ProviderId.Grok);
    expect(() => b.reveal(handle)).toThrowError(CredentialPoolError);
  });
});

// ---------------------------------------------------------------------------
// 3. Multiple credentials + deterministic selection
// ---------------------------------------------------------------------------

describe("CredentialPool — multiple credentials and deterministic selection", () => {
  it("supports several credentials for one provider", () => {
    const { pool } = poolWithGrok();
    const handles = pool.all(ProviderId.Grok);
    expect(handles).toHaveLength(2);
    expect(handles.map((h) => h.id)).toEqual(["primary", "backup"]);
  });

  it("selects the first registered credential deterministically", () => {
    const { pool } = poolWithGrok();
    const first = pool.obtain(ProviderId.Grok);
    const second = pool.obtain(ProviderId.Grok);
    const third = pool.obtain(ProviderId.Grok);

    // Same selection every time — no rotation, no randomness.
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(pool.reveal(first)).toBe(FAKE_GROK_KEY);
  });

  it("keeps selection stable until the credential set changes", () => {
    const pool = new CredentialPool();
    pool.register(ProviderId.Grok, FAKE_GROK_KEY, "early");

    const before = pool.obtain(ProviderId.Grok);
    pool.register(ProviderId.Grok, FAKE_GROK_KEY_2, "late");

    // Appending does not reorder the deterministic first pick.
    const after = pool.obtain(ProviderId.Grok);
    expect(after).toEqual(before);
    expect(pool.reveal(after)).toBe(FAKE_GROK_KEY);
    expect(pool.all(ProviderId.Grok).map((h) => h.id)).toEqual([
      "early",
      "late",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Missing credentials
// ---------------------------------------------------------------------------

describe("CredentialPool — missing credentials fail clearly", () => {
  it("throws a typed missing-credentials error", () => {
    const pool = new CredentialPool();

    try {
      pool.obtain(ProviderId.Grok);
      expect.unreachable("missing credentials must throw");
    } catch (error) {
      expect(isCredentialPoolError(error)).toBe(true);
      const err = error as CredentialPoolError;
      expect(err.code).toBe("credential-pool/missing-credentials");
      expect(err.providerId).toBe("grok");
      expect(err.message).toContain("grok");
    }
  });

  it("reports absent providers the same as empty ones", () => {
    const pool = new CredentialPool();
    pool.register(ProviderId.Grok, FAKE_GROK_KEY, "primary");
    expect(() => pool.obtain("gemini" as ProviderId)).toThrowError(
      CredentialPoolError,
    );
  });

  it("never embeds credential values in missing-credential errors", () => {
    const pool = new CredentialPool();
    pool.register(ProviderId.Grok, FAKE_SECRET, "primary");
    expect(() => pool.obtain("gemini" as ProviderId)).toThrowError(
      expect.objectContaining({}),
    );
    try {
      pool.obtain("gemini" as ProviderId);
    } catch (error) {
      expectNoSecret(error);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Provider isolation
// ---------------------------------------------------------------------------

describe("CredentialPool — provider isolation", () => {
  it("keeps each provider's credentials separate", () => {
    const pool = new CredentialPool();
    pool.register(ProviderId.Grok, FAKE_GROK_KEY, "primary");

    expect(pool.has("gemini" as ProviderId)).toBe(false);
    expect(pool.all("gemini" as ProviderId)).toEqual([]);
    expect(() => pool.obtain("gemini" as ProviderId)).toThrowError(
      CredentialPoolError,
    );
  });

  it("allows the same id under different providers", () => {
    const pool = new CredentialPool();
    pool.register(ProviderId.Grok, FAKE_GROK_KEY, "shared");
    pool.register("gemini" as ProviderId, "gemini-fake", "shared");

    expect(pool.reveal(pool.obtain(ProviderId.Grok))).toBe(FAKE_GROK_KEY);
    expect(pool.all("gemini" as ProviderId).map((h) => h.id)).toEqual([
      "shared",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. Opaque handles + no secrets anywhere
// ---------------------------------------------------------------------------

describe("CredentialPool — opacity and no-secrets guarantees", () => {
  it("carries no secret value on the handle itself", () => {
    const { pool } = poolWithGrok();
    const handle = pool.obtain(ProviderId.Grok);

    // The handle is minimal by construction: id + provider only.
    expect(Object.keys(handle)).toEqual(["id", "provider"]);
    expect(JSON.stringify(handle)).not.toContain(FAKE_GROK_KEY);
    expect(JSON.stringify(handle)).not.toContain(FAKE_GROK_KEY_2);
  });

  it("rejects a forged handle even when ids match", () => {
    const { pool } = poolWithGrok();
    const forged = {
      id: "primary",
      provider: ProviderId.Grok,
    } as unknown as OpaqueCredential;

    expect(() => pool.reveal(forged)).toThrowError(CredentialPoolError);
  });

  it("keeps credential values out of duplicate and empty errors", () => {
    const pool = new CredentialPool();
    pool.register(ProviderId.Grok, FAKE_SECRET, "primary");
    try {
      pool.register(ProviderId.Grok, FAKE_GROK_KEY_2, "primary");
    } catch (error) {
      expectNoSecret(error);
    }
    try {
      pool.register(ProviderId.Grok, "");
    } catch (error) {
      expectNoSecret(error);
    }
  });

  it("never leaks a credential through provider construction", () => {
    // Server-side composition: pool → reveal → provider factory. The agent
    // sees only an `AgentProvider`; the secret stays in trusted server code.
    const { pool } = poolWithGrok();
    const handle = pool.obtain(ProviderId.Grok);
    const apiKey = pool.reveal(handle);

    const provider = createGrokProvider({ apiKey, model: "grok-3" });
    expect(typeof provider.generate).toBe("function");
    expect(JSON.stringify(provider)).not.toContain(FAKE_GROK_KEY);
    expect(JSON.stringify(provider)).not.toContain("apiKey");
  });
});

// ---------------------------------------------------------------------------
// 7. Integration: pool stays out of agent orchestration
// ---------------------------------------------------------------------------

describe("CredentialPool — separation from provider selection", () => {
  it("does not place credentials inside provider-selection results", () => {
    // The selection layer resolves to an AgentProvider; the pool is a
    // separate concern handed to the composition root only. No credential is
    // reachable through the registry path.
    const registry = new ProviderRegistry();
    registry.register(ProviderId.Grok, () => ({
      generate: vi.fn().mockResolvedValue({ text: "ok" }),
    }));

    const provider = registry.resolve({ provider: ProviderId.Grok });
    expect(typeof provider.generate).toBe("function");
    expect(JSON.stringify(provider)).not.toContain("secret");
  });
});