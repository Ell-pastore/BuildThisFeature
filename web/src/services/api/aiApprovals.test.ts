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
import { approveAiApproval, rejectAiApproval } from "./aiApprovals";

const ISO = "2026-09-01T10:00:00.000Z";
const APPROVAL = {
  id: "ap-1",
  conversationId: "conv-1",
  messageId: "m2",
  toolName: "move-file",
  arguments: { fileId: "file-1", name: "receipt.pdf" },
  status: "pending",
  createdAt: ISO,
  updatedAt: ISO,
  expiresAt: "2099-01-01T00:00:00.000Z",
  decidedAt: null,
};

describe("aiApprovals api client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails fast without an active session — no unauthenticated request is issued", async () => {
    requireTokenMock.mockImplementation(() => {
      throw new SessionNotAuthenticatedError();
    });

    await expect(approveAiApproval("ap-1")).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
    await expect(rejectAiApproval("ap-1")).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it("approves one approval with the session bearer token and URL-encodes the id", async () => {
    requireTokenMock.mockReturnValue("session-token");
    apiRequestMock.mockResolvedValue({ ...APPROVAL, status: "approved" });

    const result = await approveAiApproval("ap/1");

    expect(apiRequestMock).toHaveBeenCalledWith("/api/ai/approvals/ap%2F1/approve", {
      method: "POST",
      token: "session-token",
    });
    expect(result.status).toBe("approved");
  });

  it("rejects one approval with the session bearer token and URL-encodes the id", async () => {
    requireTokenMock.mockReturnValue("session-token");
    apiRequestMock.mockResolvedValue({ ...APPROVAL, status: "rejected" });

    const result = await rejectAiApproval("ap/1");

    expect(apiRequestMock).toHaveBeenCalledWith("/api/ai/approvals/ap%2F1/reject", {
      method: "POST",
      token: "session-token",
    });
    expect(result.status).toBe("rejected");
  });

  it("propagates backend error envelopes untouched (e.g. 400 expired decision)", async () => {
    requireTokenMock.mockReturnValue("session-token");
    apiRequestMock.mockRejectedValue(
      new ApiClientError(
        400,
        "common/bad-request",
        "This tool approval has expired and cannot be decided.",
      ),
    );

    await expect(approveAiApproval("ap-1")).rejects.toMatchObject({
      status: 400,
      code: "common/bad-request",
    });
  });
});