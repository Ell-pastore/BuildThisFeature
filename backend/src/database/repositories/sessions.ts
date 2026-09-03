/**
 * Sessions repository — the ONLY place session persistence touches Prisma.
 *
 * Boundary rules (database/README: no HTTP semantics, no Hono deps).
 * Stores only the SHA-256 hash of the opaque session token — never the raw token.
 */
import { getDatabase } from "../client.js";

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent: string | null;
}

/** Persist a session. `last_used_at` is deliberately left NULL until auth
  * middleware validates the session (P7-4). */
export async function createSession(input: CreateSessionInput) {
  return getDatabase().session.create({
    data: {
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      userAgent: input.userAgent,
    },
  });
}