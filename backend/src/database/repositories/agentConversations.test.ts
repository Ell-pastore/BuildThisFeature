/**
 * Agent conversation repository tests (Phase 10.7).
 *
 * The Perspicuous Prisma client is mocked (`../client.js` → `getDatabase`)
 * with an in-memory fake so the repository runs without a database. Tests
 * cover:
 *
 *   1. createAgentConversation persisting ownership + bound + instruction.
 *   2. appendAgentTurn / appendAgentFinal round-tripping a full Phase 10.6
 *      state via loadAgentConversationState.
 *   3. Ownership enforcement on load and on append (foreign user is
 *      indistinguishable from "missing").
 *   4. Input validation gating writes (TypeError before any insert).
 *   5. reconstructConversationState as a pure replay function: turn resets,
 *      system rows ignored, serialized ToolErrors restored, corrupt rows
 *      rejected.
 *   6. Exact preservation of file_id / version_id references.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentConversationCorruptError,
  AgentConversationNotFoundError,
  appendAgentFinal,
  appendAgentTurn,
  createAgentConversation,
  getAgentConversation,
  listAgentConversations,
  loadAgentConversationState,
  persistAgentTurn,
  reconstructConversationState,
} from "./agentConversations.js";
import { ToolError } from "../../tools/errors.js";
import type { AgentToolResult } from "../../services/agent.js";
import type { ConversationState } from "../../services/conversation.js";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
}));

vi.mock("../client.js", () => ({
  getDatabase: mocks.getDatabase,
}));

// ---------------------------------------------------------------------------
// In-memory fake Prisma client
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

const PRISMA_SORT_ASC = "asc" as const;
const PRISMA_SORT_DESC = "desc" as const;

/** In-memory equivalent of Prisma's `orderBy: [{ field: "asc" | "desc" }]`. */
function sortBy(rows: AnyRecord[], orderBy?: AnyRecord[]): AnyRecord[] {
  if (orderBy === undefined || orderBy.length === 0) {
    return [...rows];
  }
  return [...rows].sort((a, b) => {
    for (const clause of orderBy) {
      for (const [field, direction] of Object.entries(clause)) {
        const av = a[field] instanceof Date ? (a[field] as Date).getTime() : (a[field] as string);
        const bv = b[field] instanceof Date ? (b[field] as Date).getTime() : (b[field] as string);
        if (av < bv) return direction === PRISMA_SORT_ASC ? -1 : 1;
        if (av > bv) return direction === PRISMA_SORT_ASC ? 1 : -1;
      }
    }
    return 0;
  });
}

function createFakeDb() {
  const conversations: AnyRecord[] = [];
  const messages: AnyRecord[] = [];
  let convSeq = 0;
  let msgSeq = 0;

  const delegates = {
    aiConversation: {
      create: vi.fn(async ({ data }: { data: AnyRecord }) => {
        convSeq += 1;
        const row = {
          id: `conv-${convSeq}`,
          createdAt: new Date(1_700_000_000_000 + convSeq),
          updatedAt: new Date(1_700_000_000_000 + convSeq),
          ...data,
        };
        conversations.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where = {} }: { where?: AnyRecord }) => {
        const row = conversations.find(
          (c) =>
            (where.id === undefined || c.id === where.id) &&
            (where.userId === undefined || c.userId === where.userId),
        );
        return row ?? null;
      }),
      findMany: vi.fn(async ({ where = {}, orderBy }: { where?: AnyRecord; orderBy?: AnyRecord[] }) => {
        const rows = conversations.filter(
          (c) => where.userId === undefined || c.userId === where.userId,
        );
        return sortBy(rows, orderBy);
      }),
      update: vi.fn(async ({ where, data }: { where: AnyRecord; data: AnyRecord }) => {
        const row = conversations.find((c) => c.id === where.id);
        if (!row) throw new Error(`Conversation ${where.id} not found (fake).`);
        Object.assign(row, data);
        return row;
      }),
    },
    aiMessage: {
      create: vi.fn(async ({ data }: { data: AnyRecord }) => {
        msgSeq += 1;
        const row = {
          id: `msg-${msgSeq}`,
          isFinal: false,
          toolCalls: null,
          toolResults: null,
          ...data,
          createdAt: data.createdAt ?? new Date(1_700_000_000_000 + msgSeq),
        };
        messages.push(row);
        return row;
      }),
      findMany: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where?: { conversationId?: string };
          orderBy?: AnyRecord[];
        }) => {
          const rows = messages.filter((m) => m.conversationId === where?.conversationId);
          return sortBy(rows, orderBy);
        },
      ),
    },
    $transaction: vi.fn(async (fn: (tx: typeof delegates) => Promise<unknown>) => {
      return await fn(delegates);
    }),
  };
  return { delegates, conversations, messages };
}

