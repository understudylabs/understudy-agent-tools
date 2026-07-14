"use client";
import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PanelLeftIcon, SquarePenIcon } from "lucide-react";
import { Sidebar, type PaneId } from "./components/Sidebar";
import { StatusPane } from "./components/StatusPane";
import { ModelsPane } from "./components/ModelsPane";
import { CapturePane } from "./components/CapturePane";
import { ChatPane } from "./components/ChatPane";
import { TracesPane } from "./components/TracesPane";
import { AccountPane } from "./components/AccountPane";
import { UsagePane } from "./components/UsagePane";
import { DownloadQrButton } from "./components/DownloadQrButton";
import { isTrainingPane, TrainingPane } from "./components/TrainingPane";
import { RlmPane } from "./components/RlmPane";
import { RuntimeRepairPrompt } from "./components/RuntimeRepairPrompt";
import { ModelDownloadNotice } from "./components/ModelDownloadNotice";
import { useStatus } from "./lib/useStatus";
import type { ChatSessionRequest, ChatSessionSummary } from "./lib/chat-history";

export default function Page() {
  const [pane, setPane] = useState<PaneId>("chat");
  const [railOpen, setRailOpen] = useState(false);
  const [chatResetToken, setChatResetToken] = useState(0);
  const [chatHistory, setChatHistory] = useState<ChatSessionSummary[]>([]);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [requestedChatSession, setRequestedChatSession] = useState<ChatSessionRequest | null>(null);
  const status = useStatus();
  const connected = status.snap?.connected ?? false;

  const refreshChatHistory = useCallback(() => {
    if (!isTauri()) {
      setChatHistory([]);
      setChatHistoryLoading(false);
      return;
    }
    setChatHistoryLoading(true);
    invoke<ChatSessionSummary[]>("chat_sessions_list", { limit: 30 })
      .then(setChatHistory)
      .catch(() => setChatHistory([]))
      .finally(() => setChatHistoryLoading(false));
  }, []);

  const handleChatSessionChange = useCallback((sessionId: string) => {
    setActiveChatSessionId(sessionId);
    setRequestedChatSession((current) =>
      current?.sessionId === sessionId ? null : current,
    );
  }, []);

  useEffect(() => {
    if (railOpen) refreshChatHistory();
  }, [railOpen, refreshChatHistory]);

  const newChat = () => {
    if (pane !== "chat") return;
    setChatResetToken((token) => token + 1);
  };

  // Inbound: a coding agent (via the local server) can drive the GUI to a pane.
  useEffect(() => {
    if (!isTauri()) return;
    const valid: PaneId[] = [
      "status",
      "chat",
      "models",
      "account",
      "rlm",
    ];
    const hidden = [
      "capture",
      "usage",
      "traces",
      "training",
      "training-evals",
      "training-optimization",
      "training-datasets",
      "training-finetuning",
      "training-rl",
      "training-jobs",
    ];
    const u = listen<{ pane?: string }>("server-focus", (e) => {
      const requested = e.payload?.pane;
      const p = (
        requested === "marketplace" ? "models" :
        requested && hidden.includes(requested) ? "status" :
        requested
      ) as PaneId;
      if (p && (valid as string[]).includes(p)) setPane(p);
    });
    return () => {
      u.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return;
      if (event.key.toLowerCase() !== "n") return;
      if (pane !== "chat") return;
      event.preventDefault();
      newChat();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pane]);

  return (
    <div className={"shell" + (railOpen ? " rail-open" : "")}>
      <div className="window-drag-region" data-tauri-drag-region />
      <button
        type="button"
        className="rail-toggle"
        aria-label={railOpen ? "Hide navigation" : "Show navigation"}
        aria-expanded={railOpen}
        onClick={() => setRailOpen((open) => !open)}
      >
        <PanelLeftIcon aria-hidden="true" size={16} strokeWidth={2} />
      </button>
      {pane === "chat" && (
        <>
          <button
            type="button"
            className="titlebar-new-chat"
            aria-label="New chat"
            title="New chat (Cmd+N)"
            onClick={newChat}
          >
            <SquarePenIcon aria-hidden="true" size={15} strokeWidth={2} />
          </button>
        </>
      )}
      <DownloadQrButton />
      <div className="operation-notice-stack">
        <RuntimeRepairPrompt />
        <ModelDownloadNotice />
      </div>
      <Sidebar
        active={pane}
        onSelect={(next) => {
          setPane(next);
        }}
        connected={connected}
        sessions={chatHistory}
        activeSessionId={activeChatSessionId}
        historyLoading={chatHistoryLoading}
        onSelectSession={(sessionId) => {
          setPane("chat");
          setRequestedChatSession((current) => ({
            sessionId,
            requestId: (current?.requestId ?? 0) + 1,
          }));
        }}
      />
      <main className="content">
        {pane === "status" && <StatusPane status={status} />}
        {pane === "chat" && (
          <ChatPane
            resetToken={chatResetToken}
            requestedSession={requestedChatSession}
            onSessionChange={handleChatSessionChange}
            onHistoryChanged={refreshChatHistory}
          />
        )}
        {pane === "models" && <ModelsPane />}
        {pane === "capture" && <CapturePane />}
        {pane === "rlm" && <RlmPane />}
        {isTrainingPane(pane) && <TrainingPane section={pane} />}
        {pane === "account" && <AccountPane />}
        {pane === "usage" && <UsagePane status={status} />}
        {pane === "traces" && <TracesPane />}
      </main>
    </div>
  );
}
