/**
 * Provider credential pool (Phase 10.11).
 *
 * The smallest provider-independent abstraction that can SUPPLY credentials
 * for a selected provider. Nothing here knows what a credential means to any
 * specific provider — it stores opaque values keyed by provider id and hands
 * out opaque handles that IDENTIFY a credential without carrying its value.
 *
 * Flow:
 *
 *   CredentialPool.register({ provider, value, id? })      ← server-side only
 *   → pool.obtain(provider)                                ← deterministic pick
 *   → OpaqueCredential                                     ← a HANDLE, no secret
 *   → pool.reveal(handle)                                  ← controlled, trusted callers
 *   → value feeds the provider factory (Grok apiKey, ...)
 *
 * Hard rules:
 *
 *   - SERVER-SIDE ONLY: credentials are registered from the server
 *     environment and revealed only to code that constructs providers (the
 *     composition root). They never travel to web / desktop / mobile clients
 *     and never flow through agent contracts (`AgentProvider`,
 *     `AgentResponse`, `ProviderSelection`, serialized conversation state).
 *   - OPAQUE: the values a caller sees are branded handles carrying only an
 *     `id` and a `provider`. The secret itself is retrievable solely through
 *     `reveal()`, which requires a genuine handle produced by THIS pool.
 *   - DETERMINISTIC: selection is stable — `obtain()` always returns the
 *     first registered credential for the provider; `all()` exposes every
 *     handle in registration order so future rotation / fallback logic can
 *     iterate without touching `AgentProvider`.
 *   - NEVER LOGGED: this module never logs anything, and error messages and
 *     tests carry only provider ids and credential IDs — never values.
 *
 * The pool itself performs no network I/O, no key rotation, and no
 * automatic fallback — those are future hooks on top of `all()`.
 */
import { ProviderId } from "./providerSelection.js";
import type { ProviderId as ProviderIdType } from "./providerSelection.js";

// `ProviderId` is BOTH the const map (a value) and the provider-id string
// union (a type) in providerSelection. Import the value under its name and
// the type under an alias so the two name-spaces do not collide.

// ---------------------------------------------------------------------------
// Opaque credential handles
// ---------------------------------------------------------------------------

/** Module-private brand so only this pool can mint genuine handles. */
const credentialBrand: unique symbol = Symbol("credential-pool.credential");

/**
 * A handle that identifies a stored credential WITHOUT carrying its value.
 * Constructible only inside this module; external code cannot forge the
 * brand, so a handle is only ever worth revealing through this pool.
 */
export interface OpaqueCredential {
  readonly [credentialBrand]: true;
  /** Stable identifier, unique within the provider's credential set. */
  readonly id: string;
  /** The provider the credential belongs to. */
  readonly provider: ProviderIdType;
}

interface RegisteredCredential {
  id: string;
  provider: ProviderIdType;
  value: string;
}

function toHandle(entry: RegisteredCredential): OpaqueCredential {
  return { [credentialBrand]: true, id: entry.id, provider: entry.provider };
}

function isGenuineHandle(value: unknown): value is OpaqueCredential {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as OpaqueCredential)[credentialBrand] === true
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CredentialPoolErrorCode =
  | "credential-pool/missing-credentials"
  | "credential-pool/duplicate-credential-id"
  | "credential-pool/empty-credential"
  | "credential-pool/unknown-handle";

/**
 * A typed failure from the credential pool. Messages name provider ids and
 * credential IDs only — a credential VALUE is never embedded in an error.
 */
export class CredentialPoolError extends Error {
  readonly code: CredentialPoolErrorCode;
  /** The provider id involved, when known. */
  readonly providerId?: ProviderIdType;
  /** The credential id involved, when known. */
  readonly credentialId?: string;

  constructor(
    code: CredentialPoolErrorCode,
    message: string,
    details?: { providerId?: ProviderIdType; credentialId?: string },
  ) {
    super(message);
    this.name = "CredentialPoolError";
    this.code = code;
    this.providerId = details?.providerId;
    this.credentialId = details?.credentialId;
  }

  /** The provider has no registered credentials. */
  static missing(provider: ProviderIdType): CredentialPoolError {
    return new CredentialPoolError(
      "credential-pool/missing-credentials",
      `No credentials are registered for provider "${provider}".`,
      { providerId: provider },
    );
  }

