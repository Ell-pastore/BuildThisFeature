/**
 * Provider fallback orchestration tests (Phase 10.13).
 *
 * All providers are FAKE, all credentials are FAKE, nothing touches the
 * network. The real `CredentialPool` (selection + rotation from Phases
 * 10.11/10.12) is reused. These tests prove:
 *
 *   1. Configured provider ORDER is honored deterministically.
 *   2. Success on the first provider/credential (no rotation on success).
 *   3. Credential rotation WITHIN one provider (safe failure → rotate()).
 *   4. Moving to the NEXT configured provider after credentials exhausted.
 *   5. The typed `ProviderFallbackError` when everything is exhausted.
 *   6. Non-retryable failures STOP immediately (original error unchanged).
 *   7. Provider rotation state stays ISOLATED per provider.
 *   8. No secret values leak into handles, errors, or summaries.
 *   9. The failure policy is explicit and overridable.
 */
import { describe, expect, it, vi } from "vitest";

import { CredentialPool } from "./credentialPool.js";
import {
  createFallbackProvider,
  classifyProviderFailure,
  ProviderFallbackError,
  type ProviderBuilder,
  type ProviderFailureAction,
} from "./providerFallback.js";
import {
  isProviderError,
  ProviderError,
  ProviderErrorCode,
} from "./provider.js";
import type { AgentProvider, AgentResponse, AgentProviderRequest } from "./provider.js";
import { ProviderId } from "./providerSelection.js";

// `ProviderId` from providerSelection is both a const map (value, e.g.
// ProviderId.Grok) and the provider-id string union (type, e.g. "gemini" as
// ProviderId); a single plain import provides both meanings.
type BuildCall = { provider: ProviderId; credentialId: string };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePool(): CredentialPool {
  return new CredentialPool();
}

/** `secretId` is the fake value stored in the pool; only ids must float around. */
function registerKey(
  pool: CredentialPool,
  provider: ProviderId,
  id: string,
  value = `fake-secret-${provider}-${id}`,
): void {
  pool.register(provider, value, id);
}

function providerThatResponds(text: string): AgentProvider {
  return {
    generate: async () => ({ text }) satisfies AgentResponse,
  };
}

function providerThatThrows(error: unknown): AgentProvider {
  return {
    generate: async () => {
      throw error;
    },
  };
}

function authFailure(): ProviderError {
  return ProviderError.permanent(ProviderErrorCode.Authentication, "bad key");
}

function unavailableFailure(): ProviderError {
  return ProviderError.transient(ProviderErrorCode.Unavailable, "provider down");
}

/**
 * Build an orchestrator whose `build` hook records call order and hands each
 * credential a scripted state (respond with text / throw an error), chosen by
 * the credential id.
 */
function makeOrchestrator(
  pool: CredentialPool,
  providers: readonly ProviderId[],
  script: (provider: ProviderId, credentialId: string) => AgentProvider,
): { provider: AgentProvider; calls: BuildCall[] } {
  const calls: BuildCall[] = [];
  const build: ProviderBuilder = (provider, handle) => {
    calls.push({ provider, credentialId: handle.id });
    return script(provider, handle.id);
  };
  const provider = createFallbackProvider({ providers, credentials: pool, build });
  return { provider, calls };
}

async function run(
  provider: AgentProvider,
  message = "Hello",
): Promise<AgentResponse> {
  return provider.generate({ message, tools: [] } satisfies AgentProviderRequest);
}

/** Fine-grained script: an ordered list of outcomes keyed by provider+credential. */
type Outcome =
  | { kind: "text"; text: string }
  | { kind: "throw"; error: unknown };

function scriptByTable(
  outcomes: Record<string, Outcome>,
): (provider: ProviderId, credentialId: string) => AgentProvider {
  return (provider, credentialId) => {
    const outcome = outcomes[`${provider}:${credentialId}`];
    if (outcome === undefined) {
      throw new Error(`no scripted outcome for ${provider}:${credentialId}`);
    }
    if (outcome.kind === "text") {
      return providerThatResponds(outcome.text);
    }
    return providerThatThrows(outcome.error);
  };
}

// ---------------------------------------------------------------------------
// 1. Provider ordering + success
// ---------------------------------------------------------------------------

