import { MessageSquareIcon } from "lucide-react";
import { chatHistoryTime, type ChatSessionSummary } from "../lib/chat-history";

export type PaneId =
  | "status"
  | "chat"
  | "models"
  | "capture"
  | "account"
  | "usage"
  | "traces"
  | "rlm"
  | "training-evals"
  | "training-optimization"
  | "training-datasets"
  | "training-finetuning"
  | "training-rl"
  | "training-jobs";

const AccountIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" className="nav-icon" aria-hidden="true">
    <circle cx="8" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3 14c.7-2.5 2.7-4 5-4s4.3 1.5 5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

export function Sidebar({
  active,
  onSelect,
  connected,
  sessions,
  activeSessionId,
  historyLoading,
  onSelectSession,
}: {
  active: PaneId;
  onSelect: (id: PaneId) => void;
  connected: boolean;
  sessions: ChatSessionSummary[];
  activeSessionId: string | null;
  historyLoading: boolean;
  onSelectSession: (sessionId: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="nav-section">Chats</div>
      <nav className="chat-nav-list" aria-label="Recent chats">
        {historyLoading && sessions.length === 0 ? (
          <div className="chat-nav-empty">Loading chats…</div>
        ) : sessions.length === 0 ? (
          <div className="chat-nav-empty">No saved chats yet.</div>
        ) : (
          sessions.map((session) => (
            <button
              type="button"
              key={session.session_id}
              className={
                "chat-nav-item" +
                (active === "chat" && activeSessionId === session.session_id ? " active" : "")
              }
              onClick={() => onSelectSession(session.session_id)}
              title={session.title}
            >
              <MessageSquareIcon className="nav-icon" aria-hidden="true" size={16} strokeWidth={1.6} />
              <span className="chat-nav-copy">
                <span className="chat-nav-title">
                  {session.title.trim().replace(/\s+/g, " ") || "Untitled chat"}
                </span>
                <span className="chat-nav-time">{chatHistoryTime(session.updated_at)}</span>
              </span>
            </button>
          ))
        )}
      </nav>

      <div className="nav-spacer" />
      <button
        className={"nav-account" + (active === "account" ? " active" : "")}
        onClick={() => onSelect("account")}
      >
        <AccountIcon />
        <span className="nav-account-copy">
          <span>Account</span>
          <span className="nav-account-status">
            <span className={"dot" + (connected ? " running" : "")} />
            {connected ? "Connected" : "Disconnected"}
          </span>
        </span>
      </button>
    </aside>
  );
}
