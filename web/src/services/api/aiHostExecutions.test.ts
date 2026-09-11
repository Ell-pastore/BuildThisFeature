import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesystemProvider } from "../filesystem";
import type {
  AiInstructionHostExecution,
  AiInstructionResponse,
} from "../../types/ai";

const provider = vi.hoisted(() => ({
  homeDirectory: vi.fn(),
  listDirectory: vi.fn(),
  createFolder: vi.fn(),
  createFile: vi.fn(),
  renameItem: vi.fn(),
  moveItem: vi.fn(),
  deleteItem: vi.fn(),
  openItem: vi.fn(),
  getFileMetadata: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  copyItem: vi.fn(),
  diskUsage: vi.fn(),
  searchFiles: vi.fn(),
  trashItem: vi.fn(),
  restoreItem: vi.fn(),
  duplicateItem: vi.fn(),
}));

const filesystem = vi.hoisted(() => ({
  getFilesystemProvider: vi.fn(),
}));

vi.mock("../filesystem", () => ({
  getFilesystemProvider: filesystem.getFilesystemProvider,
}));

const submit = vi.hoisted(() => ({
  submitAiInstruction: vi.fn(),
}));

vi.mock("./aiInstructions", () => ({
  submitAiInstruction: submit.submitAiInstruction,
}));

const desktopEnv = vi.hoisted(() => ({
  isTauriEnv: vi.fn(),
}));

vi.mock("../desktopEnv", () => ({
  isTauriEnv: desktopEnv.isTauriEnv,
}));

import {
  buildHostExecutionSubmission,
  driveHostExecutions,
  RESUME_AFTER_HOST_EXECUTION,
} from "./aiHostExecutions";

const ISO = "2026-09-01T10:00:00.000Z";

function execution(
  overrides: Partial<AiInstructionHostExecution> = {},
): AiInstructionHostExecution {
  return {
    executionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    toolName: "list_directory",
    arguments: { path: "/home" },
    expiresAt: ISO,
    ...overrides,
  };
}

function turn(partial: Partial<AiInstructionResponse["turn"]> = {}): AiInstructionResponse {
  return {
    conversationId: "conv-1",
    turn: {
      created: false,
      instruction: "unused",
      messages: [],
      toolRounds: 0,
      maxToolRounds: 3,
      toolResults: [],
      pendingApprovals: [],
      pendingExecutions: [],
      ...partial,
    },
  };
}

function listing() {
  return {
    path: "/home",
    parentPath: null,
    isHome: true,
    items: [
      { name: "Documents", type: "directory", isFolder: true },
      { name: "notes.txt", type: "file", isFolder: false },
    ],
  };
}

describe("host-execution driver (Phase 10.39)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    filesystem.getFilesystemProvider.mockReturnValue(provider as unknown as FilesystemProvider);
    provider.readFile.mockResolvedValue(new Uint8Array([104, 105]));
    submit.submitAiInstruction.mockResolvedValue(turn());
  });

  it("runs NOTHING and returns null outside the Tauri desktop webview", async () => {
    desktopEnv.isTauriEnv.mockReturnValue(false);
    const result = await driveHostExecutions([execution()], "conv-1");

    expect(result).toBeNull();
    expect(provider.listDirectory).not.toHaveBeenCalled();
    expect(submit.submitAiInstruction).not.toHaveBeenCalled();
  });

  it("returns null for an empty execution set", async () => {
    desktopEnv.isTauriEnv.mockReturnValue(true);
    expect(await driveHostExecutions([], "conv-1")).toBeNull();
    expect(submit.submitAiInstruction).not.toHaveBeenCalled();
  });

  it("executes a list_directory via the local provider and resumes the SAME conversation", async () => {
    desktopEnv.isTauriEnv.mockReturnValue(true);
    const listingResult = listing();
    provider.listDirectory.mockResolvedValue(listingResult);
    const final = turn({ finalText: "Here is your Desktop.", messages: [{ kind: "final", text: "Here is your Desktop." }] });
    submit.submitAiInstruction.mockResolvedValue(final);

    const result = await driveHostExecutions([execution()], "conv-1");

    // The operation ran through the app's own filesystem provider.
    expect(provider.listDirectory).toHaveBeenCalledWith("/home");
    // The resume used the canonical instruction + strict submission.
    expect(submit.submitAiInstruction).toHaveBeenCalledWith({
      conversationId: "conv-1",
      instruction: RESUME_AFTER_HOST_EXECUTION,
      resumeExecutions: [
        {
          executionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          ok: true,
          result: listingResult,
        },
      ],
    });
    expect(result).toEqual(final);
  });

  it("returns read_file content in the backend's base64 envelope", async () => {
    desktopEnv.isTauriEnv.mockReturnValue(true);
    const submission = await buildHostExecutionSubmission(
      execution({ toolName: "read_file", arguments: { path: "/home/photo.png" } }),
    );

    expect(submission).toEqual({
      executionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ok: true,
      result: { encoding: "base64", data: "aGk=" },
    });
  });

  it("submits a categorized failure when the local operation cannot be executed", async () => {
    desktopEnv.isTauriEnv.mockReturnValue(true);
    provider.listDirectory.mockRejectedValue(new Error("permission denied"));

    const submission = await buildHostExecutionSubmission(execution());

    expect(submission).toEqual({
      executionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ok: false,
      error: { code: "tools/host-execution-failed", category: "tools" },
    });
  });

  it("submits a failure for invalid arguments (nothing executed)", async () => {
    desktopEnv.isTauriEnv.mockReturnValue(true);
    const submission = await buildHostExecutionSubmission(
      execution({ arguments: { path: 42 } }),
    );

    expect(provider.listDirectory).not.toHaveBeenCalled();
    expect(submission).toEqual({
      executionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ok: false,
      error: { code: "tools/host-execution-failed", category: "tools" },
    });
  });

  it("loops a bounded number of times while the turn pauses again, then surfaces the last response", async () => {
    desktopEnv.isTauriEnv.mockReturnValue(true);
    provider.listDirectory.mockResolvedValue(listing());
    let pausedCount = 0;
    submit.submitAiInstruction.mockImplementation(() => {
      pausedCount += 1;
      return Promise.resolve(
        pausedCount <= 10
          ? turn({
              pendingExecutions: [
                execution({
                  executionId: `${pausedCount}`.padStart(16, "0"),
                  toolName: "search_files",
                  arguments: { query: "notes" },
                }),
              ],
            })
          : turn({ finalText: "done" }),
      );
    });

    const final = await driveHostExecutions([execution()], "conv-1");

    // Fresh pause → another local execution + resume; each resume attempt is a
    // separate submission (the backend seals each execution once). The first
    // iteration ran list_directory, then 9 more iterations ran search_files.
    expect(provider.listDirectory).toHaveBeenCalledTimes(1);
    expect(provider.searchFiles).toHaveBeenCalledTimes(9);
    expect(submit.submitAiInstruction).toHaveBeenCalledTimes(10);
    // Bounded stop: the LAST paused response is surfaced, never a fabricated
    // terminal state.
    expect(final?.turn.toolRounds).toBe(0);
    expect(final?.turn.finalText).toBeUndefined();
  });
});