  /** A credential id already exists for the provider (ids are unique). */
  static duplicate(provider: ProviderIdType, id: string): CredentialPoolError {
    return new CredentialPoolError(
      "credential-pool/duplicate-credential-id",
      `A credential with id "${id}" is already registered for provider "${provider}".`,
      { providerId: provider, credentialId: id },
    );
  }

  /** Empty / non-string credential values are rejected at registration. */
  static empty(provider: ProviderIdType): CredentialPoolError {
    return new CredentialPoolError(
      "credential-pool/empty-credential",
      `Credential value for provider "${provider}" must be a non-empty string.`,
      { providerId: provider },
    );
  }

  /** A handle that this pool cannot map back to a stored credential. */
  static unknownHandle(): CredentialPoolError {
    return new CredentialPoolError(
      "credential-pool/unknown-handle",
      "Credential handle does not belong to this pool.",
    );
  }
}

export function isCredentialPoolError(
  error: unknown,
): error is CredentialPoolError {
  return error instanceof CredentialPoolError;
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

/**
 * A pool of opaque credentials keyed by provider. Registration is exclusive
 * per provider+id, and selection is deterministic: `obtain()` returns the
 * first registered credential for the provider.
 */
export class CredentialPool {
  private readonly credentials = new Map<
    ProviderIdType,
    RegisteredCredential[]
  >();

  /** The provider ids that currently have at least one credential. */
  get registeredProviders(): readonly ProviderIdType[] {
    return [...this.credentials.keys()];
  }

  /**
   * Register a server-side credential value under a provider. The value
   * stays inside the pool; callers are handed an opaque `OpaqueCredential`
   * handle.
   *
   * @param id — stable identifier, unique within the provider. Auto-assigned
   *   (`credential-1`, `credential-2`, ...) when omitted.
   * @throws `CredentialPoolError` on empty values or a duplicate id. Values
   *   are never included in error messages.
   */
  register(
    provider: ProviderIdType,
    value: string,
    id?: string,
  ): OpaqueCredential {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw CredentialPoolError.empty(provider);
    }

    const existing = this.credentials.get(provider) ?? [];
    const credentialId = id ?? `credential-${existing.length + 1}`;
    if (existing.some((entry) => entry.id === credentialId)) {
      throw CredentialPoolError.duplicate(provider, credentialId);
    }

    const entry: RegisteredCredential = {
      id: credentialId,
      provider,
      value,
    };
    existing.push(entry);
    this.credentials.set(provider, existing);

    return toHandle(entry);
  }

  /** Whether the provider has at least one registered credential. */
  has(provider: ProviderIdType): boolean {
    return (this.credentials.get(provider)?.length ?? 0) > 0;
  }

  /**
   * Deterministically select a credential for the provider: the first one
   * registered. Repeated calls return the same handle until the set changes.
   *
   * @throws `CredentialPoolError` (missing) when the provider has none.
   */
  obtain(provider: ProviderIdType): OpaqueCredential {
    const first = this.credentials.get(provider)?.[0];
    if (first === undefined) {
      throw CredentialPoolError.missing(provider);
    }
    return toHandle(first);
  }

  /**
   * Every registered credential for the provider, in registration order.
   * Exposes the full set for FUTURE rotation / fallback logic without
   * touching `AgentProvider`.
   */
  all(provider: ProviderIdType): readonly OpaqueCredential[] {
    return (this.credentials.get(provider) ?? []).map(toHandle);
  }

  /**
   * The controlled way to obtain the secret VALUE behind an opaque handle.
   * Trusted only for the server-side composition root that constructs
   * providers; results must never flow to agent contracts or clients.
   *
   * @throws `CredentialPoolError` (unknown handle) when the handle was not
   *   minted by this pool.
   */
  reveal(handle: OpaqueCredential): string {
    if (!isGenuineHandle(handle)) {
      throw CredentialPoolError.unknownHandle();
    }
    const list = this.credentials.get(handle.provider);
    const entry = list?.find((candidate) => candidate.id === handle.id);
    if (entry === undefined) {
      throw CredentialPoolError.unknownHandle();
    }
    return entry.value;
  }
}

// Re-export the provider-id type so pool users can annotate without importing
// providerSelection directly.
export type { ProviderIdType };