describe("Provider fallback — ordering and first success", () => {
  it("succeeds on the first configured provider with its current credential", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a");
    const { provider, calls } = makeOrchestrator(
      pool,
      [ProviderId.Grok],
      scriptByTable({ "grok:a": { kind: "text", text: "done" } }),
    );

    const response = await run(provider);

    expect(response).toMatchObject({ text: "done" });
    expect(calls).toEqual([{ provider: "grok", credentialId: "a" }]);
    // Success must not rotate: the current credential stays "a".
    expect(pool.obtain(ProviderId.Grok).id).toBe("a");
  });

  it("honors the configured provider order deterministically", async () => {
    const pool = makePool();
    registerKey(pool, "gemini" as ProviderId, "g1");
    registerKey(pool, ProviderId.Grok, "k1");
    const { provider, calls } = makeOrchestrator(
      pool,
      ["gemini" as ProviderId, ProviderId.Grok],
      scriptByTable({
        "gemini:g1": { kind: "text", text: "from gemini" },
        "grok:k1": { kind: "text", text: "from grok" },
      }),
    );

    const response = await run(provider);

    // Even though both succeed, configured order decides who is tried first.
    expect(response).toMatchObject({ text: "from gemini" });
    expect(calls).toEqual([
      { provider: "gemini", credentialId: "g1" },
    ]);
  });

  it("starts from the provider's CURRENT credential after an earlier rotation", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a");
    registerKey(pool, ProviderId.Grok, "b");
    pool.rotate(ProviderId.Grok); // current is now "b"

    const { provider, calls } = makeOrchestrator(
      pool,
      [ProviderId.Grok],
      scriptByTable({
        "grok:b": { kind: "text", text: "rotated-first" },
        "grok:a": { kind: "text", text: "old-first" },
      }),
    );

    const response = await run(provider);
    expect(response).toMatchObject({ text: "rotated-first" });
    expect(calls).toEqual([{ provider: "grok", credentialId: "b" }]);
  });
});

// ---------------------------------------------------------------------------
// 2. Credential rotation within one provider
// ---------------------------------------------------------------------------

describe("Provider fallback — credential rotation within a provider", () => {
  it("rotates to the next credential when the current one fails safely", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a");
    registerKey(pool, ProviderId.Grok, "b");
    const { provider, calls } = makeOrchestrator(
      pool,
      [ProviderId.Grok],
      scriptByTable({
        "grok:a": { kind: "throw", error: authFailure() },
        "grok:b": { kind: "text", text: "recovered" },
      }),
    );

    const response = await run(provider);

    expect(response).toMatchObject({ text: "recovered" });
    expect(calls).toEqual([
      { provider: "grok", credentialId: "a" },
      { provider: "grok", credentialId: "b" },
    ]);
    // The failed credential was rotated past: current is now "b".
    expect(pool.obtain(ProviderId.Grok).id).toBe("b");
  });

  it("recovers from a rate-limited credential too", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a");
    registerKey(pool, ProviderId.Grok, "b");
    const rateLimited = ProviderError.transient(
      ProviderErrorCode.RateLimited,
      "slow down",
    );
    const { provider } = makeOrchestrator(
      pool,
      [ProviderId.Grok],
      scriptByTable({
        "grok:a": { kind: "throw", error: rateLimited },
        "grok:b": { kind: "text", text: "second key ok" },
      }),
    );

    expect(await run(provider)).toMatchObject({ text: "second key ok" });
    expect(pool.obtain(ProviderId.Grok).id).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// 3. Next provider after exhaustion
// ---------------------------------------------------------------------------

describe("Provider fallback — moving to the next provider", () => {
  it("tries the next configured provider after a provider's credentials are exhausted", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a");
    registerKey(pool, ProviderId.Grok, "b");
    registerKey(pool, "gemini" as ProviderId, "x");
    const { provider, calls } = makeOrchestrator(
      pool,
      [ProviderId.Grok, "gemini" as ProviderId],
      scriptByTable({
        "grok:a": { kind: "throw", error: authFailure() },
        "grok:b": { kind: "throw", error: unavailableFailure() },
        "gemini:x": { kind: "text", text: "gemini to the rescue" },
      }),
    );

    const response = await run(provider);

    expect(response).toMatchObject({ text: "gemini to the rescue" });
    expect(calls).toEqual([
      { provider: "grok", credentialId: "a" },
      { provider: "grok", credentialId: "b" },
      { provider: "gemini", credentialId: "x" },
    ]);
  });

  it("skips a configured provider that has no credentials", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "ok");
    const { provider, calls } = makeOrchestrator(
      pool,
      ["ollama" as ProviderId, ProviderId.Grok],
      scriptByTable({ "grok:ok": { kind: "text", text: "from grok" } }),
    );

    const response = await run(provider);

    expect(response).toMatchObject({ text: "from grok" });
    // ollama was never built (nothing to build with).
    expect(calls).toEqual([{ provider: "grok", credentialId: "ok" }]);
  });
});

