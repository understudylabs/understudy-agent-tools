"use client";

import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { SquarePenIcon, UserRoundIcon } from "lucide-react";
import { TooltipProvider } from "@/app/components/base-ui/tooltip";
import { NAV_ITEMS, paneToNavId, type NavGroupId, type Scope } from "../lib/nav";
import { AnalyticsNavTree } from "./sidebar/AnalyticsNavTree";
import { NavGroup } from "./sidebar/NavGroup";
import { NavItem } from "./sidebar/NavItem";
import { TrainingThreadList } from "./sidebar/TrainingThreadList";
import { ChatSessionList } from "./sidebar/ChatSessionList";
import type { ChatSessionSummary } from "../lib/chat-history";
import type { TrainingThreadSummary } from "../lib/training-threads.mjs";

export type PaneId =
  | "status"
  | "org-summary"
  | "chat"
  | "models"
  | "model-catalog"
  | "capture"
  | "captures"
  | "account"
  | "api-keys"
  | "usage"
  | "reporting"
  | "analytics-usage"
  | "analytics-caching"
  | "analytics-cost"
  | "billing"
  | "traces"
  | "rlm"
  | "explore"
  | "setup"
  | "workload-config"
  | "project-summary"
  | "project-reporting"
  | "production-monitor"
  | "settings"
  | "training-evals"
  | "training-optimization"
  | "training-datasets"
  | "training-finetuning"
  | "training-rl"
  | "training-jobs";

const GROUP_LABELS: Record<NavGroupId, string> = {
  organization: "Capture",
  training: "Training",
  sessions: "Playground",
  manage: "Manage",
};

export function Sidebar({
  active,
  onSelect,
  connected,
  scope,
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
  const activeNavId = paneToNavId(active);

  // Bottom-left identity: prefer a real org name when the gateway exposes
  // one; fall back to a shortened org id ("org_ABCD…WXYZ"), then "Account".
  const [orgLabel, setOrgLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    invoke<{ org_name?: string | null; org_id?: string | null }>("account_status")
      .then((s) => {
        if (s?.org_name) setOrgLabel(s.org_name);
        else if (s?.org_id) {
          const id = s.org_id;
          setOrgLabel(id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
        }
      })
      .catch(() => {});
  }, [connected]);

  const itemsFor = (group: NavGroupId, ids?: string[]) =>
    NAV_ITEMS.filter(
      (item) =>
        item.group === group &&
        (!item.requiresWorkload || scope.workloadId) &&
        (!ids || ids.includes(item.id)),
    ).map((item) => (
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
        {/* The brand row doubles as the window-drag surface for the strip of
            title bar the sidebar now owns (the drag-region band starts at the
            content panel when the rail is open). */}
        <div className="sidebar-brand" data-tauri-drag-region>Understudy</div>

        <button type="button" className="sidebar-new-chat" onClick={onNewChat}>
          <SquarePenIcon className="nav-icon" aria-hidden="true" size={15} strokeWidth={1.8} />
          New chat
        </button>

        <div className="sidebar-nav">
          <NavGroup group="organization" label={GROUP_LABELS.organization}>
            {itemsFor("organization", ["org-summary"])}
            {/* Analytics is a collapsible parent with indented metric
                children (Usage / Caching / Cost) — console-nav parity. */}
            <AnalyticsNavTree active={active} onSelect={onSelect} />
            {itemsFor(
              "organization",
              NAV_ITEMS.filter(
                (item) => item.group === "organization" && item.id !== "org-summary",
              ).map((item) => item.id),
            )}
          </NavGroup>

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
        </div>

        <button
          className={"nav-account" + (active === "account" ? " active" : "")}
          onClick={() => onSelect("account")}
        >
          <UserRoundIcon className="nav-icon" aria-hidden="true" size={16} strokeWidth={1.6} />
          <span className="nav-account-copy">
            <span className="nav-account-name" title={orgLabel ?? undefined}>
              {orgLabel ?? "Account"}
            </span>
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
