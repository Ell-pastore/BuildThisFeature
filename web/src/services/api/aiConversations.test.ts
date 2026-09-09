import { beforeEach, describe, expect, it, vi } from "vitest";

const requireTokenMock = vi.hoisted(() => vi.fn());
const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock("../session", async (importOriginal) => {
  const real = await importOriginal<typeof import("../session")>();
  return { ...real, requireSessionToken: requireTokenMock };
});

vi.mock("./client", () => ({
  apiRequest: apiRequestMock,
}));

import { SessionNotAuthenticatedError } from "../session";
import { getAiConversation, listAiConversations } from "./aiConversations";

describe("aiConversations api client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails fast without an active session — no unauthenticated request is issued", async () => {
    requireTokenMock.mockImplementation(() => {
      throw new SessionNotAuthenticatedError();
    });

    await expect(listAiConversations()).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it("lists conversations with the session bearer token", async () => {
    requireTokenMock.mockReturnValue("session-token");
    const summaries = [
      {
        id: "conv-1",
        title: "Organize downloads",
        maxToolRounds: 4,
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-01T10:00:00.000Z",
        turnState: "awaiting-approval" as const,
        pendingApprovals: [],
      },
    ];
    apiRequestMock.mockResolvedValue(summaries);

    const result = await listAiConversations();

    expect(apiRequestMock).toHaveBeenCalledWith("/api/ai/conversations", { token: "session-token" });
    expect(result).toEqual(summaries);
  });

  it("fetches one conversation with the session bearer token and URL-encodes the id", async () => {
    requireTokenMock.mockReturnValue("session-token");
    const detail = {
      id: "conv/1",
      title: null,
      maxToolRounds: 4,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
      turnState: "completed" as const,
      pendingApprovals: [],
      messages: [],
    };
    apiRequestMock.mockResolvedValue(detail);

    const result = await getAiConversation("conv/1");

    expect(apiRequestMock).toHaveBeenCalledWith("/api/ai/conversations/conv%2F1", {
      token: "session-token",
    });
    expect(result).toEqual(detail);
  });

  it("propagates backend error envelopes (e.g. 404 conversation not found)", async () => {
    requireTokenMock.mockReturnValue("session-token");
    apiRequestMock.mockRejectedValue(new Error("Agent conversation was not found."));

    await expect(getAiConversation("conv-1")).rejects.toThrow("not found");
  });
});