// ---------------------------------------------------------------------------
// 4. Everything exhausted → typed final failure
// ---------------------------------------------------------------------------

describe("Provider fallback — all providers/credentials exhausted", () => {
  it("throws a typed ProviderFallbackError listing every attempt", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a");
    registerKey(pool, ProviderId.Grok, "b");
    registerKey(pool, "gemini" as ProviderId, "x");
    registerKey(pool, "gemini" as ProviderId, "y");
    const { provider, calls } = makeOrchestrator(
      pool,
      [ProviderId.Grok, "gemini" as ProviderId],
      scriptByTable({
        "grok:a": { kind: "throw", error: authFailure() },
        "grok:b": { kind: "throw", error: unavailableFailure() },
        "gemini:x": {
          kind: "throw",
          error: ProviderError.transient(ProviderErrorCode.Timeout, "slow"),
        },
        "gemini:y": { kind: "throw", error: authFailure() },
      }),
    );

    await expect(run(provider)).rejects.toThrowError(ProviderFallbackError);
    expect(calls).toHaveLength(4);

    try {
      await run(provider);
    } catch (error) {
      const err = error as ProviderFallbackError;
      // Still the agent layer's typed failure contract.
      expect(isProviderError(err)).toBe(true);
      expect(err.code).toBe(ProviderErrorCode.Unavailable);
      expect(err.retryable).toBe(true);
      expect(err.attempted).toEqual([
        { provider: "grok", credentialId: "a", code: ProviderErrorCode.Authentication },
        { provider: "grok", credentialId: "b", code: ProviderErrorCode.Unavailable },
        { provider: "gemini", credentialId: "x", code: ProviderErrorCode.Timeout },
        { provider: "gemini", credentialId: "y", code: ProviderErrorCode.Authentication },
      ]);
      expect(err.message).toContain("grok");
      expect(err.message).toContain("gemini");
    }
  });

  it("reports configured providers that had no credentials", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a");
    const { provider } = makeOrchestrator(
      pool,
      ["ollama" as ProviderId, ProviderId.Grok],
      scriptByTable({
        "grok:a": { kind: "throw", error: authFailure() },
      }),
    );

    try {
      await run(provider);
    } catch (error) {
      const err = error as ProviderFallbackError;
      expect(err.attempted).toEqual([
        {
          provider: "ollama",
          code: "credential-pool/missing-credentials",
        },
        { provider: "grok", credentialId: "a", code: ProviderErrorCode.Authentication },
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Non-retryable failures stop immediately
// ---------------------------------------------------------------------------

describe("Provider fallback — non-retryable failures stop immediately", () => {
  it("propagates a malformed-response failure without rotating or failing over", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a");
    registerKey(pool, "gemini" as ProviderId, "x");
    const malformed = ProviderError.permanent(
      ProviderErrorCode.InvalidResponse,
      "response unparseable",
    );
    const { provider, calls } = makeOrchestrator(
      pool,
      [ProviderId.Grok, "gemini" as ProviderId],
      scriptByTable({
        "grok:a": { kind: "throw", error: malformed },
        "gemini:x": { kind: "text", text: "should never be reached" },
      }),
    );

    await expect(run(provider)).rejects.toBe(malformed);
    expect(calls).toEqual([{ provider: "grok", credentialId: "a" }]);
    // No rotation happened.
    expect(pool.obtain(ProviderId.Grok).id).toBe("a");
  });

  it("propagates a non-provider failure unchanged (no blind retry)", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a");
    const boom = new Error("boom: validation bug");
    const { provider, calls } = makeOrchestrator(
      pool,
      [ProviderId.Grok],
      scriptByTable({ "grok:a": { kind: "throw", error: boom } }),
    );

    await expect(run(provider)).rejects.toBe(boom);
    expect(calls).toEqual([{ provider: "grok", credentialId: "a" }]);
    expect(pool.obtain(ProviderId.Grok).id).toBe("a");
  });

  it("lets a custom policy disable rotation entirely", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a");
    registerKey(pool, ProviderId.Grok, "b");
    const calls: BuildCall[] = [];
    const build: ProviderBuilder = (_provider, handle) => {
      calls.push({ provider: _provider, credentialId: handle.id });
      return handle.id === "a" ? providerThatThrows(authFailure()) : providerThatResponds("b ok");
    };
    const stopAlways: (error: unknown) => ProviderFailureAction = () => "stop";
    const provider = createFallbackProvider({
      providers: [ProviderId.Grok],
      credentials: pool,
      build,
      classify: stopAlways,
    });

    await expect(run(provider)).rejects.toBeInstanceOf(ProviderError);
    // Only the first credential was attempted; "b" was never reached.
    expect(calls).toEqual([{ provider: "grok", credentialId: "a" }]);
  });
});

// ---------------------------------------------------------------------------
// 6. Provider isolation
// ---------------------------------------------------------------------------

describe("Provider fallback — isolation", () => {
  it("rotating one provider never touches another provider's state", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a");
    registerKey(pool, ProviderId.Grok, "b");
    registerKey(pool, "gemini" as ProviderId, "x");
    registerKey(pool, "gemini" as ProviderId, "y");

    const { provider } = makeOrchestrator(
      pool,
      [ProviderId.Grok],
      scriptByTable({
        "grok:a": { kind: "throw", error: authFailure() },
        "grok:b": { kind: "text", text: "ok" },
      }),
    );
    await run(provider);

    // grok advanced to "b" ...
    expect(pool.obtain(ProviderId.Grok).id).toBe("b");
    // ... while gemini's pointer is untouched and still yields its first.
    expect(pool.obtain("gemini" as ProviderId).id).toBe("x");
    expect(pool.all("gemini" as ProviderId).map((h) => h.id)).toEqual(["x", "y"]);
  });
});

// ---------------------------------------------------------------------------
// 7. No secret leakage
// ---------------------------------------------------------------------------

describe("Provider fallback — no secret leakage", () => {
  const SECRET_VALUES = ["fake-secret-grok-a", "fake-secret-gemini-x"];

  it("passes opaque handles to the builder, never values", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a", SECRET_VALUES[0]);
    let seen: unknown;
    const build: ProviderBuilder = (_provider, handle) => {
      seen = handle;
      return providerThatResponds("ok");
    };
    const provider = createFallbackProvider({
      providers: [ProviderId.Grok],
      credentials: pool,
      build,
    });
    await run(provider);

    expect(seen).toBeDefined();
    const handle = seen as { id: string; provider: ProviderId };
    expect(Object.keys(handle)).toEqual(["id", "provider"]);
    for (const secret of SECRET_VALUES) {
      expect(JSON.stringify(handle)).not.toContain(secret);
    }
  });

  it("keeps secrets out of exhausted error messages and summaries", async () => {
    const pool = makePool();
    registerKey(pool, ProviderId.Grok, "a", SECRET_VALUES[0]);
    registerKey(pool, "gemini" as ProviderId, "x", SECRET_VALUES[1]);
    const { provider } = makeOrchestrator(
      pool,
      [ProviderId.Grok, "gemini" as ProviderId],
      scriptByTable({
        "grok:a": { kind: "throw", error: authFailure() },
        "gemini:x": { kind: "throw", error: unavailableFailure() },
      }),
    );

    try {
      await run(provider);
    } catch (error) {
      const err = error as ProviderFallbackError;
      expect(err.message).not.toContain(SECRET_VALUES[0]);
      expect(err.message).not.toContain(SECRET_VALUES[1]);
      expect(JSON.stringify(err.attempted)).not.toContain(SECRET_VALUES[0]);
      expect(JSON.stringify(err.attempted)).not.toContain(SECRET_VALUES[1]);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Failure classification policy
// ---------------------------------------------------------------------------

describe("Provider fallback — classification policy", () => {
  it("rotates only for explicitly safe provider failures", () => {
    expect(
      classifyProviderFailure(
        ProviderError.permanent(ProviderErrorCode.Authentication, "x"),
      ),
    ).toBe("rotate-credential");
    expect(
      classifyProviderFailure(
        ProviderError.transient(ProviderErrorCode.RateLimited, "x"),
      ),
    ).toBe("rotate-credential");
    expect(
      classifyProviderFailure(
        ProviderError.transient(ProviderErrorCode.Unavailable, "x"),
      ),
    ).toBe("rotate-credential");
    expect(
      classifyProviderFailure(
        ProviderError.transient(ProviderErrorCode.Timeout, "x"),
      ),
    ).toBe("rotate-credential");
  });

  it("stops for anything else", () => {
    expect(
      classifyProviderFailure(
        ProviderError.permanent(ProviderErrorCode.InvalidResponse, "x"),
      ),
    ).toBe("stop");
    expect(
      classifyProviderFailure(
        ProviderError.transient(ProviderErrorCode.Internal, "x"),
      ),
    ).toBe("stop");
    expect(classifyProviderFailure(new Error("boom"))).toBe("stop");
    expect(classifyProviderFailure("string error")).toBe("stop");
    expect(classifyProviderFailure(undefined)).toBe("stop");
  });
});