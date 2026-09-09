import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AIHistoryView from "./AIHistoryView";
import type { AiConversationDetail, AiConversationSummary, AiToolApproval, AiTurnState } from "../../types/ai";

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

const ISO = "2026-09-01T10:00:00.000Z";
const RECEIPTS_INPUT = "Move receipts into a folder called Receipts.";
const RECEIPTS_REPLY = "I can move receipt.pdf into Receipts. Shall I continue?";

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
  });

  afterEach(cleanup);

  it("shows the sign-in state and never fetches history when unauthenticated", async () => {
    render(<AIHistoryView />);

    expect(await screen.findByText("Sign in to view your conversations")).toBeInTheDocument();
    expect(api.listAiConversations).not.toHaveBeenCalled();
    expect(api.getAiConversation).not.toHaveBeenCalled();
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

  it("renders a pending approval card with safe metadata and NO action controls", async () => {
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
    expect(card).toHaveTextContent("Read-only: approval actions are not available in this view yet.");

    // This foundation phase has no approve/reject/execute affordances at all.
    expect(screen.queryByRole("button", { name: /approve|reject|execute|run/i })).toBeNull();
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
});