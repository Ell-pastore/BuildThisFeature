/**
 * Auth service tests — focused on registration (Phase 7).
 *
 * The repository layer is mocked (the existing vi.hoisted / repository-mock
 * pattern from aiToolApprovals.test.ts) so these tests cover the SERVICE
 * contract: validation, normalization boundaries, hashing, duplicate
 * handling, and the safe response shape — without a database.
 */
import * as bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../core/errors.js";
import { registerUser } from "./auth.js";

const usersMock = vi.hoisted(() => ({
  createUser: vi.fn(),
  findUserByEmail: vi.fn(),
}));

vi.mock("../database/repositories/users.js", () => ({
  createUser: usersMock.createUser,
  findUserByEmail: usersMock.findUserByEmail,
}));

const NO_USER = null;

describe("registerUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers a new user with a bcrypt-hashed password and a safe response", async () => {
    usersMock.findUserByEmail.mockResolvedValue(NO_USER);
    usersMock.createUser.mockResolvedValue({
      id: "uuid-1",
      email: "jane@example.com",
      displayName: "Jane Doe",
      passwordHash: "stored-hash-not-returned",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const user = await registerUser({
      email: "  Jane@Example.COM ",
      displayName: "  Jane Doe  ",
      password: "correct horse battery staple",
    });

    // The service trims; the repository normalizes case — the boundary
    // receives the raw (trimmed) value, never a mutated email.
    expect(usersMock.findUserByEmail).toHaveBeenCalledWith("Jane@Example.COM");

    const createArgs = usersMock.createUser.mock.calls[0]![0];
    expect(createArgs.email).toBe("Jane@Example.COM");
    expect(createArgs.displayName).toBe("Jane Doe");
    expect(createArgs.passwordHash).not.toBe("correct horse battery staple");
    await expect(bcrypt.compare("correct horse battery staple", createArgs.passwordHash)).resolves.toBe(true);

    // never expose the hash (or any other secret) in the response
    expect(user).toEqual({
      id: "uuid-1",
      email: "jane@example.com",
      displayName: "Jane Doe",
      status: "active",
      createdAt: expect.any(Date),
    });
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("rejects an invalid email before creating any account", async () => {
    const promise = registerUser({
      email: "not-an-email",
      displayName: "Jane",
      password: "correct horse battery staple",
    });

    await expect(promise).rejects.toBeInstanceOf(AppError);
    await expect(promise).rejects.toMatchObject({ status: 400, code: "common/bad-request" });
    expect(usersMock.findUserByEmail).not.toHaveBeenCalled();
    expect(usersMock.createUser).not.toHaveBeenCalled();
  });

  it("rejects a missing display name", async () => {
    const promise = registerUser({
      email: "jane@example.com",
      displayName: "   ",
      password: "correct horse battery staple",
    });

    await expect(promise).rejects.toMatchObject({ status: 400, code: "common/bad-request" });
    expect(usersMock.createUser).not.toHaveBeenCalled();
  });

  it("rejects a password shorter than the 8-character minimum", async () => {
    const promise = registerUser({
      email: "jane@example.com",
      displayName: "Jane",
      password: "short",
    });

    await expect(promise).rejects.toMatchObject({ status: 400, code: "common/bad-request" });
    expect(usersMock.findUserByEmail).not.toHaveBeenCalled();
    expect(usersMock.createUser).not.toHaveBeenCalled();
  });

  it("rejects a duplicate email cleanly with 409 auth/email-taken", async () => {
    usersMock.findUserByEmail.mockResolvedValue({
      id: "existing-1",
      email: "jane@example.com",
      displayName: "Jane",
      passwordHash: "whatever",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const promise = registerUser({
      email: "jane@example.com",
      displayName: "Jane",
      password: "correct horse battery staple",
    });

    await expect(promise).rejects.toBeInstanceOf(AppError);
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "auth/email-taken",
      message: "An account with this email already exists.",
    });
    // no hash is computed or written for a duplicate account
    expect(usersMock.createUser).not.toHaveBeenCalled();
  });

  it("maps the race-condition unique violation (P2002) to 409 auth/email-taken", async () => {
    usersMock.findUserByEmail.mockResolvedValue(NO_USER);
    usersMock.createUser.mockRejectedValue({ code: "P2002" });

    const promise = registerUser({
      email: "jane@example.com",
      displayName: "Jane",
      password: "correct horse battery staple",
    });

    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "auth/email-taken",
    });
  });
});