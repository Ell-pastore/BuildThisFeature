import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AIAssistant from "./AIAssistant";
import type { AiConversationSummary } from "../types/ai";

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

describe("AIAssistant side panel", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    sess.state.user = null;
    onClose.mockReset();
    api.listAiConversations.mockResolvedValue([summary()]);
    api.getAiConversation.mockResolvedValue({
      id: "conv-1",
      title: "Organize downloads",
      maxToolRounds: 4,
      createdAt: ISO,
      updatedAt: ISO,
      turnState: "completed",
      pendingApprovals: [],
      messages: [
        { id: "m1", role: "user", content: "Find my PDFs.", createdAt: ISO, isFinal: false },
        { id: "m2", role: "assistant", content: "Here are your PDFs.", createdAt: ISO, isFinal: true },
      ],
    });
  });

  afterEach(cleanup);

  it("requires a session before showing any history", async () => {
    render(<AIAssistant onClose={onClose} />);

    expect(await screen.findByText("Sign in to view your conversations")).toBeInTheDocument();
    expect(api.listAiConversations).not.toHaveBeenCalled();
  });

  it("replaces the fabricated chat placeholder with real history and has no composer", async () => {
    sess.state.user = { id: "u1", email: "a@example.com", displayName: "Ada", status: "active" };
    render(<AIAssistant onClose={onClose} />);

    expect(await screen.findByText("Organize downloads")).toBeInTheDocument();

    // The canned placeholder chat (quick prompts, composer, send button) is gone.
    expect(screen.queryByPlaceholderText(/ask anything/i)).toBeNull();
    expect(screen.queryByText("Organize my files")).toBeNull();
    expect(screen.queryByText("Find duplicates")).toBeNull();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
    expect(screen.queryByText(/AI backend isn't connected/i)).toBeNull();
  });

  it("opens a conversation to render its real persisted transcript and can go back", async () => {
    sess.state.user = { id: "u1", email: "a@example.com", displayName: "Ada", status: "active" };
    render(<AIAssistant onClose={onClose} />);

    fireEvent.click(await screen.findByText("Organize downloads"));
    expect(api.getAiConversation).toHaveBeenCalledWith("conv-1");

    expect(await screen.findByText("Find my PDFs.")).toBeInTheDocument();
    expect(screen.getByText("Here are your PDFs.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /back to conversation list/i }));
    expect(await screen.findByText("Organize downloads")).toBeInTheDocument();
  });

  it("still closes via the header close button", async () => {
    sess.state.user = { id: "u1", email: "a@example.com", displayName: "Ada", status: "active" };
    render(<AIAssistant onClose={onClose} />);

    await screen.findByText("Organize downloads");
    fireEvent.click(screen.getByRole("button", { name: /close assistant/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});