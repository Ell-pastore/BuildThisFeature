import { beforeEach, describe, expect, it, vi } from "vitest";

const requireTokenMock = vi.hoisted(() => vi.fn());
const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock("../session", async (importOriginal) => {
  const real = await importOriginal<typeof import("../session")>();
  return { ...real, requireSessionToken: requireTokenMock };
});

vi.mock("./client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./client")>();
  return { ...real, apiRequest: apiRequestMock };
});

const desktopEnvMock = vi.hoisted(() => ({ isTauriEnv: vi.fn() }));

vi.mock("../desktopEnv", () => ({
  isTauriEnv: desktopEnvMock.isTauriEnv,
}));

import { SessionNotAuthenticatedError } from "../session";
import { ApiClientError } from "./client";
import { submitAiInstruction } from "./aiInstructions";

describe("aiInstructions api client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopEnvMock.isTauriEnv.mockReturnValue(false);
  });

  it("fails fast without an active session — no unauthenticated request is issued", async () => {
    requireTokenMock.mockImplementation(() => {
      throw new SessionNotAuthenticatedError();
    });

    await expect(
      submitAiInstruction({ conversationId: "conv-1", instruction: "Move receipts." }),
    ).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it("submits an instruction to an existing conversation with the session bearer token", async () => {
    requireTokenMock.mockReturnValue("session-token");
    const response = {
      conversationId: "conv-1",
      turn: {
        created: false,
        instruction: "Move receipts.",
        messages: [{ kind: "final", text: "Done." }],
        toolRounds: 0,
        maxToolRounds: 4,
        toolResults: [],
        pendingApprovals: [],
      },
    };
    apiRequestMock.mockResolvedValue(response);

    const result = await submitAiInstruction({
      conversationId: "conv-1",
      instruction: "Move receipts.",
    });

    expect(apiRequestMock).toHaveBeenCalledWith("/api/ai/instructions", {
      method: "POST",
      body: { conversationId: "conv-1", instruction: "Move receipts." },
      token: "session-token",
    });
    expect(result).toEqual(response);
  });

  it("omits conversationId entirely when starting a new conversation", async () => {
    requireTokenMock.mockReturnValue("session-token");
    apiRequestMock.mockResolvedValue({
      conversationId: "conv-9",
      turn: {
        created: true,
        instruction: "Tidy my downloads.",
        messages: [],
        toolRounds: 0,
        maxToolRounds: 4,
        toolResults: [],
        pendingApprovals: [],
      },
    });

    await submitAiInstruction({ instruction: "Tidy my downloads." });

    expect(apiRequestMock).toHaveBeenCalledWith("/api/ai/instructions", {
      method: "POST",
      body: { instruction: "Tidy my downloads." },
      token: "session-token",
    });
  });

  it("propagates backend error envelopes untouched (e.g. 503 provider unavailable)", async () => {
    requireTokenMock.mockReturnValue("session-token");
    apiRequestMock.mockRejectedValue(
      new ApiClientError(
        503,
        "ai/provider-unavailable",
        "The AI provider is temporarily unavailable. Please try again later.",
      ),
    );

    await expect(
      submitAiInstruction({ instruction: "Move receipts." }),
    ).rejects.toMatchObject({ status: 503, code: "ai/provider-unavailable" });
  });

  it("sends the x-desktop-host header ONLY inside the Tauri desktop webview", async () => {
    requireTokenMock.mockReturnValue("session-token");
    apiRequestMock.mockResolvedValue({
      conversationId: "conv-1",
      turn: {
        created: false,
        instruction: "List my files.",
        messages: [{ kind: "final", text: "Done." }],
        toolRounds: 0,
        maxToolRounds: 3,
        toolResults: [],
        pendingApprovals: [],
        pendingExecutions: [],
      },
    });

    // Plain browser: no header.
    desktopEnvMock.isTauriEnv.mockReturnValue(false);
    await submitAiInstruction({ instruction: "List my files." });
    expect(apiRequestMock).toHaveBeenLastCalledWith("/api/ai/instructions", {
      method: "POST",
      body: { instruction: "List my files." },
      token: "session-token",
    });

    // Tauri desktop webview: header present so the backend swaps the
    // host-delegated executor in for THIS request.
    desktopEnvMock.isTauriEnv.mockReturnValue(true);
    await submitAiInstruction({ instruction: "List my files." });
    expect(apiRequestMock).toHaveBeenLastCalledWith("/api/ai/instructions", {
      method: "POST",
      body: { instruction: "List my files." },
      token: "session-token",
      headers: { "x-desktop-host": "1" },
    });
  });

  it("forwards resumeExecutions verbatim when the desktop host resubmits results", async () => {
    requireTokenMock.mockReturnValue("session-token");
    apiRequestMock.mockResolvedValue({
      conversationId: "conv-1",
      turn: {
        created: false,
        instruction: "Continue after the requested operations have been executed.",
        messages: [],
        toolRounds: 1,
        maxToolRounds: 3,
        toolResults: [],
        pendingApprovals: [],
        pendingExecutions: [
          {
            executionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            toolName: "list_directory",
            arguments: { path: "/home" },
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        ],
      },
    });

    await submitAiInstruction({
      conversationId: "conv-1",
      instruction: "Continue after the requested operations have been executed.",
      resumeExecutions: [
        {
          executionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          ok: true,
          result: { path: "/home", parentPath: null, isHome: true, items: [] },
        },
      ],
    });

    expect(apiRequestMock).toHaveBeenCalledWith("/api/ai/instructions", {
      method: "POST",
      token: "session-token",
      body: {
        conversationId: "conv-1",
        instruction: "Continue after the requested operations have been executed.",
        resumeExecutions: [
          {
            executionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            ok: true,
            result: { path: "/home", parentPath: null, isHome: true, items: [] },
          },
        ],
      },
    });
  });
});