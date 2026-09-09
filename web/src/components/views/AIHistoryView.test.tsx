import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AIHistoryView from "./AIHistoryView";
import type {
  AiConversationDetail,
  AiConversationSummary,
  AiInstructionResponse,
  AiToolApproval,
  AiTurnState,
} from "../../types/ai";

const sess = vi.hoisted(() => {
  const state: {
    user: { id: string; email: string; displayName: string; status: string } | null;
  } = { user: null };
  return {
    state,
    login: vi.fn(async () => {
      state.user = { id: "u1", email: "a@example.com", displayName: "Ada", status: "active" };
      return state.user;
    }),
    logout: vi.fn(async () => {
      state.user = null;
    }),
  };
});

vi.mock("@/services/useSession", () => ({
  useSession: () => ({
    user: sess.state.user,
    isAuthenticated: sess.state.user !== null,
    login: sess.login,
    logout: sess.logout,
  }),
}));

const api = vi.hoisted(() => ({
  listAiConversations: vi.fn(),
  getAiConversation: vi.fn(),
}));

vi.mock("@/services/api/aiConversations", () => ({
  listAiConversations: api.listAiConversations,
  getAiConversation: api.getAiConversation,
}));

const instr = vi.hoisted(() => ({
  submitAiInstruction: vi.fn(),
}));

vi.mock("@/services/api/aiInstructions", () => ({
  submitAiInstruction: instr.submitAiInstruction,
}));

const decide = vi.hoisted(() => ({
  approveAiApproval: vi.fn(),
  rejectAiApproval: vi.fn(),
}));

vi.mock("@/services/api/aiApprovals", () => ({
  approveAiApproval: decide.approveAiApproval,
  rejectAiApproval: decide.rejectAiApproval,
  RESUME_AFTER_APPROVAL_INSTRUCTION: "Continue after approval.",
}));

const ISO = "2026-09-01T10:00:00.000Z";
const RECEIPTS_INPUT = "Move receipts into a folder called Receipts.";
const RECEIPTS_REPLY = "I can move receipt.pdf into Receipts. Shall I continue?";
const MOVE_THEM = "Move the scanned PDFs into a folder called Scanned.";
const DONE_REPLY = "Moved 3 PDFs into Scanned.";

function instructionResult(conversationId: string, finalText: string): AiInstructionResponse {
  return {
    conversationId,
    turn: {
      created: true,
      instruction: "unused",
      messages: [{ kind: "final", text: finalText }],
      finalText,
      toolRounds: 0,
      maxToolRounds: 4,
      toolResults: [],
      pendingApprovals: [],
    },
  };
}

function summary(overrides: Partial<AiConversationSummary> = {}): AiConversationSummary {
  return {
    id: "conv-1",
    title: "Organize downloads",
    maxToolRounds: 4,
    createdAt: ISO,
    updatedAt: ISO,
    turnState: "completed",
    pendingApprovals: [],
    ...overrides,
  };
}

function detail(overrides: Partial<AiConversationDetail> = {}): AiConversationDetail {
  return {
    id: "conv-1",
    title: "Organize downloads",
    maxToolRounds: 4,
    createdAt: ISO,
    updatedAt: ISO,
    turnState: "completed",
    pendingApprovals: [],
    messages: [],
    ...overrides,
  };
}

function pendingApproval(overrides: Partial<AiToolApproval> = {}): AiToolApproval {
  return {
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
    ...overrides,
  };
}

function authenticatedUser() {
  sess.state.user = { id: "u1", email: "a@example.com", displayName: "Ada", status: "active" };
}

const BANNER_DETAIL: Record<AiTurnState, string> = {
  "awaiting-approval": "The assistant requested a tool action that needs a decision.",
  approved: "The requested tool action was approved.",
  rejected: "The requested tool action was rejected.",
  expired: "The approval window elapsed before a decision was made.",
  failed: "This turn ended without a completed reply.",
  completed: "DOES-NOT-EXIST",
};

