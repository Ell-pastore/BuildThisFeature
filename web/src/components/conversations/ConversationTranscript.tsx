import { AlertTriangle, Sparkles, Bot } from "../Icons";
import type { AiConversationDetail, AiHistoryMessage, AiToolApproval, AiTurnState } from "../../types/ai";
import ApprovalCard from "./ApprovalCard";
import TurnStateBadge from "./TurnStateBadge";

interface ConversationTranscriptProps {
  conversation: AiConversationDetail | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Reconcile a conversation after an approval decision (reload from server). */
  onReconcile: (conversationId: string) => Promise<void>;
}

const BANNERS: Partial<Record<AiTurnState, { title: string; detail: string }>> = {
  "awaiting-approval": {
    title: "Awaiting your approval",
    detail: "The assistant requested a tool action that needs a decision.",
  },
  approved: {
    title: "Approved",
    detail: "The requested tool action was approved.",
  },
  rejected: {
    title: "Rejected",
    detail: "The requested tool action was rejected.",
  },
  expired: {
    title: "Expired",
    detail: "The approval window elapsed before a decision was made.",
  },
  failed: {
    title: "Failed",
    detail: "This turn ended without a completed reply.",
  },
};

function ToolMetadata({ message }: { message: AiHistoryMessage }) {
  const calls = message.toolCalls ?? [];
  const results = message.toolResults ?? [];
  if (calls.length === 0 && results.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1">
      {calls.map((call) => (
        <p key={call.callId} className="text-[11px] text-muted-foreground">
          Tool: {call.toolName}
        </p>
      ))}
      {results.map((result) => (
        <p
          key={result.callId}
          className={`text-[11px] ${result.ok ? "text-muted-foreground" : "text-rose-500"}`}
        >
          {result.ok ? "Tool result: ok" : `Tool result: failed (${result.error.code})`}
        </p>
      ))}
    </div>
  );
}

function MessageRow({
  message,
  approvals,
  onReconcile,
}: {
  message: AiHistoryMessage;
  approvals: readonly AiToolApproval[];
  onReconcile: (conversationId: string) => Promise<void>;
}) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="w-6 h-6 rounded-full bg-ai-bg flex items-center justify-center flex-shrink-0 mr-2 mt-0.5">
          <Sparkles size={11} className="text-ai-text" />
        </div>
      )}
      <div
        data-testid={`message-${isUser ? "user" : "assistant"}`}
        data-message-id={message.id}
        className={`max-w-[85%] ${
          isUser
            ? "bg-foreground text-primary-foreground"
            : "bg-secondary text-foreground"
        } rounded-xl px-3.5 py-2.5 text-sm leading-relaxed`}
      >
        <p className="whitespace-pre-line">{message.content}</p>
        <ToolMetadata message={message} />
        {approvals.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} onReconcile={onReconcile} />
        ))}
      </div>
    </div>
  );
}

/**
 * Transcript of one persisted conversation: its server-derived turn state, its
 * chronological messages, and (when the backend reports them) the still-
 * decidable approvals rendered as cards. Nothing here executes tools — approval
 * decisions are submitted through the existing backend endpoints and the
 * conversation is re-fetched so the newest reply/turn state render only from
 * the authoritative projection.
 */
export default function ConversationTranscript({
  conversation,
  loading,
  error,
  onRetry,
  onReconcile,
}: ConversationTranscriptProps) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Loading conversation…
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <AlertTriangle size={20} className="text-rose-500 mb-2" />
        <p className="text-sm font-medium text-foreground">Could not load this conversation.</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:bg-indigo-600 transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  if (conversation === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground px-6 text-center">
        Select a conversation to read its history.
      </div>
    );
  }

  const banner = BANNERS[conversation.turnState];
  const messageIds = new Set(conversation.messages.map((m) => m.id));
  const approvalByMessage = new Map<string, AiToolApproval[]>();
  const strayApprovals: AiToolApproval[] = [];
  for (const approval of conversation.pendingApprovals) {
    if (messageIds.has(approval.messageId)) {
      const list = approvalByMessage.get(approval.messageId) ?? [];
      list.push(approval);
      approvalByMessage.set(approval.messageId, list);
    } else {
      strayApprovals.push(approval);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-6">
        <header className="mb-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Bot size={15} className="text-ai-text flex-shrink-0" />
              <h2 className="text-base font-semibold text-foreground truncate" style={{ fontFamily: "Instrument Sans, sans-serif" }}>
                {conversation.title?.trim() ? conversation.title : "Untitled conversation"}
              </h2>
            </div>
            <TurnStateBadge state={conversation.turnState} />
          </div>
          {banner !== undefined && (
            <div className="mt-3 rounded-xl bg-secondary px-3.5 py-2.5">
              <p className="text-sm font-medium text-foreground">{banner.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{banner.detail}</p>
            </div>
          )}
        </header>

        <div className="space-y-4">
          {conversation.messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              approvals={approvalByMessage.get(message.id) ?? []}
              onReconcile={onReconcile}
            />
          ))}
        </div>

        {strayApprovals.length > 0 && (
          <div className="mt-5">
            <p className="text-xs font-medium text-muted-foreground mb-1">Pending approvals</p>
            {strayApprovals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} onReconcile={onReconcile} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}