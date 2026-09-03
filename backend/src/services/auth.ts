/**
 * Authentication service (Phase 7) — registration only.
 *
 * Routes stay thin: this service owns validation, normalization, hashing,
 * and duplicate detection. Login/logout/session issuance arrive in later steps.
 */
import * as bcrypt from "bcryptjs";
import { AppError } from "../core/errors.js";
import { createUser, findUserByEmail } from "../database/repositories/users.js";

/** Safe user representation — never includes password_hash or anything else secret. */
export interface SafeUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  createdAt: Date;
}

export interface RegisterInput {
  email: unknown;
  displayName: unknown;
  password: unknown;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_DISPLAY_NAME_LENGTH = 255;
const MIN_PASSWORD_LENGTH = 8;
/** Production-intent bcrypt cost factor. 12 rounds ≈ 250ms per hash — appropriate
  * for account registration (login verification lands with P7-3). */
const BCRYPT_ROUNDS = 12;
const EMAIL_TAKEN_CODE = "auth/email-taken";

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function toSafeUser(user: {
  id: string;
  email: string;
  displayName: string;
  status: string;
  createdAt: Date;
}): SafeUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt,
  };
}

/** Validate + create an account. Never logs the user in — session issuance is P7-3. */
export async function registerUser(input: RegisterInput): Promise<SafeUser> {
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";

  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw AppError.badRequest("A valid email address is required.");
  }
  if (displayName.length === 0 || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw AppError.badRequest(`Display name must be 1–${MAX_DISPLAY_NAME_LENGTH} characters.`);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw AppError.badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }

  if (await findUserByEmail(email)) {
    throw AppError.conflict(EMAIL_TAKEN_CODE, "An account with this email already exists.");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const user = await createUser({ email, displayName, passwordHash });
    return toSafeUser(user);
  } catch (error) {
    // Race-condition backstop: a concurrent request may have created the
    // email between our check and the insert — Prisma surfaces the UNIQUE
    // (lower(email)) violation as P2002; map it to the same 409.
    if (isUniqueConstraintViolation(error)) {
      throw AppError.conflict(EMAIL_TAKEN_CODE, "An account with this email already exists.");
    }
    throw error;
  }
}