describe("AIHistoryView", () => {
  const twoPane = {
    list: [summary(), summary({ id: "conv-2", title: "Clean Desktop", turnState: "rejected" })],
    detail: detail({
      turnState: "awaiting-approval",
      messages: [
        { id: "m1", role: "user", content: RECEIPTS_INPUT, createdAt: ISO, isFinal: false },
        { id: "m2", role: "assistant", content: RECEIPTS_REPLY, createdAt: ISO, isFinal: false },
      ],
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sess.state.user = null;
    api.listAiConversations.mockResolvedValue([]);
    api.getAiConversation.mockResolvedValue(detail());
    instr.submitAiInstruction.mockResolvedValue(instructionResult("conv-1", DONE_REPLY));
    decide.approveAiApproval.mockResolvedValue(pendingApproval({ status: "approved", decidedAt: ISO }));
    decide.rejectAiApproval.mockResolvedValue(pendingApproval({ status: "rejected", decidedAt: ISO }));
  });

  afterEach(cleanup);

  it("shows the sign-in state and never fetches history when unauthenticated", async () => {
    render(<AIHistoryView />);

    expect(await screen.findByText("Sign in to view your conversations")).toBeInTheDocument();
    expect(api.listAiConversations).not.toHaveBeenCalled();
    expect(api.getAiConversation).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Give the assistant an instruction")).toBeNull();
  });

  it("sign-in handoff: submitting credentials authenticates and loads real history", async () => {
    api.listAiConversations.mockResolvedValue([summary()]);
    const { rerender } = render(<AIHistoryView />);

    fireEvent.change(screen.getByPlaceholderText("Email address"), {
      target: { value: "a@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(sess.login).toHaveBeenCalledWith("a@example.com", "secret");

    rerender(<AIHistoryView />);
    expect(await screen.findByText("Organize downloads")).toBeInTheDocument();
  });

  it("renders list rows and the persisted user and assistant messages", async () => {
    authenticatedUser();
    api.listAiConversations.mockResolvedValue(twoPane.list);
    api.getAiConversation.mockResolvedValue(twoPane.detail);
    render(<AIHistoryView />);

    expect(await screen.findByText("Organize downloads")).toBeInTheDocument();
    expect(screen.getByText("Clean Desktop")).toBeInTheDocument();
    // Newest conversation is auto-selected and its detail is fetched.
    expect(api.getAiConversation).toHaveBeenCalledWith("conv-1");

    expect(await screen.findByText(RECEIPTS_INPUT)).toBeInTheDocument();
    expect(await screen.findByText(RECEIPTS_REPLY)).toBeInTheDocument();
    expect(screen.getByTestId("message-user")).toHaveTextContent(RECEIPTS_INPUT);
    expect(screen.getByTestId("message-assistant")).toHaveTextContent(RECEIPTS_REPLY);
  });

  it.each<AiTurnState>([
    "awaiting-approval",
    "approved",
    "rejected",
    "expired",
    "failed",
    "completed",
  ])("displays the %s turn state on the transcript", async (state) => {
    authenticatedUser();
    api.listAiConversations.mockResolvedValue([summary({ id: "conv-1", turnState: state })]);
    api.getAiConversation.mockResolvedValue(detail({ turnState: state }));

    render(<AIHistoryView />);

    if (state === "completed") {
      // The completed badge only exists on the transcript header (the list
      // hides completed rows), so its presence proves the detail loaded.
      expect(await screen.findByTestId("turn-state-completed")).toBeInTheDocument();
      expect(screen.queryByText(BANNER_DETAIL["awaiting-approval"])).toBeNull();
    } else {
      expect(await screen.findByText(BANNER_DETAIL[state])).toBeInTheDocument();
      expect(screen.getAllByTestId(`turn-state-${state}`).length).toBeGreaterThan(0);
    }
  });

  it("shows non-completed turn-state badges on the list rows", async () => {
    authenticatedUser();
    api.listAiConversations.mockResolvedValue([
      summary({ id: "c-await", turnState: "awaiting-approval" }),
      summary({ id: "c-done", turnState: "completed" }),
    ]);
    // Auto-selection would otherwise fetch a transcript (adding its own
    // badge); fail the detail load so only the list badges exist here.
    api.getAiConversation.mockRejectedValue(new Error("not relevant"));

    render(<AIHistoryView />);

    expect(await screen.findByTestId("turn-state-awaiting-approval")).toBeInTheDocument();
    // completed rows carry no badge in the list.
    expect(screen.queryByTestId("turn-state-completed")).toBeNull();
  });

  it("renders a pending approval card with safe metadata and approve/reject controls (never execute)", async () => {
    authenticatedUser();
    const approval = pendingApproval();
    api.listAiConversations.mockResolvedValue([
      summary({ turnState: "awaiting-approval", pendingApprovals: [approval] }),
    ]);
    api.getAiConversation.mockResolvedValue(
      detail({
        turnState: "awaiting-approval",
        pendingApprovals: [approval],
        messages: [
          { id: "m1", role: "user", content: RECEIPTS_INPUT, createdAt: ISO, isFinal: false },
          { id: "m2", role: "assistant", content: RECEIPTS_REPLY, createdAt: ISO, isFinal: false },
        ],
      }),
    );

    render(<AIHistoryView />);

    const card = await screen.findByTestId("pending-approval");
    expect(card).toHaveTextContent("move-file");
    expect(card).toHaveTextContent("fileId");
    expect(card).toHaveTextContent("receipt.pdf");
    expect(card).toHaveTextContent("Pending approval");
    expect(card).toHaveTextContent("Expires");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();

    // The frontend only submits decisions through backend endpoints — there is
    // never an execute/run affordance here.
    expect(screen.queryByRole("button", { name: /execute|run/i })).toBeNull();
  });

  it("shows the empty state when the API returns no conversations", async () => {
    authenticatedUser();
    api.listAiConversations.mockResolvedValue([]);

    render(<AIHistoryView />);

    expect(await screen.findByText("No AI conversations yet")).toBeInTheDocument();
    expect(api.getAiConversation).not.toHaveBeenCalled();
  });

  it("shows a loading state while the list request is in flight", async () => {
    authenticatedUser();
    api.listAiConversations.mockReturnValue(new Promise(() => {}));

    render(<AIHistoryView />);

    expect(await screen.findByText("Loading conversations…")).toBeInTheDocument();
  });

  it("shows a list error state with retry", async () => {
    authenticatedUser();
    api.listAiConversations.mockRejectedValue(new Error("cannot reach backend"));

    render(<AIHistoryView />);

    expect(await screen.findByText("Could not load your conversations.")).toBeInTheDocument();
    expect(screen.getByText("cannot reach backend")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("distinguishes an owned-but-missing conversation after selection", async () => {
    authenticatedUser();
    api.listAiConversations.mockResolvedValue([summary()]);
    api.getAiConversation.mockRejectedValue(new Error("Agent conversation was not found."));

    render(<AIHistoryView />);

    expect(await screen.findByText("Organize downloads")).toBeInTheDocument();
    expect(await screen.findByText("Could not load this conversation.")).toBeInTheDocument();
    expect(screen.getByText("Agent conversation was not found.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("signs out back to the sign-in state and clears the history", async () => {
    authenticatedUser();
    api.listAiConversations.mockResolvedValue([summary()]);
    const { rerender } = render(<AIHistoryView />);
    expect(await screen.findByText("Organize downloads")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(sess.logout).toHaveBeenCalled();

    rerender(<AIHistoryView />);
    expect(await screen.findByText("Sign in to view your conversations")).toBeInTheDocument();
  });

  it("submits an instruction to the selected conversation, clears the input, and reconciles from the server", async () => {
    authenticatedUser();
    const reconciled = detail({
      turnState: "completed",
      messages: [
        { id: "m1", role: "user", content: RECEIPTS_INPUT, createdAt: ISO, isFinal: false },
        { id: "m2", role: "assistant", content: RECEIPTS_REPLY, createdAt: ISO, isFinal: false },
        { id: "m3", role: "user", content: MOVE_THEM, createdAt: ISO, isFinal: false },
        { id: "m4", role: "assistant", content: DONE_REPLY, createdAt: ISO, isFinal: true },
      ],
    });
    api.listAiConversations.mockResolvedValue([summary()]);
    api.getAiConversation.mockResolvedValueOnce(twoPane.detail).mockResolvedValue(reconciled);

    render(<AIHistoryView />);
    expect(await screen.findByText(RECEIPTS_INPUT)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Give the assistant an instruction"), {
      target: { value: MOVE_THEM },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send instruction" }));

    await waitFor(() =>
      expect(instr.submitAiInstruction).toHaveBeenCalledWith({
        conversationId: "conv-1",
        instruction: MOVE_THEM,
      }),
    );
    // Reconcile: both the list and the transcript are re-fetched from the server.
    await waitFor(() => expect(api.listAiConversations).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.getAiConversation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.getAiConversation).toHaveBeenLastCalledWith("conv-1"));

    expect(await screen.findByText(DONE_REPLY)).toBeInTheDocument();
    expect(screen.getByText(MOVE_THEM)).toBeInTheDocument();
    expect(screen.getByLabelText("Give the assistant an instruction")).toHaveValue("");
  });

  it("starts a NEW conversation from the empty state (no conversationId) and selects it", async () => {
    authenticatedUser();
    api.listAiConversations
      .mockResolvedValueOnce([])
      .mockResolvedValue([summary({ id: "conv-99", turnState: "completed" })]);
    api.getAiConversation.mockResolvedValue(
      detail({
        id: "conv-99",
        turnState: "completed",
        messages: [
          { id: "m1", role: "user", content: MOVE_THEM, createdAt: ISO, isFinal: false },
          { id: "m2", role: "assistant", content: DONE_REPLY, createdAt: ISO, isFinal: true },
        ],
      }),
    );
    instr.submitAiInstruction.mockResolvedValue(instructionResult("conv-99", DONE_REPLY));

    render(<AIHistoryView />);
    expect(await screen.findByText("No AI conversations yet")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Give the assistant an instruction"), {
      target: { value: MOVE_THEM },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send instruction" }));

    await waitFor(() =>
      expect(instr.submitAiInstruction).toHaveBeenCalledWith({ instruction: MOVE_THEM }),
    );
    expect(await screen.findByText(DONE_REPLY)).toBeInTheDocument();
    expect(api.getAiConversation).toHaveBeenCalledWith("conv-99");
  });

  it("shows a working state and blocks resubmission while the turn is in flight", async () => {
    authenticatedUser();
    api.listAiConversations.mockResolvedValue([summary()]);
    api.getAiConversation.mockResolvedValue(twoPane.detail);
    instr.submitAiInstruction.mockReturnValue(new Promise(() => {}));

    render(<AIHistoryView />);
    await screen.findByText(RECEIPTS_INPUT);

    const input = screen.getByLabelText("Give the assistant an instruction");
    fireEvent.change(input, { target: { value: MOVE_THEM } });
    fireEvent.click(screen.getByRole("button", { name: "Send instruction" }));

    expect(await screen.findByText("The assistant is working on your instruction…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send instruction" })).toBeDisabled();
    expect(input).toHaveValue(MOVE_THEM);
  });

  it("surfaces submission errors, keeps the typed instruction, and reconciles the transcript", async () => {
    authenticatedUser();
    api.listAiConversations.mockResolvedValue([summary()]);
    api.getAiConversation.mockResolvedValue(twoPane.detail);
    instr.submitAiInstruction.mockRejectedValue(
      new Error("The AI provider is temporarily unavailable. Please try again later."),
    );

    render(<AIHistoryView />);
    await screen.findByText(RECEIPTS_INPUT);

    const input = screen.getByLabelText("Give the assistant an instruction");
    fireEvent.change(input, { target: { value: MOVE_THEM } });
    fireEvent.click(screen.getByRole("button", { name: "Send instruction" }));

    expect(
      await screen.findByText("The AI provider is temporarily unavailable. Please try again later."),
    ).toBeInTheDocument();
    expect(input).toHaveValue(MOVE_THEM);
    // The failed turn still reconciles the currently selected conversation.
    await waitFor(() => expect(api.getAiConversation).toHaveBeenCalledTimes(2));
  });

  it("does not submit empty or whitespace input and disables the send control", async () => {
    authenticatedUser();
    api.listAiConversations.mockResolvedValue([summary()]);
    api.getAiConversation.mockResolvedValue(twoPane.detail);

    render(<AIHistoryView />);
    await screen.findByText(RECEIPTS_INPUT);

    const input = screen.getByLabelText("Give the assistant an instruction");
    const send = screen.getByRole("button", { name: "Send instruction" });

    expect(send).toBeDisabled();
    fireEvent.change(input, { target: { value: "   " } });
    expect(send).toBeDisabled();
    fireEvent.change(input, { target: { value: MOVE_THEM } });
    expect(send).toBeEnabled();
    expect(instr.submitAiInstruction).not.toHaveBeenCalled();
  });

  it("approves a pending approval: posts the decision, resumes the approved turn, then renders the reply ONLY from the refetched conversation", async () => {
    authenticatedUser();
    const approval = pendingApproval();
    const initial = detail({
      turnState: "awaiting-approval",
      pendingApprovals: [approval],
      messages: [
        { id: "m1", role: "user", content: RECEIPTS_INPUT, createdAt: ISO, isFinal: false },
        { id: "m2", role: "assistant", content: RECEIPTS_REPLY, createdAt: ISO, isFinal: false },
      ],
    });
    const reconciled = detail({
      turnState: "completed",
      pendingApprovals: [],
      messages: [
        { id: "m1", role: "user", content: RECEIPTS_INPUT, createdAt: ISO, isFinal: false },
        { id: "m2", role: "assistant", content: RECEIPTS_REPLY, createdAt: ISO, isFinal: false },
        { id: "m3", role: "user", content: "Continue after approval.", createdAt: ISO, isFinal: false },
        { id: "m4", role: "assistant", content: DONE_REPLY, createdAt: ISO, isFinal: true },
      ],
    });
    api.listAiConversations.mockResolvedValue([
      summary({ turnState: "awaiting-approval", pendingApprovals: [approval] }),
    ]);
    api.getAiConversation.mockResolvedValueOnce(initial).mockResolvedValue(reconciled);

    render(<AIHistoryView />);
    expect(await screen.findByText(RECEIPTS_INPUT)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(decide.approveAiApproval).toHaveBeenCalledWith("ap-1"));
    // Approve resumes the approved tool through the EXISTING instruction
    // endpoint (approvalId + canonical resume instruction) — React never runs
    // the tool itself.
    await waitFor(() =>
      expect(instr.submitAiInstruction).toHaveBeenCalledWith({
        approvalId: "ap-1",
        instruction: "Continue after approval.",
      }),
    );
    // Reconcile: the transcript is re-fetched from the server, and the new
    // assistant reply renders ONLY from that authoritative projection.
    await waitFor(() => expect(api.getAiConversation).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(DONE_REPLY)).toBeInTheDocument();
    // The consumed approval is gone — no decision controls remain.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
  });

  it("rejects a pending approval: posts reject (no resume) and reconciles the rejected turn", async () => {
    authenticatedUser();
    const approval = pendingApproval();
    api.listAiConversations.mockResolvedValue([
      summary({ turnState: "awaiting-approval", pendingApprovals: [approval] }),
    ]);
    api.getAiConversation
      .mockResolvedValueOnce(
        detail({
          turnState: "awaiting-approval",
          pendingApprovals: [approval],
          messages: [
            { id: "m1", role: "user", content: RECEIPTS_INPUT, createdAt: ISO, isFinal: false },
            { id: "m2", role: "assistant", content: RECEIPTS_REPLY, createdAt: ISO, isFinal: false },
          ],
        }),
      )
      .mockResolvedValue(detail({ turnState: "rejected", pendingApprovals: [], messages: [] }));

    render(<AIHistoryView />);
    expect(await screen.findByText(RECEIPTS_INPUT)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(decide.rejectAiApproval).toHaveBeenCalledWith("ap-1"));
    expect(instr.submitAiInstruction).not.toHaveBeenCalled();
    await waitFor(() => expect(api.getAiConversation).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("The requested tool action was rejected.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
  });

  it("shows a decision loading state and blocks duplicate submission while in flight", async () => {
    authenticatedUser();
    const approval = pendingApproval();
    api.listAiConversations.mockResolvedValue([
      summary({ turnState: "awaiting-approval", pendingApprovals: [approval] }),
    ]);
    api.getAiConversation.mockResolvedValue(
      detail({
        turnState: "awaiting-approval",
        pendingApprovals: [approval],
        messages: [
          { id: "m1", role: "user", content: RECEIPTS_INPUT, createdAt: ISO, isFinal: false },
          { id: "m2", role: "assistant", content: RECEIPTS_REPLY, createdAt: ISO, isFinal: false },
        ],
      }),
    );
    decide.approveAiApproval.mockReturnValue(new Promise(() => {}));

    render(<AIHistoryView />);
    expect(await screen.findByText(RECEIPTS_INPUT)).toBeInTheDocument();

    const approve = screen.getByRole("button", { name: "Approve" });
    const reject = screen.getByRole("button", { name: "Reject" });
    fireEvent.click(approve);

    await waitFor(() => expect(decide.approveAiApproval).toHaveBeenCalledTimes(1));
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();
    // A second click while in flight cannot double-submit.
    fireEvent.click(approve);
    await waitFor(() => expect(decide.approveAiApproval).toHaveBeenCalledTimes(1));
  });

  it("surfaces a backend decision error (e.g. expired) and reconciles the server-derived state without fabricating a reply", async () => {
    authenticatedUser();
    const approval = pendingApproval();
    api.listAiConversations.mockResolvedValue([
      summary({ turnState: "awaiting-approval", pendingApprovals: [approval] }),
    ]);
    api.getAiConversation
      .mockResolvedValueOnce(
        detail({
          turnState: "awaiting-approval",
          pendingApprovals: [approval],
          messages: [
            { id: "m1", role: "user", content: RECEIPTS_INPUT, createdAt: ISO, isFinal: false },
            { id: "m2", role: "assistant", content: RECEIPTS_REPLY, createdAt: ISO, isFinal: false },
          ],
        }),
      )
      .mockResolvedValue(detail({ turnState: "expired", pendingApprovals: [], messages: [] }));
    decide.approveAiApproval.mockRejectedValue(
      new Error("This tool approval has expired and cannot be decided."),
    );

    render(<AIHistoryView />);
    expect(await screen.findByText(RECEIPTS_INPUT)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    // A stale/expired decision fails on the backend and NEVER resumes a turn —
    // the view then reconciles the server-derived state (2nd fetch) instead of
    // fabricating a reply or a status.
    await waitFor(() => expect(api.getAiConversation).toHaveBeenCalledTimes(2));
    expect(instr.submitAiInstruction).not.toHaveBeenCalled();
    expect(await screen.findByText("The approval window elapsed before a decision was made.")).toBeInTheDocument();
    expect(screen.queryByText(DONE_REPLY)).toBeNull();
  });
});