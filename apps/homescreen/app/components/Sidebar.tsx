"use client";

import { useState } from "react";
import {
  ActivityIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  MessageSquareIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/base-ui/dialog";
import { chatHistoryTime, type ChatSessionSummary } from "../lib/chat-history";

export type PaneId =
  | "status"
  | "chat"
  | "models"
  | "capture"
  | "account"
  | "usage"
  | "monitor"
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
  archivedSessions,
  activeSessionId,
  historyLoading,
  historyError,
  archiveBusy,
  archiveActiveDisabled,
  onSelectSession,
  onArchiveSession,
  onRestoreSession,
  onArchiveAll,
}: {
  active: PaneId;
  onSelect: (id: PaneId) => void;
  connected: boolean;
  sessions: ChatSessionSummary[];
  archivedSessions: ChatSessionSummary[];
  activeSessionId: string | null;
  historyLoading: boolean;
  historyError: string | null;
  archiveBusy: string | null;
  archiveActiveDisabled: boolean;
  onSelectSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => Promise<boolean>;
  onRestoreSession: (sessionId: string) => Promise<boolean>;
  onArchiveAll: () => Promise<boolean>;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [archiveAllOpen, setArchiveAllOpen] = useState(false);
  const visibleSessions = showArchived ? archivedSessions : sessions;

  return (
    <aside className="sidebar">
      <div className="chat-nav-heading">
        <div className="nav-section">{showArchived ? "Archived" : "Chats"}</div>
        <button
          type="button"
          className="chat-nav-view-toggle"
          onClick={() => setShowArchived((value) => !value)}
          aria-label={showArchived ? "Back to chats" : "View archived chats"}
          title={showArchived ? "Back to chats" : "View archived chats"}
        >
          {showArchived ? (
            <ArrowLeftIcon aria-hidden="true" size={14} strokeWidth={1.8} />
          ) : (
            <ArchiveIcon aria-hidden="true" size={14} strokeWidth={1.8} />
          )}
          <span>{showArchived ? "Chats" : archivedSessions.length || ""}</span>
        </button>
      </div>

      {historyError && (
        <div className="chat-nav-error" role="alert">
          {historyError}
        </div>
      )}

      <nav
        className="chat-nav-list"
        aria-label={showArchived ? "Archived chats" : "Recent chats"}
        aria-busy={historyLoading}
      >
        {historyLoading && visibleSessions.length === 0 ? (
          <div className="chat-nav-empty">Loading chats…</div>
        ) : visibleSessions.length === 0 ? (
          showArchived ? <div className="chat-nav-empty">No archived chats.</div> : null
        ) : (
          visibleSessions.map((session) => {
            const isActive = active === "chat" && activeSessionId === session.session_id;
            const actionDisabled =
              archiveBusy !== null || (!showArchived && isActive && archiveActiveDisabled);
            const actionLabel = showArchived ? "Restore chat" : "Archive chat";
            return (
              <div
                key={session.session_id}
                className={"chat-nav-item" + (isActive ? " active" : "")}
              >
                <button
                  type="button"
                  className="chat-nav-open"
                  onClick={async () => {
                    if (showArchived) {
                      if (await onRestoreSession(session.session_id)) setShowArchived(false);
                    } else {
                      onSelectSession(session.session_id);
                    }
                  }}
                  title={session.title}
                  disabled={archiveBusy !== null}
                >
                  <MessageSquareIcon className="nav-icon" aria-hidden="true" size={16} strokeWidth={1.6} />
                  <span className="chat-nav-copy">
                    <span className="chat-nav-title">
                      {session.title.trim().replace(/\s+/g, " ") || "Untitled chat"}
                    </span>
                    <span className="chat-nav-time">
                      {chatHistoryTime(showArchived ? session.archived_at ?? session.updated_at : session.updated_at)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="chat-nav-action"
                  aria-label={`${actionLabel}: ${session.title || "Untitled chat"}`}
                  title={
                    !showArchived && isActive && archiveActiveDisabled
                      ? "Stop the response before archiving"
                      : actionLabel
                  }
                  disabled={actionDisabled}
                  onClick={async () => {
                    const completed = showArchived
                      ? await onRestoreSession(session.session_id)
                      : await onArchiveSession(session.session_id);
                    if (completed && showArchived) setShowArchived(false);
                  }}
                >
                  {archiveBusy === session.session_id ? (
                    <span className="chat-nav-action-progress" aria-hidden="true" />
                  ) : showArchived ? (
                    <ArchiveRestoreIcon aria-hidden="true" size={15} strokeWidth={1.8} />
                  ) : (
                    <ArchiveIcon aria-hidden="true" size={15} strokeWidth={1.8} />
                  )}
                </button>
              </div>
            );
          })
        )}
      </nav>

      {!showArchived && sessions.length > 0 && (
        <button
          type="button"
          className="chat-nav-archive-all"
          onClick={() => setArchiveAllOpen(true)}
          disabled={archiveBusy !== null || archiveActiveDisabled}
        >
          <ArchiveIcon aria-hidden="true" size={14} strokeWidth={1.8} />
          Archive all chats
        </button>
      )}

      <Dialog open={archiveAllOpen} onOpenChange={setArchiveAllOpen}>
        <DialogContent className="chat-archive-dialog">
          <DialogHeader>
            <DialogTitle>Archive all chats?</DialogTitle>
            <DialogDescription>
              They will disappear from the sidebar but remain on this Mac. You can restore them anytime.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" className="btn ghost" onClick={() => setArchiveAllOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={archiveBusy !== null}
              onClick={async () => {
                if (await onArchiveAll()) {
                  setArchiveAllOpen(false);
                  setShowArchived(true);
                }
              }}
            >
              {archiveBusy === "all" ? "Archiving…" : "Archive all"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="nav-spacer" />
      <button
        className={"nav-monitor" + (active === "monitor" ? " active" : "")}
        onClick={() => onSelect("monitor")}
      >
        <ActivityIcon className="nav-icon" aria-hidden="true" size={16} strokeWidth={1.7} />
        <span>Monitor</span>
      </button>
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
