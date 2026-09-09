import type { AiConversationSummary } from "../../types/ai";
import TurnStateBadge from "./TurnStateBadge";

interface ConversationListProps {
  conversations: readonly AiConversationSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The list of the user's real, persisted conversations (newest-first). */
export default function ConversationList({
  conversations,
  selectedId,
  onSelect,
}: ConversationListProps) {
  return (
    <ul className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
      {conversations.map((conversation) => {
        const selected = conversation.id === selectedId;
        const hasState = conversation.turnState !== "completed";
        return (
          <li key={conversation.id}>
            <button
              type="button"
              onClick={() => onSelect(conversation.id)}
              className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors ${
                selected ? "bg-secondary" : "hover:bg-secondary/60"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-foreground truncate">
                  {conversation.title?.trim() ? conversation.title : "Untitled conversation"}
                </p>
                <span className="text-[11px] text-muted-foreground flex-shrink-0">
                  {formatUpdatedAt(conversation.updatedAt)}
                </span>
              </div>
              {hasState && (
                <div className="mt-1">
                  <TurnStateBadge state={conversation.turnState} />
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}