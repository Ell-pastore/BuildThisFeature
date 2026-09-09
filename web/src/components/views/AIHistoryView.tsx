import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, LogOut, RefreshCw, Sparkles } from "../Icons";
import { useSession } from "../../services/useSession";
import {
  getAiConversation,
  listAiConversations,
} from "../../services/api/aiConversations";
import type { AiConversationDetail, AiConversationSummary } from "../../types/ai";
import ConversationList from "../conversations/ConversationList";
import ConversationTranscript from "../conversations/ConversationTranscript";
import SignInPanel from "../conversations/SignInPanel";

/**
 * Desktop AI conversation view (Phase 10.32) — read-only history of the
 * signed-in user's real, persisted conversations, loaded from the existing
 * authenticated backend API.
 *
 * Auth state comes from the centralized in-memory session store; the bearer
 * token never enters component state or the URL. Ownership, turn-state
 * derivation, and approvals stay authoritative on the backend — this view only
 * renders what the API returns, executes nothing, and offers no
 * approve/reject actions.
 */
export default function AIHistoryView() {
  const { user, isAuthenticated, logout } = useSession();
  const [conversations, setConversations] = useState<readonly AiConversationSummary[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AiConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    if (!isAuthenticated) return;
    setListLoading(true);
    setListError(null);
    try {
      const items = await listAiConversations();
      setConversations(items);
      setSelectedId((current) => {
        if (current !== null && items.some((c) => c.id === current)) return current;
        return items.length > 0 ? (items[0]?.id ?? null) : null;
      });
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Could not load conversations.");
    } finally {
      setListLoading(false);
    }
  }, [isAuthenticated]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      setDetail(await getAiConversation(id));
    } catch (err) {
      setDetail(null);
      setDetailError(err instanceof Error ? err.message : "Could not load this conversation.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setConversations(null);
      setSelectedId(null);
      setDetail(null);
      setListError(null);
      setDetailError(null);
      return;
    }
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  if (!isAuthenticated) return <SignInPanel />;

  const displayName = user?.displayName ?? user?.email ?? "";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-6 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-md bg-ai-bg flex items-center justify-center flex-shrink-0">
            <Sparkles size={12} className="text-ai-text" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-foreground leading-tight" style={{ fontFamily: "Instrument Sans, sans-serif" }}>
              Conversations
            </h1>
            <p className="text-[11px] text-muted-foreground truncate">{displayName}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void loadList()}
            aria-label="Refresh conversations"
            title="Refresh conversations"
            className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary transition-colors"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            aria-label="Sign out"
            title="Sign out"
            className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary transition-colors"
          >
            <LogOut size={14} />
          </button>
        </div>
      </header>

      {listLoading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          Loading conversations…
        </div>
      ) : listError !== null ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
          <AlertTriangle size={20} className="text-rose-500 mb-2" />
          <p className="text-sm font-medium text-foreground">Could not load your conversations.</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">{listError}</p>
          <button
            type="button"
            onClick={() => void loadList()}
            className="mt-3 text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:bg-indigo-600 transition-colors"
          >
            Try again
          </button>
        </div>
      ) : conversations === null || conversations.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
          <div className="w-12 h-12 rounded-2xl bg-ai-bg flex items-center justify-center mb-3">
            <Sparkles size={18} className="text-ai-text" />
          </div>
          <p className="text-sm font-medium text-foreground">No AI conversations yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Your conversation history will appear here once you ask the assistant to work on
            your files.
          </p>
          <button
            type="button"
            onClick={() => void loadList()}
            className="mt-3 text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:bg-indigo-600 transition-colors"
          >
            Refresh
          </button>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden min-h-0">
          <aside className="w-72 lg:w-80 flex-shrink-0 border-r border-border flex flex-col min-h-0">
            <ConversationList
              conversations={conversations}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </aside>
          <main className="flex-1 min-w-0 flex flex-col">
            <ConversationTranscript
              conversation={detail}
              loading={detailLoading}
              error={detailError}
              onRetry={() => selectedId !== null && void loadDetail(selectedId)}
            />
          </main>
        </div>
      )}
    </div>
  );
}