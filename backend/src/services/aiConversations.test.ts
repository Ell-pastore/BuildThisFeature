/**
 * AI conversation history service tests (Phase 10.23).
 *
 * The repository is mocked; the mapping/sanitization layer is REAL. Covers:
 *
 *   1. listAiConversations — summary shape, newest-first passthrough, empty.
 *   2. getAiConversation — detail + chronological transcript, foreign/missing
 *      → the SAME 404 `common/not-found`, malformed id → 400 before any query.
 *   3. Safe structured projection — tool-call intents and tool-result metadata
 *      returned in their structured safe form.
 *   4. Raw file contents are never exposed, even when a stored result carries
 *      a base64 `read_file` payload.
 *   5. `fileId` / `versionId` references are returned as references only.
 *   6. Failed results expose only structured code/category (no message).
 *   7. Nothing leaks: no provider keys, credential handles, env-shaped
 *      strings, filesystem paths beyond conversation references, provider
 *      internals, stack traces, or DB internals in serialized output.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../core/errors.js";
import {
  deleteAiConversation,
  getAiConversation,
  listAiConversations,
  renameAiConversation,
  projectStructuredValue,
  type AiConversationDetail,
  type AiConversationDeletionResult,
  type AiConversationRenameResult,
  type AiConversationSummary,
} from "./aiConversations.js";
import { AgentConversationNotFoundError } from "../database/repositories/agentConversations.js";

const mocks = vi.hoisted(() => ({
  listAgentConversations: vi.fn(),
  getAgentConversation: vi.fn(),
  deleteAgentConversation: vi.fn(),
  renameAgentConversation: vi.fn(),
}));

vi.mock("../database/repositories/agentConversations.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../database/repositories/agentConversations.js")>();
  return {
    ...actual,
    listAgentConversations: mocks.listAgentConversations,
    getAgentConversation: mocks.getAgentConversation,
    deleteAgentConversation: mocks.deleteAgentConversation,
    renameAgentConversation: mocks.renameAgentConversation,
  };
});

const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const BASE_CONVERSATION = {
  id: CONVERSATION_ID,
  userId: ALICE,
  title: "Invoice review",
  maxToolRounds: 3,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-03T00:00:00Z"),
};

function storedMessage(overrides?: object): { id: string; role: string; content: string; createdAt: Date; isFinal: boolean; toolCalls?: unknown; toolResults?: unknown } {
  return {
    id: "msg-1",
    role: "user",
    content: "List my files.",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    isFinal: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. List
// ---------------------------------------------------------------------------

describe("listAiConversations", () => {
  it("returns safe summaries in the repository's newest-first order", async () => {
    mocks.listAgentConversations.mockResolvedValue([
      {
        ...BASE_CONVERSATION,
        id: "first-conv",
        updatedAt: new Date("2026-01-03T00:00:00Z"),
        privateKey: "sk-nope",
      },
      {
        ...BASE_CONVERSATION,
        id: "second-conv",
        title: null,
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      },
    ] as unknown as Awaited<ReturnType<typeof mocks.listAgentConversations>>);

    const rows: AiConversationSummary[] = await listAiConversations(ALICE);

    expect(mocks.listAgentConversations).toHaveBeenCalledWith(ALICE);
    expect(rows.map((r) => r.id)).toEqual(["first-conv", "second-conv"]);
    expect(rows[0]).toEqual({
      id: "first-conv",
      title: "Invoice review",
      maxToolRounds: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(rows[1]?.title).toBeNull();
    // The summary is an explicit projection — arbitrary repo columns never
    // reach the response.
    expect(JSON.stringify(rows)).not.toContain("sk-nope");
    expect(JSON.stringify(rows)).not.toContain("userId");
  });

  it("returns a valid empty array for empty history", async () => {
    mocks.listAgentConversations.mockResolvedValue([]);

    expect(await listAiConversations(ALICE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2 & 6. Single retrieval + 404 / validation
// ---------------------------------------------------------------------------

describe("getAiConversation", () => {
  it("returns the conversation with its chronological transcript", async () => {
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: [
        storedMessage({ createdAt: new Date("2026-01-01T00:00:01Z") }),
        storedMessage({
          id: "msg-2",
          role: "assistant",
          content: "Done.",
          isFinal: true,
          createdAt: new Date("2026-01-01T00:00:02Z"),
        }),
      ],
    });

    const detail: AiConversationDetail = await getAiConversation(ALICE, CONVERSATION_ID);

    expect(mocks.getAgentConversation).toHaveBeenCalledWith(ALICE, CONVERSATION_ID);
    expect(detail.id).toBe(CONVERSATION_ID);
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.messages.map((m) => m.createdAt)).toEqual([
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
    ]);
  });

  it("maps a foreign AND a missing conversation to the same 404 not-found", async () => {
    mocks.getAgentConversation.mockResolvedValue(null);
    mocks.getAgentConversation.mockResolvedValueOnce(null);

    const foreign = await getAiConversation(ALICE, CONVERSATION_ID).catch((e) => e);
    const missing = await getAiConversation(ALICE, "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee").catch((e) => e);

    expect(foreign).toBeInstanceOf(AppError);
    expect(foreign).toMatchObject({ status: 404, code: "common/not-found" });
    expect(missing).toMatchObject({ status: 404, code: "common/not-found" });
    expect(foreign).toEqual(missing);
  });

  it("rejects a malformed conversationId with 400 before any repository call", async () => {
    for (const bad of ["", "not-a-uuid", "../etc/passwd", "GGGGGGGG-…", "azure"]) {
      await expect(getAiConversation(ALICE, bad)).rejects.toMatchObject({
        status: 400,
        code: "common/bad-request",
      });
    }
    expect(mocks.getAgentConversation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3, 4, 5, 6, 7. Safe structured projection + leak tests
// ---------------------------------------------------------------------------

describe("getAiConversation — safe structured projection", () => {
  it("returns tool intents and result metadata in their structured safe form", async () => {
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: [
        storedMessage(),
        storedMessage({
          id: "msg-2",
          role: "assistant",
          content: "Listing…",
          isFinal: false,
          toolCalls: [
            { id: "c1", toolName: "list_directory", input: { path: "/home/me" } },
          ],
          toolResults: [
            {
              ok: true,
              callId: "c1",
              data: {
                path: "/home/me",
                isHome: true,
                itemCount: 2,
                items: [{ name: "bills.pdf", sizeBytes: 1024 }],
              },
            },
          ],
        }),
      ],
    });

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);

    const round = detail.messages[1];
    expect(round?.toolCalls).toEqual([
      { callId: "c1", toolName: "list_directory", input: { path: "/home/me" } },
    ]);
    expect(round?.toolResults).toEqual([
      {
        ok: true,
        callId: "c1",
        data: {
          path: "/home/me",
          isHome: true,
          itemCount: 2,
          items: [{ name: "bills.pdf", sizeBytes: 1024 }],
        },
      },
    ]);
  });

  it("never exposes raw file contents, even when a stored result carries a base64 payload", async () => {
    const rawContent = "TOP-SECRET FILE BODY";
    const base64Body = Buffer.from(rawContent).toString("base64");
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: [
        storedMessage(),
        storedMessage({
          id: "msg-2",
          role: "assistant",
          content: "Reading…",
          toolCalls: [{ id: "r1", toolName: "read_file", input: { path: "/home/me/secret.txt" } }],
          toolResults: [{ ok: true, callId: "r1", data: { encoding: "base64", data: base64Body } }],
        }),
      ],
    });

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);
    const serialized = JSON.stringify(detail);

    expect(serialized).not.toContain(base64Body);
    expect(serialized).not.toContain(rawContent);
    expect(serialized).not.toContain("TOP-SECRET");
    expect(serialized).not.toContain('"data"');
    expect(serialized).not.toContain('"encoding"');
  });

  it("keeps structured fileId/versionId references as references only (never contents)", async () => {
    const fileId = "f0000000-0000-0000-0000-0000000000f0";
    const versionId = "v0000000-0000-0000-0000-0000000000v0";
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: [
        storedMessage(),
        storedMessage({
          id: "msg-2",
          role: "assistant",
          content: "Analyzed.",
          toolCalls: [{ id: "a1", toolName: "read_file_metadata", input: { fileId, versionId } }],
          toolResults: [{ ok: true, callId: "a1", data: { fileId, versionId, name: "bill.pdf" } }],
        }),
      ],
    });

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);
    const serialized = JSON.stringify(detail);

    expect(serialized).toContain(fileId);
    expect(serialized).toContain(versionId);
    expect(serialized).toContain('"name":"bill.pdf"');
    // The ids are opaque REFERENCES in structured metadata — never expanded
    // into file rows or content. Only the transcript's own text is present.
    expect(serialized).not.toContain('"fileId":"' + fileId + '"' + '"contents"');
    expect(serialized).not.toContain("bill.pdf contents");
  });

  it("reduces failed tool results to structured code/category and drops the message", async () => {
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: [
        storedMessage(),
        storedMessage({
          id: "msg-2",
          role: "assistant",
          content: "Denied.",
          toolCalls: [{ id: "f1", toolName: "read_file", input: {} }],
          toolResults: [
            {
              ok: false,
              callId: "f1",
              error: {
                code: "filesystem/read-unauthorized",
                category: "authorization",
                message: "unable to read /Users/me/: permission denied (internal)",
              },
            },
          ],
        }),
      ],
    });

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);
    const serialized = JSON.stringify(detail);

    expect(detail.messages[1]?.toolResults).toEqual([
      {
        ok: false,
        callId: "f1",
        error: { code: "filesystem/read-unauthorized", category: "authorization" },
      },
    ]);
    expect(serialized).not.toContain("permission denied");
    expect(serialized).not.toContain("/Users/me");
  });

  it("guarantees no provider keys, credential handles, env, internals, or stack traces leak", async () => {
    const fakeKey = "sk-LIVE-AAAAAAAA";
    const fakeHandle = "credential-1";
    const fakeEnv = "GROK_API_KEY";
    mocks.getAgentConversation.mockResolvedValue({
      conversation: BASE_CONVERSATION,
      messages: [
        storedMessage(),
        storedMessage({
          id: "msg-2",
          role: "assistant",
          content: "Reading…",
          toolCalls: [{ id: "x1", toolName: "read_file", input: {} }],
          toolResults: [
            {
              ok: true,
              callId: "x1",
              data: {
                providerConfig: { apiKey: fakeKey, handle: fakeHandle },
                traced: "Error: at getAgentConversation (internal.ts:42)",
                envFile: { [fakeEnv]: "nope" },
              },
            },
          ],
        }),
      ],
    });

    const detail = await getAiConversation(ALICE, CONVERSATION_ID);
    const serialized = JSON.stringify(detail);

    expect(serialized).not.toContain(fakeKey);
    expect(serialized).not.toContain(fakeHandle);
    expect(serialized).not.toContain(fakeEnv);
    expect(serialized).not.toContain("internal.ts");
    expect(serialized).not.toContain("Error: at ");
  });

  it("projectStructuredValue strips content-bearing fields recursively at any depth", () => {
    expect(projectStructuredValue({ data: "x", encoding: "base64", keep: 1 })).toEqual({
      keep: 1,
    });
    expect(
      projectStructuredValue({ nested: { deep: { content: "y", text: "z", lines: ["a"] } } }),
    ).toEqual({ nested: { deep: {} } });
    expect(projectStructuredValue([{ raw: "x" }, "plain"])).toEqual([{}, "plain"]);
    expect(projectStructuredValue({ fileId: "f-1", name: "a.pdf", meta: "b" })).toEqual({
      fileId: "f-1",
      name: "a.pdf",
      meta: "b",
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 10.24 delete
// ---------------------------------------------------------------------------

describe("deleteAiConversation", () => {
  it("deletes an owned conversation and returns the small stable success result", async () => {
    mocks.deleteAgentConversation.mockResolvedValue(undefined);

    const result: AiConversationDeletionResult = await deleteAiConversation(
      ALICE,
      CONVERSATION_ID,
    );

    expect(mocks.deleteAgentConversation).toHaveBeenCalledWith(ALICE, CONVERSATION_ID);
    expect(result).toEqual({ conversationId: CONVERSATION_ID, deleted: true });
    // The stable result carries only confirmation — never deleted contents.
    expect(Object.keys(result).sort()).toEqual(["conversationId", "deleted"]);
  });

  it("rejects a malformed conversationId with 400 before touching the repository", async () => {
    for (const bad of ["", "not-a-uuid", "../etc/passwd", "GGGG"]) {
      await expect(deleteAiConversation(ALICE, bad)).rejects.toMatchObject({
        status: 400,
        code: "common/bad-request",
      });
    }
    expect(mocks.deleteAgentConversation).not.toHaveBeenCalled();
  });

  it("maps a foreign AND a missing conversation to the same 404 (indistinguishable)", async () => {
    mocks.deleteAgentConversation.mockImplementation(() => {
      throw new AgentConversationNotFoundError();
    });

    const foreign = await deleteAiConversation(ALICE, CONVERSATION_ID).catch((e) => e);
    const missing = await deleteAiConversation(
      ALICE,
      "ddd11111-1111-1111-1111-111111111111",
    ).catch((e) => e);

    expect(foreign).toBeInstanceOf(AppError);
    expect(foreign).toMatchObject({ status: 404, code: "common/not-found" });
    expect(missing).toEqual(foreign);
  });

  it("treats a repeated deletion of an already-deleted conversation as 404", async () => {
    mocks.deleteAgentConversation
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AgentConversationNotFoundError());

    await expect(deleteAiConversation(ALICE, CONVERSATION_ID)).resolves.toMatchObject({
      deleted: true,
    });
    await expect(deleteAiConversation(ALICE, CONVERSATION_ID)).rejects.toMatchObject({
      status: 404,
      code: "common/not-found",
    });
  });

  it("propagates unexpected repository failures raw for the generic internal-error envelope", async () => {
    const raw = new Error("SECRET SQL: SELECT * FROM internal.creds at db.ts:9");
    mocks.deleteAgentConversation.mockRejectedValueOnce(raw);

    const outcome = await deleteAiConversation(ALICE, CONVERSATION_ID).catch((e) => e);

    expect(outcome).toBe(raw);
    expect(outcome).not.toBeInstanceOf(AppError);
  });

  it("never treats stored fileId/versionId references as deletion targets", async () => {
    mocks.deleteAgentConversation.mockResolvedValue(undefined);

    await deleteAiConversation(ALICE, CONVERSATION_ID);

    // The service/repository scope never receives file or version ids — only
    // the conversation id. Anything beyond that is the repository's domain.
    expect(mocks.deleteAgentConversation).toHaveBeenCalledWith(ALICE, CONVERSATION_ID);
    expect(mocks.deleteAgentConversation).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 10.25 rename
// ---------------------------------------------------------------------------

describe("renameAiConversation", () => {
  it("renames an owned conversation and returns the stable title result", async () => {
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "New title",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });

    const result: AiConversationRenameResult = await renameAiConversation(
      ALICE,
      CONVERSATION_ID,
      "New title",
    );

    expect(mocks.renameAgentConversation).toHaveBeenCalledWith(ALICE, CONVERSATION_ID, "New title");
    expect(result).toEqual({ conversationId: CONVERSATION_ID, title: "New title" });
    // The stable result is an explicit projection — no updatedAt, userId,
    // or other repository columns leak.
    expect(Object.keys(result).sort()).toEqual(["conversationId", "title"]);
  });

  it("trims leading and trailing whitespace from the title", async () => {
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Trimmed",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });

    const result = await renameAiConversation(ALICE, CONVERSATION_ID, "  Trimmed  ");

    expect(mocks.renameAgentConversation).toHaveBeenCalledWith(ALICE, CONVERSATION_ID, "Trimmed");
    expect(result.title).toBe("Trimmed");
  });

  it("passes the 255-character trimmed title to the repository", async () => {
    const maxTitle = "a".repeat(255);
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: maxTitle,
      updatedAt: "2026-01-03T00:00:00.000Z",
    });

    const result = await renameAiConversation(ALICE, CONVERSATION_ID, maxTitle);

    expect(mocks.renameAgentConversation).toHaveBeenCalledWith(ALICE, CONVERSATION_ID, maxTitle);
    expect(result.title).toBe(maxTitle);
  });

  it("rejects a non-string title with 400 common/bad-request", async () => {
    for (const bad of [42, true, null, undefined, {}, []]) {
      await expect(renameAiConversation(ALICE, CONVERSATION_ID, bad as unknown as string)).rejects.toMatchObject({
        status: 400,
        code: "common/bad-request",
      });
    }
    expect(mocks.renameAgentConversation).not.toHaveBeenCalled();
  });

  it("rejects an empty or whitespace-only title with 400 common/bad-request", async () => {
    for (const bad of ["", "   ", "\t\n"]) {
      await expect(renameAiConversation(ALICE, CONVERSATION_ID, bad)).rejects.toMatchObject({
        status: 400,
        code: "common/bad-request",
      });
    }
    expect(mocks.renameAgentConversation).not.toHaveBeenCalled();
  });

  it("rejects a title exceeding 255 characters after trimming with 400", async () => {
    await expect(
      renameAiConversation(ALICE, CONVERSATION_ID, "x".repeat(256)),
    ).rejects.toMatchObject({ status: 400, code: "common/bad-request" });
    // Exactly 255 after trim is valid
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "x".repeat(255),
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    await expect(
      renameAiConversation(ALICE, CONVERSATION_ID, "x".repeat(255)),
    ).resolves.toMatchObject({ title: "x".repeat(255) });
    expect(mocks.renameAgentConversation).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed conversationId with 400 before any repository call", async () => {
    for (const bad of ["", "not-a-uuid", "../etc/passwd", "GGGG"]) {
      await expect(renameAiConversation(ALICE, bad, "ok")).rejects.toMatchObject({
        status: 400,
        code: "common/bad-request",
      });
    }
    expect(mocks.renameAgentConversation).not.toHaveBeenCalled();
  });

  it("maps a foreign AND a missing conversation to the same 404 not-found", async () => {
    mocks.renameAgentConversation.mockImplementation(() => {
      throw new AgentConversationNotFoundError();
    });

    const foreign = await renameAiConversation(ALICE, CONVERSATION_ID, "New").catch((e) => e);
    const missing = await renameAiConversation(
      ALICE,
      "ddd11111-1111-1111-1111-111111111111",
      "New",
    ).catch((e) => e);

    expect(foreign).toBeInstanceOf(AppError);
    expect(foreign).toMatchObject({ status: 404, code: "common/not-found" });
    expect(missing).toMatchObject({ status: 404, code: "common/not-found" });
    expect(foreign).toEqual(missing);
  });

  it("propagates unexpected repository failures raw for the generic internal-error envelope", async () => {
    const raw = new Error("SECRET SQL: SELECT * FROM internal.creds at db.ts:9");
    mocks.renameAgentConversation.mockRejectedValueOnce(raw);

    const outcome = await renameAiConversation(ALICE, CONVERSATION_ID, "New").catch((e) => e);

    expect(outcome).toBe(raw);
    expect(outcome).not.toBeInstanceOf(AppError);
  });

  it("returns ONLY the conversationId and title — no updatedAt, no userId, no extra fields", async () => {
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Updated",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });

    const result = await renameAiConversation(ALICE, CONVERSATION_ID, "Updated");

    expect(Object.keys(result)).toEqual(["conversationId", "title"]);
    expect(JSON.stringify(result)).not.toContain(ALICE);
    expect(JSON.stringify(result)).not.toContain("updatedAt");
  });

  it("confirms the same title can be written twice (idempotent)", async () => {
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Stable",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });

    const first = await renameAiConversation(ALICE, CONVERSATION_ID, "Stable");
    const second = await renameAiConversation(ALICE, CONVERSATION_ID, "Stable");

    expect(first).toEqual(second);
    expect(mocks.renameAgentConversation).toHaveBeenCalledTimes(2);
  });

  it("confirms no provider/network/filesystem operations occur", async () => {
    mocks.renameAgentConversation.mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Safe",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await renameAiConversation(ALICE, CONVERSATION_ID, "Safe");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
  });
});