const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function agentStateMatchers(state: ConversationState) {
  return {
    instruction: state.instruction,
    messageCount: state.messages.length,
    toolRounds: state.toolRounds,
    toolResults: state.toolResults,
    finalText: state.finalText,
    remaining: state.maxToolRounds - state.toolRounds,
  };
}

describe("agentConversations repository", () => {
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    db = createFakeDb();
    mocks.getDatabase.mockReturnValue(db.delegates);
  });

  describe("createAgentConversation", () => {
    it("persists ownership, bound, and the instruction message", async () => {
      const created = await createAgentConversation({
        userId: ALICE,
        instruction: "Summarize the invoices.",
        maxToolRounds: 3,
        title: "Invoice summary",
      });

      expect(created.userId).toBe(ALICE);
      expect(created.maxToolRounds).toBe(3);
      expect(created.title).toBe("Invoice summary");
      expect(db.conversations).toHaveLength(1);
      expect(db.conversations[0]).toMatchObject({ userId: ALICE, maxToolRounds: 3 });
      expect(db.messages[0]).toMatchObject({
        conversationId: created.id,
        role: "user",
        content: "Summarize the invoices.",
      });
    });

    it("rejects an invalid bound before writing anything", async () => {
      await expect(
        createAgentConversation({ userId: ALICE, instruction: "Hi", maxToolRounds: 0 }),
      ).rejects.toThrow(TypeError);
      expect(db.conversations).toHaveLength(0);
      expect(db.messages).toHaveLength(0);
    });

    it("rejects an empty instruction before writing anything", async () => {
      await expect(
        createAgentConversation({ userId: ALICE, instruction: "", maxToolRounds: 2 }),
      ).rejects.toThrow(TypeError);
      expect(db.conversations).toHaveLength(0);
    });
  });

  describe("loadAgentConversationState round-trip", () => {
    it("returns a fresh state right after creation", async () => {
      const created = await createAgentConversation({
        userId: ALICE,
        instruction: "List large files.",
        maxToolRounds: 2,
      });
      const state = await loadAgentConversationState(ALICE, created.id);

      expect(state).not.toBeNull();
      expect(agentStateMatchers(state as ConversationState)).toEqual({
        instruction: "List large files.",
        messageCount: 0,
        toolRounds: 0,
        toolResults: [],
        finalText: undefined,
        remaining: 2,
      });
    });

    it("replays appended provider rounds and the final reply", async () => {
      const created = await createAgentConversation({
        userId: ALICE,
        instruction: "Find my spreadsheets.",
        maxToolRounds: 2,
      });
      const calls = [{ id: "call-1", toolName: "read_file_metadata", input: { path: "/a.xlsx" } }];
      await appendAgentTurn(ALICE, created.id, {
        text: "Looking…",
        toolCalls: calls,
        toolResults: [{ ok: true, callId: "call-1", data: { rows: 42 } }],
      });
      await appendAgentFinal(ALICE, created.id, "Found one spreadsheet.");

      const state = (await loadAgentConversationState(ALICE, created.id)) as ConversationState;
      expect(agentStateMatchers(state)).toEqual({
        instruction: "Find my spreadsheets.",
        messageCount: 2,
        toolRounds: 1,
        toolResults: [{ ok: true, callId: "call-1", data: { rows: 42 } }],
        finalText: "Found one spreadsheet.",
        remaining: 1,
      });
      const first = state.messages[0];
      if (!first) throw new Error("expected a provider message");
      expect(first.kind).toBe("provider");
      if (first.kind === "provider") {
        expect(first.text).toBe("Looking…");
        expect(first.toolCalls).toHaveLength(1);
      }
      expect(state.messages[1]).toEqual({ kind: "final", text: "Found one spreadsheet." });
    });

    it("preserves exact file_id / version_id references verbatim", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Analyze", maxToolRounds: 1 });
      const fileId = "f0000000-0000-0000-0000-0000000000f0";
      const versionId = "v0000000-0000-0000-0000-0000000000v0";
      const calls = [
        { id: "c1", toolName: "read_file", input: { fileId, versionId, only: ["summary"] } },
      ];
      await appendAgentTurn(ALICE, created.id, { toolCalls: calls });
      await appendAgentFinal(ALICE, created.id, "Done.");

      const state = (await loadAgentConversationState(ALICE, created.id)) as ConversationState;
      const provider = state.messages[0];
      if (!provider || provider.kind !== "provider" || provider.toolCalls === undefined) {
        throw new Error("expected a provider message with tool calls");
      }
      expect(provider.toolCalls[0]).toEqual({ id: "c1", toolName: "read_file", input: { fileId, versionId, only: ["summary"] } });
    });

    it("restores a serialized ToolError to a real instance", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Analyze", maxToolRounds: 1 });
      await appendAgentTurn(ALICE, created.id, {
        toolCalls: [{ id: "c1", toolName: "read_file", input: { path: "/nope" } }],
        toolResults: [
          {
            ok: false,
            callId: "c1",
            error: ToolError.notFound("filesystem/not-found", "No such file."),
          },
        ],
      });

      const state = (await loadAgentConversationState(ALICE, created.id)) as ConversationState;
      expect(state.toolResults).toHaveLength(1);
      const result = state.toolResults[0];
      if (!result || result.ok !== false) throw new Error("expected a failed result");
      expect(result.error).toBeInstanceOf(ToolError);
      expect(result.error.code).toBe("filesystem/not-found");
      expect(result.error.category).toBe("not_found");
    });

    it("bumps updated_at when appending", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Hi", maxToolRounds: 1 });
      const before = created.updatedAt.getTime();
      await appendAgentFinal(ALICE, created.id, "Bye.");
      const stored = db.conversations[0];
      if (!stored) throw new Error("expected a stored conversation");
      expect((stored.updatedAt as Date).getTime()).toBeGreaterThan(before);
    });
  });

  describe("ownership enforcement", () => {
    it("returns null for a foreign owner on load", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Private", maxToolRounds: 1 });
      expect(await loadAgentConversationState(BOB, created.id)).toBeNull();
    });

    it("returns null for an unknown conversation id", async () => {
      expect(
        await loadAgentConversationState(ALICE, "00000000-0000-0000-0000-000000000000"),
      ).toBeNull();
    });

    it("throws not-found for a foreign owner on append", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Private", maxToolRounds: 1 });
      await expect(appendAgentTurn(BOB, created.id, { text: "sneak" })).rejects.toThrow(
        AgentConversationNotFoundError,
      );
      expect(db.messages).toHaveLength(1);
    });

    it("throws not-found for a foreign owner on final", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Private", maxToolRounds: 1 });
      await expect(appendAgentFinal(BOB, created.id, "done")).rejects.toThrow(
        AgentConversationNotFoundError,
      );
    });
  });

  describe("input gating", () => {
    it("rejects malformed tool calls before writing", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Hi", maxToolRounds: 1 });
      const before = db.messages.length;
      await expect(
        appendAgentTurn(ALICE, created.id, { toolCalls: [{ id: "c1", toolName: "", input: {} }] }),
      ).rejects.toThrow(TypeError);
      expect(db.messages.length).toBe(before);
    });

    it("rejects a turn with neither text nor tool calls", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Hi", maxToolRounds: 1 });
      await expect(appendAgentTurn(ALICE, created.id, {})).rejects.toThrow(TypeError);
      expect(db.messages).toHaveLength(1);
    });

    it("rejects an empty final response", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Hi", maxToolRounds: 1 });
      await expect(appendAgentFinal(ALICE, created.id, "")).rejects.toThrow(TypeError);
      expect(db.messages).toHaveLength(1);
    });

    it("rejects malformed tool results before writing", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Hi", maxToolRounds: 1 });
      await expect(
        appendAgentTurn(ALICE, created.id, {
          text: "ok",
          toolResults: [{ callId: 42 } as unknown as AgentToolResult],
        }),
      ).rejects.toThrow(TypeError);
      expect(db.messages).toHaveLength(1);
    });
  });

  describe("reconstructConversationState (pure)", () => {
    it("replays a provider round and final via stored rows", () => {
      const state = reconstructConversationState(2, [
        { role: "user", content: "Go", isFinal: false, createdAt: new Date(1000) },
        {
          role: "assistant",
          content: "working",
          isFinal: false,
          createdAt: new Date(2000),
          toolCalls: [{ id: "c1", toolName: "list_files", input: {} }],
          toolResults: [{ ok: true, callId: "c1", data: [] }],
        },
        { role: "assistant", content: "Finished", isFinal: true, createdAt: new Date(3000) },
      ]);
      expect(agentStateMatchers(state)).toEqual({
        instruction: "Go",
        messageCount: 2,
        toolRounds: 1,
        toolResults: [{ ok: true, callId: "c1", data: [] }],
        finalText: "Finished",
        remaining: 1,
      });
    });

    it("replays messages ordered by created_at even when stored shuffled", () => {
      const state = reconstructConversationState(1, [
        { role: "assistant", content: "Done", isFinal: true, createdAt: new Date(3000) },
        { role: "assistant", content: "busy", isFinal: false, createdAt: new Date(2000), toolCalls: [{ id: "c1", toolName: "stat", input: {} }] },
        { role: "user", content: "Proceed", isFinal: false, createdAt: new Date(1000) },
      ]);
      const first = state.messages[0];
      if (!first) throw new Error("expected a provider message");
      expect(first.kind).toBe("provider");
      expect(state.finalText).toBe("Done");
    });

    it("treats system rows as non-transcript noise", () => {
      const state = reconstructConversationState(1, [
        { role: "system", content: "You are helpful.", isFinal: false, createdAt: new Date(500) },
        { role: "user", content: "Proceed", isFinal: false, createdAt: new Date(1000) },
        { role: "assistant", content: "Done", isFinal: true, createdAt: new Date(2000) },
      ]);
      expect(state.instruction).toBe("Proceed");
      expect(agentStateMatchers(state).messageCount).toBe(1);
    });

    it("starts a new turn at a later user row", () => {
      const state = reconstructConversationState(2, [
        { role: "user", content: "First", isFinal: false, createdAt: new Date(1000) },
        { role: "assistant", content: "One", isFinal: true, createdAt: new Date(2000) },
        { role: "user", content: "Second", isFinal: false, createdAt: new Date(3000) },
        { role: "assistant", content: "Two", isFinal: true, createdAt: new Date(4000) },
      ]);
      expect(agentStateMatchers(state)).toEqual({
        instruction: "Second",
        messageCount: 1,
        toolRounds: 0,
        toolResults: [],
        finalText: "Two",
        remaining: 2,
      });
    });

    it("rejects an assistant message before any instruction", () => {
      expect(() =>
        reconstructConversationState(1, [
          { role: "assistant", content: "orphan", isFinal: false, createdAt: new Date(1000) },
        ]),
      ).toThrow(AgentConversationCorruptError);
    });

    it("rejects an empty transcript", () => {
      expect(() => reconstructConversationState(1, [])).toThrow(AgentConversationCorruptError);
    });

    it("rejects malformed stored tool calls", () => {
      expect(() =>
        reconstructConversationState(1, [
          { role: "user", content: "Go", isFinal: false, createdAt: new Date(1000) },
          {
            role: "assistant",
            content: "",
            isFinal: false,
            createdAt: new Date(2000),
            toolCalls: [{ id: 7 }],
          },
        ]),
      ).toThrow(AgentConversationCorruptError);
    });

    it("rejects a final message that never completed a turn after final", () => {
      expect(() =>
        reconstructConversationState(1, [
          { role: "user", content: "Go", isFinal: false, createdAt: new Date(1000) },
          { role: "assistant", content: "One", isFinal: true, createdAt: new Date(2000) },
          { role: "assistant", content: "Two", isFinal: true, createdAt: new Date(3000) },
        ]),
      ).toThrow(AgentConversationCorruptError);
    });
  });

  describe("persistAgentTurn (atomic)", () => {
    it("creates a conversation and writes instruction, rounds, and final in one transaction", async () => {
      const result = await persistAgentTurn({
        userId: ALICE,
        instruction: "List my docs.",
        maxToolRounds: 2,
        title: "Docs listing",
        rounds: [
          {
            text: "Looking…",
            toolCalls: [{ id: "c1", toolName: "list_directory", input: { path: "/home" } }],
            toolResults: [{ ok: true, callId: "c1", data: { items: [] } }],
          },
        ],
        finalText: "Here they are.",
      });

      expect(result.created).toBe(true);
      expect(result.id).toBeDefined();
      expect(db.conversations).toHaveLength(1);
      expect(db.conversations[0]).toMatchObject({
        userId: ALICE,
        maxToolRounds: 2,
        title: "Docs listing",
      });
      expect(db.messages).toHaveLength(3);
      expect(db.messages.map((m) => [m.role, m.content, m.isFinal])).toEqual([
        ["user", "List my docs.", false],
        ["assistant", "Looking…", false],
        ["assistant", "Here they are.", true],
      ]);
    });

    it("writes rows with strictly increasing created_at so the transcript is ordered", async () => {
      await persistAgentTurn({
        userId: ALICE,
        instruction: "Go",
        maxToolRounds: 2,
        rounds: [
          { toolCalls: [{ id: "c1", toolName: "list_directory", input: {} }], toolResults: [{ ok: true, callId: "c1", data: null }] },
          { toolCalls: [{ id: "c2", toolName: "list_directory", input: {} }], toolResults: [{ ok: true, callId: "c2", data: null }] },
        ],
        finalText: "Done.",
      });

      const times = db.messages.map((m) => (m.createdAt as Date).getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(new Set(times).size).toBe(times.length);
    });

    it("appends a new turn when resuming an owned conversation", async () => {
      const created = await createAgentConversation({
        userId: ALICE,
        instruction: "First turn",
        maxToolRounds: 2,
      });
      const before = db.messages.length;

      const result = await persistAgentTurn({
        userId: ALICE,
        conversationId: created.id,
        instruction: "Second turn",
        maxToolRounds: 5,
        rounds: [{ text: "thinking", toolResults: [] }],
        finalText: "Second reply.",
      });

      expect(result.created).toBe(false);
      expect(result.id).toBe(created.id);
      expect(db.messages.length).toBe(before + 3);
      expect(db.conversations).toHaveLength(1);

      const state = (await loadAgentConversationState(ALICE, created.id)) as ConversationState;
      expect(state.instruction).toBe("Second turn");
      expect(state.finalText).toBe("Second reply.");
    });

    it("rejects a foreign owner with not-found and writes nothing", async () => {
      const created = await createAgentConversation({ userId: ALICE, instruction: "Private", maxToolRounds: 1 });
      const before = db.messages.length;

      await expect(
        persistAgentTurn({
          userId: BOB,
          conversationId: created.id,
          instruction: "sneak",
          maxToolRounds: 2,
          rounds: [],
          finalText: "Done.",
        }),
      ).rejects.toThrow(AgentConversationNotFoundError);
      expect(db.messages.length).toBe(before);
      expect(db.conversations).toHaveLength(1);
    });

    it("rejects an unknown conversation id with not-found", async () => {
      await expect(
        persistAgentTurn({
          userId: ALICE,
          conversationId: "00000000-0000-0000-0000-000000000000",
          instruction: "Hi",
          maxToolRounds: 2,
          rounds: [],
          finalText: "Done.",
        }),
      ).rejects.toThrow(AgentConversationNotFoundError);
      expect(db.conversations).toHaveLength(0);
      expect(db.messages).toHaveLength(0);
    });

    it("validates every input before writing anything", async () => {
      const base = { userId: ALICE, maxToolRounds: 2, rounds: [], finalText: "Done." };

      await expect(
        persistAgentTurn({ ...base, instruction: "" }),
      ).rejects.toThrow(TypeError);
      await expect(
        persistAgentTurn({ ...base, instruction: "Hi", rounds: [{}] }),
      ).rejects.toThrow(TypeError);
      await expect(
        persistAgentTurn({ ...base, instruction: "Hi", finalText: "" }),
      ).rejects.toThrow(TypeError);
      await expect(
        persistAgentTurn({
          ...base,
          instruction: "Hi",
          rounds: [{ toolCalls: [{ id: "x", toolName: "", input: {} }] }],
        }),
      ).rejects.toThrow(TypeError);

      expect(db.conversations).toHaveLength(0);
      expect(db.messages).toHaveLength(0);
    });

    it("preserves exact tool data in the created rows", async () => {
      const fileId = "f0000000-0000-0000-0000-0000000000f0";
      const versionId = "v0000000-0000-0000-0000-0000000000v0";
      await persistAgentTurn({
        userId: ALICE,
        instruction: "Analyze",
        maxToolRounds: 1,
        rounds: [
          {
            text: "idle",
            toolCalls: [{ id: "c1", toolName: "read_file", input: { fileId, versionId } }],
            toolResults: [{ ok: true, callId: "c1", data: { head: "ok" } }],
          },
        ],
        finalText: "Analyzed.",
      });
      const round = db.messages[1];
      if (!round) throw new Error("expected a persisted round");
      expect(round.toolCalls).toEqual([{ id: "c1", toolName: "read_file", input: { fileId, versionId } }]);
      expect(round.toolResults).toEqual([{ ok: true, callId: "c1", data: { head: "ok" } }]);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 10.23 read endpoints
  // ---------------------------------------------------------------------------

  describe("listAgentConversations", () => {
    async function seedConversation(
      userId: string,
      atMs: number,
      title?: string,
    ): Promise<string> {
      const created = await createAgentConversation({
        userId,
        instruction: `Instruction at ${atMs}`,
        maxToolRounds: 3,
        ...(title !== undefined ? { title } : {}),
      });
      // The fake bumps updatedAt through `bumpUpdatedAt`; force the ordering
      // timestamps directly so the test owns the clock.
      const row = db.conversations.find((c) => c.id === created.id);
      if (!row) throw new Error("expected a conversation row");
      row.createdAt = new Date(atMs);
      row.updatedAt = new Date(atMs);
      return created.id;
    }

    it("returns only the authenticated user's conversations", async () => {
      await seedConversation(ALICE, 1_705_000_000_001);
      await seedConversation(BOB, 1_705_000_000_002);

      const rows = await listAgentConversations(ALICE);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(ALICE);
    });

    it("orders the user's conversations newest-first (most recently updated)", async () => {
      await seedConversation(ALICE, 1_705_000_000_001);
      await seedConversation(ALICE, 1_705_000_000_003);
      await seedConversation(ALICE, 1_705_000_000_002);

      const rows = await listAgentConversations(ALICE);

      expect(rows.map((r) => r.updatedAt.getTime())).toEqual([
        1_705_000_000_003,
        1_705_000_000_002,
        1_705_000_000_001,
      ]);
    });

    it("returns a valid empty list for a user with no conversations", async () => {
      expect(await listAgentConversations(BOB)).toEqual([]);
    });

    it("exposes the conversation metadata fields deterministically", async () => {
      await seedConversation(ALICE, 1_705_000_000_001, "Invoices");

      const rows = await listAgentConversations(ALICE);

      expect(rows[0]).toMatchObject({
        title: "Invoices",
        maxToolRounds: 3,
      });
      expect(rows[0]?.createdAt).toEqual(new Date(1_705_000_000_001));
      expect(rows[0]?.updatedAt).toEqual(new Date(1_705_000_000_001));
      expect(typeof rows[0]?.id).toBe("string");
    });
  });

  describe("getAgentConversation", () => {
    async function seedWithMessages(): Promise<{ id: string; messageIds: string[] }> {
      const { id } = await persistAgentTurn({
        userId: ALICE,
        instruction: "List my files.",
        maxToolRounds: 2,
        rounds: [
          {
            text: "Looking…",
            toolCalls: [{ id: "c1", toolName: "list_directory", input: { path: "/home" } }],
            toolResults: [{ ok: true, callId: "c1", data: { items: [{ name: "notes.txt" }] } }],
          },
        ],
        finalText: "Done.",
      });
      return {
        id,
        messageIds: db.messages
          .filter((m) => m.conversationId === id)
          .map((m) => m.id as string),
      };
    }

    it("returns the owned conversation with its transcript in chronological order", async () => {
      const { id } = await seedWithMessages();

      const detail = await getAgentConversation(ALICE, id);

      expect(detail).not.toBeNull();
      expect(detail?.conversation.id).toBe(id);
      expect(detail?.conversation.userId).toBe(ALICE);
      expect(detail?.conversation.maxToolRounds).toBe(2);
      // user instruction -> provider round -> final reply
      expect(detail?.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "assistant",
      ]);
      expect(detail?.messages[0]?.content).toBe("List my files.");
      expect(detail?.messages[1]?.content).toBe("Looking…");
      expect(detail?.messages[2]?.content).toBe("Done.");
      expect(detail?.messages.map((m) => m.isFinal)).toEqual([false, false, true]);
    });

    it("preserves persisted structured tool data and exact references as stored", async () => {
      const { id } = await seedWithMessages();

      const detail = await getAgentConversation(ALICE, id);

      const round = detail?.messages[1];
      expect(round?.toolCalls).toEqual([{ id: "c1", toolName: "list_directory", input: { path: "/home" } }]);
      expect(round?.toolResults).toEqual([{ ok: true, callId: "c1", data: { items: [{ name: "notes.txt" }] } }]);
    });

    it("enforces ownership: a foreign conversation is indistinguishable from missing", async () => {
      const { id } = await seedWithMessages();

      const asForeign = await getAgentConversation(BOB, id);
      const asMissing = await getAgentConversation(BOB, "00000000-0000-0000-0000-000000000000");

      expect(asForeign).toBeNull();
      expect(asMissing).toBeNull();
    });

    it("ensures message ids are stable and rows are edge-ordered deterministically", async () => {
      const { id, messageIds } = await seedWithMessages();

      const detail = await getAgentConversation(ALICE, id);

      expect(detail?.messages.map((m) => m.id)).toEqual(messageIds);
    });
  });
});