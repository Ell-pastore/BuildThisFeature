import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ApprovalCard from "./ApprovalCard";
import type { AiToolApproval } from "../../types/ai";

const api = vi.hoisted(() => ({
  approveAiApproval: vi.fn(),
  rejectAiApproval: vi.fn(),
  submitAiInstruction: vi.fn(),
}));

vi.mock("@/services/api/aiApprovals", () => ({
  approveAiApproval: api.approveAiApproval,
  rejectAiApproval: api.rejectAiApproval,
  RESUME_AFTER_APPROVAL_INSTRUCTION: "Continue after approval.",
}));

vi.mock("@/services/api/aiInstructions", () => ({
  submitAiInstruction: api.submitAiInstruction,
}));

const ISO = "2026-09-01T10:00:00.000Z";

function approval(overrides: Partial<AiToolApproval> = {}): AiToolApproval {
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

describe("ApprovalCard", () => {
  const onReconcile = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    api.approveAiApproval.mockResolvedValue(approval({ status: "approved", decidedAt: ISO }));
    api.rejectAiApproval.mockResolvedValue(approval({ status: "rejected", decidedAt: ISO }));
    api.submitAiInstruction.mockResolvedValue({
      conversationId: "conv-1",
      turn: {
        created: false,
        instruction: "Continue after approval.",
        messages: [],
        toolRounds: 0,
        maxToolRounds: 4,
        toolResults: [],
        pendingApprovals: [],
      },
    });
  });

  afterEach(cleanup);

  it("exposes Approve/Reject controls only when the approval is server-side pending", () => {
    render(<ApprovalCard approval={approval()} onReconcile={onReconcile} />);

    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.getByText("Pending approval")).toBeInTheDocument();
  });

  it("hides decision controls for a non-pending approval and shows its server status", () => {
    render(
      <ApprovalCard approval={approval({ status: "expired", decidedAt: ISO })} onReconcile={onReconcile} />,
    );

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByText("Status: expired")).toBeInTheDocument();
  });

  it("approve posts the decision, resumes through the instruction endpoint, then reconciles", async () => {
    render(<ApprovalCard approval={approval()} onReconcile={onReconcile} />);

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(api.approveAiApproval).toHaveBeenCalledWith("ap-1"));
    // React never executes the tool — the approved operation resumes through
    // the backend agent endpoint with the approval id + canonical instruction.
    await waitFor(() =>
      expect(api.submitAiInstruction).toHaveBeenCalledWith({
        approvalId: "ap-1",
        instruction: "Continue after approval.",
      }),
    );
    await waitFor(() => expect(onReconcile).toHaveBeenCalledWith("conv-1"));
  });

  it("reject posts the decision but never resumes, then reconciles", async () => {
    render(<ApprovalCard approval={approval()} onReconcile={onReconcile} />);

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(api.rejectAiApproval).toHaveBeenCalledWith("ap-1"));
    expect(api.submitAiInstruction).not.toHaveBeenCalled();
    await waitFor(() => expect(onReconcile).toHaveBeenCalledWith("conv-1"));
  });

  it("disables both decision controls while a decision is in flight (no duplicate submission)", async () => {
    api.approveAiApproval.mockReturnValue(new Promise(() => {}));
    render(<ApprovalCard approval={approval()} onReconcile={onReconcile} />);

    const approve = screen.getByRole("button", { name: "Approve" });
    const reject = screen.getByRole("button", { name: "Reject" });
    fireEvent.click(approve);

    await waitFor(() => expect(api.approveAiApproval).toHaveBeenCalledTimes(1));
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();

    fireEvent.click(approve);
    await waitFor(() => expect(api.approveAiApproval).toHaveBeenCalledTimes(1));
  });

  it("surfaces a backend decision error (stale/expired) and still reconciles without fabricating state", async () => {
    api.approveAiApproval.mockRejectedValue(
      new Error("This tool approval has expired and cannot be decided."),
    );
    render(<ApprovalCard approval={approval()} onReconcile={onReconcile} />);

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This tool approval has expired and cannot be decided.",
    );
    await waitFor(() => expect(onReconcile).toHaveBeenCalledWith("conv-1"));
    // The expired decision never resumed an agent turn.
    expect(api.submitAiInstruction).not.toHaveBeenCalled();
  });

  it("offers no direct tool execution affordance", () => {
    render(<ApprovalCard approval={approval()} onReconcile={onReconcile} />);

    expect(screen.queryByRole("button", { name: /execute|run/i })).toBeNull();
  });
});