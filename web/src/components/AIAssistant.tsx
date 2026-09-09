import { useEffect, useState } from "react";
import { ChevronLeft, Sparkles, X } from "./Icons";
import { useSession } from "../services/useSession";
import { getAiConversation, listAiConversations } from "../services/api/aiConversations";
import type { AiConversationDetail, AiConversationSummary } from "../types/ai";
import ConversationList from "./conversations/ConversationList";
import ConversationTranscript from "./conversations/ConversationTranscript";
import SignInPanel from "./conversations/SignInPanel";

interface AIAssistantProps {
  onClose: () => void;
}

/**
 * Smart Assistant side panel (Phase 10.32) — now reads the SAME real,
 * persisted conversation history as the main Conversations view, through the
 * same authenticated API and session store. The previous placeholder chat
 * (canned messages, quick prompts, and a composer that fabricated replies) is
 * gone: this panel is read-only and executes nothing.
 */
export default function AIAssistant({ onClose }: AIAssistantProps) {
  const { isAuthenticated } = useSession();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<readonly AiConversationSummary[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AiConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  function loadList() {
    setListLoading(true);
    setListError(null);
    listAiConversations()
      .then((items) => setConversations(items))
      .catch((err: unknown) => setListError(err instanceof Error ? err.message : "Could not load conversations."))
      .finally(() => setListLoading(false));
  }

  function openConversation(id: string) {
    setDetailLoading(true);
    setDetailError(null);
    setSelectedId(id);
    getAiConversation(id)
      .then(setDetail)
      .catch((err: unknown) => {
        setDetail(null);
        setDetailError(err instanceof Error ? err.message : "Could not load this conversation.");
      })
      .finally(() => setDetailLoading(false));
  }

  /** Reconcile after an approval decision: reload the list + the owning detail. */
  async function reconcileConversation(conversationId: string) {
    loadList();
    await openConversation(conversationId);
  }

  useEffect(() => {
    if (!isAuthenticated) {
      setConversations(null);
      setSelectedId(null);
      setDetail(null);
      setListError(null);
      setDetailError(null);
      return;
    }
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  return (
    <div className="h-full flex flex-col bg-card border-l border-border w-96 flex-shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          {selectedId !== null && (
            <button
              type="button"
              onClick={() => {
                setSelectedId(null);
                setDetail(null);
                setDetailError(null);
              }}
              aria-label="Back to conversation list"
              className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary transition-colors flex-shrink-0"
            >
              <ChevronLeft size={14} />
            </button>
          )}
          <div className="w-6 h-6 rounded-md bg-ai-bg flex items-center justify-center flex-shrink-0">
            <Sparkles size={12} className="text-ai-text" />
          </div>
          <span className="text-sm font-semibold truncate" style={{ fontFamily: "Instrument Sans, sans-serif" }}>
            {selectedId !== null ? "Conversation history" : "Smart Assistant"}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close assistant"
          className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary transition-colors"
        >
          <X size={15} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {!isAuthenticated ? (
          <SignInPanel />
        ) : listLoading ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            Loading conversations…
          </div>
        ) : listError !== null ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4">
            <p className="text-xs text-muted-foreground">{listError}</p>
            <button
              type="button"
              onClick={loadList}
              className="mt-3 text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:bg-indigo-600 transition-colors"
            >
              Try again
            </button>
          </div>
        ) : selectedId === null ? (
          conversations === null || conversations.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-1">
              <Sparkles size={16} className="text-ai-text" />
              <p className="text-sm font-medium text-foreground">No conversations yet</p>
              <p className="text-xs text-muted-foreground">Your history will appear here.</p>
              <button
                type="button"
                onClick={loadList}
                className="mt-2 text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:bg-indigo-600 transition-colors"
              >
                Refresh
              </button>
            </div>
          ) : (
            <div className="h-full overflow-y-auto">
              <ConversationList conversations={conversations} selectedId={null} onSelect={openConversation} />
            </div>
          )
        ) : (
          <div className="h-full overflow-y-auto">
            <ConversationTranscript
              conversation={detail}
              loading={detailLoading}
              error={detailError}
              onRetry={() => selectedId !== null && openConversation(selectedId)}
              onReconcile={reconcileConversation}
            />
          </div>
        )}
      </div>
    </div>
  );
}