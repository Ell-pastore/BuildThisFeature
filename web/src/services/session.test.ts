import { beforeEach, describe, expect, it, vi } from "vitest";

const authApiMock = vi.hoisted(() => ({
  login: vi.fn(),
  me: vi.fn(),
  logout: vi.fn(),
  register: vi.fn(),
}));

vi.mock("./api", () => ({
  authApi: authApiMock,
}));

import {
  SessionNotAuthenticatedError,
  getSessionSnapshot,
  login,
  logout,
  register,
  requireSessionToken,
  subscribeSession,
} from "./session";

describe("session", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await logout();
  });

  it("starts unauthenticated: no user snapshot and token access throws", () => {
    expect(getSessionSnapshot().user).toBeNull();
    expect(getSessionSnapshot().token).toBeNull();
    expect(() => requireSessionToken()).toThrow(SessionNotAuthenticatedError);
  });

  it("login stores the user and token in memory only (no browser storage)", async () => {
    authApiMock.login.mockResolvedValue({
      user: { id: "u1", email: "a@example.com", displayName: "A", status: "active" },
      token: "session-token-1",
    });

    const user = await login("a@example.com", "password");

    expect(authApiMock.login).toHaveBeenCalledWith({
      email: "a@example.com",
      password: "password",
    });
    expect(user.email).toBe("a@example.com");
    expect(getSessionSnapshot().user?.id).toBe("u1");
    expect(requireSessionToken()).toBe("session-token-1");

    // The token must never be persisted to browser storage for this phase.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("login propagates a backend failure and leaves the session unauthenticated", async () => {
    authApiMock.login.mockRejectedValue(new Error("Invalid credentials"));

    await expect(login("a@example.com", "wrong")).rejects.toThrow("Invalid credentials");
    expect(getSessionSnapshot().user).toBeNull();
    expect(() => requireSessionToken()).toThrow(SessionNotAuthenticatedError);
  });

  it("notifies subscribers and returns a fresh snapshot after login", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSession(listener);
    authApiMock.login.mockResolvedValue({
      user: { id: "u1", email: "a@example.com", displayName: "A", status: "active" },
      token: "t",
    });

    const before = getSessionSnapshot();
    await login("a@example.com", "pw");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSessionSnapshot()).not.toBe(before);
    unsubscribe();
  });

  it("logout revokes the session server-side with the captured token, then clears state", async () => {
    authApiMock.login.mockResolvedValue({
      user: { id: "u1", email: "a@example.com", displayName: "A", status: "active" },
      token: "session-token-2",
    });
    authApiMock.logout.mockResolvedValue({ ok: true });
    await login("a@example.com", "pw");

    await logout();

    expect(authApiMock.logout).toHaveBeenCalledWith("session-token-2");
    expect(getSessionSnapshot().user).toBeNull();
    expect(getSessionSnapshot().token).toBeNull();
    expect(() => requireSessionToken()).toThrow(SessionNotAuthenticatedError);
  });

  it("logout always clears local state even when the server revoke fails", async () => {
    authApiMock.login.mockResolvedValue({
      user: { id: "u1", email: "a@example.com", displayName: "A", status: "active" },
      token: "session-token-3",
    });
    authApiMock.logout.mockRejectedValue(new Error("backend gone"));
    await login("a@example.com", "pw");

    await expect(logout()).resolves.toBeUndefined();
    expect(getSessionSnapshot().user).toBeNull();
    expect(() => requireSessionToken()).toThrow(SessionNotAuthenticatedError);
  });

  it("register creates the account, then signs the new user in", async () => {
    authApiMock.register.mockResolvedValue({
      user: { id: "u2", email: "new@example.com", displayName: "New", status: "active" },
    });
    authApiMock.login.mockResolvedValue({
      user: { id: "u2", email: "new@example.com", displayName: "New", status: "active" },
      token: "session-token-new",
    });

    const user = await register("new@example.com", "New", "password123");

    expect(authApiMock.register).toHaveBeenCalledWith({
      email: "new@example.com",
      displayName: "New",
      password: "password123",
    });
    expect(authApiMock.login).toHaveBeenCalledWith({
      email: "new@example.com",
      password: "password123",
    });
    expect(user.email).toBe("new@example.com");
    expect(getSessionSnapshot().user?.id).toBe("u2");
    expect(requireSessionToken()).toBe("session-token-new");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("register propagates a backend failure and never signs in", async () => {
    authApiMock.register.mockRejectedValue(new Error("An account with this email already exists."));

    await expect(register("new@example.com", "New", "password123")).rejects.toThrow(
      "An account with this email already exists.",
    );
    expect(authApiMock.login).not.toHaveBeenCalled();
    expect(getSessionSnapshot().user).toBeNull();
    expect(() => requireSessionToken()).toThrow(SessionNotAuthenticatedError);
  });
});