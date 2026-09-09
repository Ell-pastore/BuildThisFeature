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

import { SessionNotAuthenticatedError } from "../session";
import { ApiClientError } from "./client";
import { submitAiInstruction } from "./aiInstructions";

describe("aiInstructions api client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});