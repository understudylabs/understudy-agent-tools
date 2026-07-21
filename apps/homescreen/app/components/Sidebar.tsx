"use client";

import { PlusIcon } from "lucide-react";
import { TooltipProvider } from "@/app/components/base-ui/tooltip";
import { NAV_ITEMS, paneToNavId, type NavGroupId, type Scope } from "../lib/nav";
import { NavGroup } from "./sidebar/NavGroup";
import { NavItem } from "./sidebar/NavItem";
import { ScopeSwitcher } from "./sidebar/ScopeSwitcher";
import { TrainingThreadList } from "./sidebar/TrainingThreadList";
import { ChatSessionList } from "./sidebar/ChatSessionList";
import type { ChatSessionSummary } from "../lib/chat-history";
import type { TrainingThreadSummary } from "../lib/training-threads.mjs";

export type PaneId =
  | "status"
  | "org-summary"
  | "chat"
  | "models"
  | "capture"
  | "captures"
  | "account"
  | "usage"
  | "reporting"
  | "traces"
  | "rlm"
  | "explore"
  | "workload-config"
  | "project-summary"
  | "project-reporting"
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

const GROUP_LABELS: Record<NavGroupId, string> = {
  organization: "Organization",
  workload: "Workload",
  training: "Training",
  sessions: "Chats",
  manage: "Manage",
};

export function Sidebar({
  active,
  onSelect,
  connected,
  scope,
  onScopeChange,
  onNewChat,
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
  trainingThreads,
  activeThreadId,
  onSelectThread,
  onArchiveThread,
}: {
  active: PaneId;
  onSelect: (id: PaneId) => void;
  connected: boolean;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  onNewChat: () => void;
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
  trainingThreads: TrainingThreadSummary[];
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onArchiveThread: (threadId: string) => Promise<boolean>;
}) {
  const activeNavId = paneToNavId(active, activeSessionId, activeThreadId);

  const itemsFor = (group: NavGroupId) =>
    NAV_ITEMS.filter((item) => item.group === group).map((item) => (
      <NavItem
        key={item.id}
        label={item.label}
        icon={item.icon}
        active={activeNavId === item.id}
        disabled={item.disabled}
        disabledReason={item.disabledReason}
        onSelect={() => {
          if (item.pane) onSelect(item.pane);
        }}
      />
    ));

  return (
    <TooltipProvider delayDuration={300}>
      <aside className="sidebar">
        <div className="sidebar-brand">Understudy</div>
        <ScopeSwitcher
          scope={scope}
          onScopeChange={onScopeChange}
          onWorkloadSelected={() => onSelect("workload-config")}
        />

        <NavGroup group="organization" label={GROUP_LABELS.organization}>
          {itemsFor("organization")}
        </NavGroup>

        {scope.workloadId && (
          <NavGroup group="workload" label={GROUP_LABELS.workload}>
            {itemsFor("workload")}
          </NavGroup>
        )}

        <NavGroup group="training" label={GROUP_LABELS.training}>
          {itemsFor("training")}
          <TrainingThreadList
            active={active}
            trainingThreads={trainingThreads}
            activeThreadId={activeThreadId}
            archiveBusy={archiveBusy}
            onSelectThread={onSelectThread}
            onArchiveThread={onArchiveThread}
          />
        </NavGroup>

        <NavGroup group="sessions" label={GROUP_LABELS.sessions}>
          <NavItem label="New chat" icon={PlusIcon} active={false} onSelect={onNewChat} />
          <ChatSessionList
            active={active}
            sessions={sessions}
            archivedSessions={archivedSessions}
            activeSessionId={activeSessionId}
            historyLoading={historyLoading}
            historyError={historyError}
            archiveBusy={archiveBusy}
            archiveActiveDisabled={archiveActiveDisabled}
            onSelectSession={onSelectSession}
            onArchiveSession={onArchiveSession}
            onRestoreSession={onRestoreSession}
            onArchiveAll={onArchiveAll}
          />
          {itemsFor("sessions")}
        </NavGroup>

        <NavGroup group="manage" label={GROUP_LABELS.manage}>
          {itemsFor("manage")}
        </NavGroup>

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
    </TooltipProvider>
  );
}
