import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, LogOut, RefreshCw, Sparkles } from "../Icons";
import { useSession } from "../../services/useSession";
import {
  getAiConversation,
  listAiConversations,
} from "../../services/api/aiConversations";
import { submitAiInstruction } from "../../services/api/aiInstructions";
import {
  driveHostExecutions,
  type HostExecutionRequest,
} from "../../services/api/aiHostExecutions";
import { getAiRuntimeStatus } from "../../services/api/aiStatus";
import { ApiClientError } from "../../services/api/client";
import type {
  AiConversationDetail,
  AiConversationSummary,
  AiRuntimeStatus,
} from "../../types/ai";
import AIComposer from "../conversations/AIComposer";
import AIUnconfiguredNotice from "../conversations/AIUnconfiguredNotice";
import ConversationList from "../conversations/ConversationList";
import ConversationTranscript from "../conversations/ConversationTranscript";
import SignInPanel from "../conversations/SignInPanel";

/**
 * Desktop AI conversation view (Phase 10.33) — the signed-in user's real,
 * persisted conversations loaded from the authenticated backend API, plus a
 * composer that submits REAL instructions through `POST /api/ai/instructions`.
 *
 * Auth state comes from the centralized in-memory session store; the bearer
 * token never enters component state or the URL. After each submission the view
 * reconciles both the list and the selected transcript from the server, so the
 * rendered messages, `turnState`, and `pendingApprovals` are always the
 * backend's persisted, server-derived values — nothing is fabricated or
 * inferred client-side. No tool is ever executed here and no approval actions
 * are offered.
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
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<AiRuntimeStatus | null>(null);
  const [notConfiguredOverride, setNotConfiguredOverride] = useState(false);
  const [pendingInstruction, setPendingInstruction] = useState<string | null>(null);
  /** Guards against concurrent host-execution drives (submit path + reload path). */
  const drivingRef = useRef(false);

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

  /**
   * Execute the given host executions locally (Tauri desktop only) and resume
   * the paused turn. Never re-enters: a concurrent call is skipped.
   */
  const drivePendingExecutions = useCallback(
    async (executions: readonly HostExecutionRequest[], conversationId: string) => {
      if (executions.length === 0 || drivingRef.current) return;
      drivingRef.current = true;
      try {
        await driveHostExecutions(executions, conversationId);
      } finally {
        drivingRef.current = false;
      }
    },
    [],
  );

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      setDetailError(null);
      try {
        const loaded = await getAiConversation(id);
        setDetail(loaded);
        // Phase 10.39 recovery: a conversation that was loaded into an
        // "awaiting-host-execution" pause (e.g. after a reload mid-flight) is
        // driven to completion by the desktop host when one is present. The
        // ref guard prevents a concurrent drive with the submit path; in a
        // plain browser `driveHostExecutions` returns null immediately.
        if (
          loaded.turnState === "awaiting-host-execution" &&
          loaded.pendingHostExecutions.length > 0 &&
          !drivingRef.current
        ) {
          await drivePendingExecutions(
            loaded.pendingHostExecutions.map((execution) => ({
              executionId: execution.id,
              toolName: execution.toolName,
              arguments: execution.arguments,
            })),
            id,
          );
          setDetail(await getAiConversation(id));
        }
      } catch (err) {
        setDetail(null);
        setDetailError(err instanceof Error ? err.message : "Could not load this conversation.");
      } finally {
        setDetailLoading(false);
      }
    },
    [drivePendingExecutions],
  );

  /**
   * Fetch the safe runtime status. A failure (backend down, session vanished)
   * leaves `aiStatus` null so the "not configured" notice is only ever driven
   * by a SUCCESSFUL, safe status response — never by an outage.
   */
  const loadStatus = useCallback(async () => {
    try {
      setAiStatus(await getAiRuntimeStatus());
    } catch {
      setAiStatus(null);
    }
  }, []);

  /** Reconcile after an approval decision: reload the list + selected transcript. */
  const reconcileConversation = useCallback(
    async (conversationId: string) => {
      await loadList();
      await loadDetail(conversationId);
    },
    [loadList, loadDetail],
  );

  const handleSubmit = useCallback(
    async (instruction: string): Promise<boolean> => {
      if (!isAuthenticated) return false;
      setSubmitting(true);
      setSubmitError(null);
      try {
        const response = await submitAiInstruction({
          ...(selectedId !== null ? { conversationId: selectedId } : {}),
          instruction,
        });
        const targetId = response.conversationId;
        const resumedSame = selectedId === targetId;
        setSelectedId(targetId);
        // Phase 10.39: the turn paused at a filesystem operation the backend
        // asked the DESKTOP HOST to run. Execute each request locally and
        // resume the SAME bounded turn before reconciling, so the transcript
        // renders the completed turn (or a clean next pause).
        if (response.turn.pendingExecutions.length > 0) {
          await drivePendingExecutions(response.turn.pendingExecutions, targetId);
        }
        await loadList();
        if (resumedSame) await loadDetail(targetId);
        return true;
      } catch (err) {
        if (err instanceof ApiClientError && err.code === "common/not-configured") {
          // The backend's stable "not configured" signal maps to the clear
          // configuration state, not a raw error string.
          setSubmitError(null);
          setNotConfiguredOverride(true);
          setPendingInstruction(instruction);
        } else {
          setSubmitError(err instanceof Error ? err.message : "Could not submit your instruction.");
        }
        // A failed turn may still have persisted partial state — reconcile the
        // currently selected transcript from the server.
        if (selectedId !== null) void loadDetail(selectedId);
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [isAuthenticated, selectedId, loadList, loadDetail, drivePendingExecutions],
  );

  /**
   * Retry after the "AI isn't configured" state: re-check the status and, when
   * an instruction previously failed with `common/not-configured`, re-run it.
   * If the provider still is not configured, the next submit failure keeps the
   * notice visible.
   */
  const retryUnconfigured = useCallback(() => {
    setNotConfiguredOverride(false);
    void loadStatus();
    const pending = pendingInstruction;
    if (pending !== null) {
      setPendingInstruction(null);
      void handleSubmit(pending);
    }
  }, [loadStatus, pendingInstruction, handleSubmit]);

  useEffect(() => {
    if (!isAuthenticated) {
      setConversations(null);
      setSelectedId(null);
      setDetail(null);
      setListError(null);
      setDetailError(null);
      setAiStatus(null);
      setNotConfiguredOverride(false);
      setPendingInstruction(null);
      return;
    }
    void loadList();
    void loadStatus();
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
  const showUnconfigured =
    (aiStatus !== null && !aiStatus.configured) || notConfiguredOverride;

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

      <div className="flex-1 flex flex-col min-h-0">
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
              onReconcile={reconcileConversation}
            />
          </main>
        </div>
        )}
        {showUnconfigured ? (
          <AIUnconfiguredNotice onRetry={retryUnconfigured} />
        ) : (
          <AIComposer
            disabled={submitting}
            submitting={submitting}
            error={submitError}
            onSubmit={handleSubmit}
          />
        )}
      </div>
    </div>
  );
}