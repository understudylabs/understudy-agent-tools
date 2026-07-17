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
import { MonitorPane } from "./components/MonitorPane";
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
  const [archivedChatHistory, setArchivedChatHistory] = useState<ChatSessionSummary[]>([]);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const [chatHistoryError, setChatHistoryError] = useState<string | null>(null);
  const [chatArchiveBusy, setChatArchiveBusy] = useState<string | null>(null);
  const [chatStreaming, setChatStreaming] = useState(false);
  const [chatTrainingActive, setChatTrainingActive] = useState(false);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [requestedChatSession, setRequestedChatSession] = useState<ChatSessionRequest | null>(null);
  const [starterDownloadRequest, setStarterDownloadRequest] = useState(0);
  const [signInIntent, setSignInIntent] = useState<{
    returnToChat: boolean;
    downloadAfterSignIn: boolean;
  } | null>(null);
  const status = useStatus();
  const connected = status.snap?.connected ?? false;

  const refreshChatHistory = useCallback(async () => {
    if (!isTauri()) {
      setChatHistory([]);
      setArchivedChatHistory([]);
      setChatHistoryLoading(false);
      return;
    }
    setChatHistoryLoading(true);
    setChatHistoryError(null);
    try {
      const [activeSessions, archivedSessions] = await Promise.all([
        invoke<ChatSessionSummary[]>("chat_sessions_list", { limit: 100, archived: false }),
        invoke<ChatSessionSummary[]>("chat_sessions_list", { limit: 100, archived: true }),
      ]);
      setChatHistory(activeSessions);
      setArchivedChatHistory(archivedSessions);
    } catch (error) {
      setChatHistoryError(`Chats could not be loaded: ${String(error)}`);
    } finally {
      setChatHistoryLoading(false);
    }
  }, []);

  const startFreshAfterArchive = useCallback(() => {
    setRequestedChatSession(null);
    setActiveChatSessionId(null);
    setPane("chat");
    setChatResetToken((token) => token + 1);
  }, []);

  const archiveChatSession = useCallback(async (sessionId: string) => {
    if (chatStreaming && activeChatSessionId === sessionId) {
      setChatHistoryError("Stop the current response before archiving this chat.");
      return false;
    }
    setChatArchiveBusy(sessionId);
    setChatHistoryError(null);
    try {
      const archived = await invoke<boolean>("chat_session_archive", { sessionId });
      if (!archived) {
        setChatHistoryError("That chat was already archived or is no longer available.");
        return false;
      }
      if (activeChatSessionId === sessionId) startFreshAfterArchive();
      await refreshChatHistory();
      return true;
    } catch (error) {
      setChatHistoryError(`Chat could not be archived: ${String(error)}`);
      return false;
    } finally {
      setChatArchiveBusy(null);
    }
  }, [activeChatSessionId, chatStreaming, refreshChatHistory, startFreshAfterArchive]);

  const restoreChatSession = useCallback(async (sessionId: string) => {
    setChatArchiveBusy(sessionId);
    setChatHistoryError(null);
    try {
      const restored = await invoke<boolean>("chat_session_restore", { sessionId });
      if (!restored) {
        setChatHistoryError("That chat was already restored or is no longer available.");
        return false;
      }
      await refreshChatHistory();
      setPane("chat");
      setRequestedChatSession((current) => ({
        sessionId,
        requestId: (current?.requestId ?? 0) + 1,
      }));
      return true;
    } catch (error) {
      setChatHistoryError(`Chat could not be restored: ${String(error)}`);
      return false;
    } finally {
      setChatArchiveBusy(null);
    }
  }, [refreshChatHistory]);

  const archiveAllChatSessions = useCallback(async () => {
    const activeSessionIsSaved = Boolean(
      activeChatSessionId && chatHistory.some((session) => session.session_id === activeChatSessionId),
    );
    if (chatStreaming) {
      setChatHistoryError("Stop the current response before archiving all chats.");
      return false;
    }
    setChatArchiveBusy("all");
    setChatHistoryError(null);
    try {
      await invoke<number>("chat_sessions_archive_all");
      if (activeSessionIsSaved) startFreshAfterArchive();
      await refreshChatHistory();
      return true;
    } catch (error) {
      setChatHistoryError(`Chats could not be archived: ${String(error)}`);
      return false;
    } finally {
      setChatArchiveBusy(null);
    }
  }, [activeChatSessionId, chatHistory, chatStreaming, refreshChatHistory, startFreshAfterArchive]);

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
    setRequestedChatSession(null);
    setActiveChatSessionId(null);
    setChatResetToken((token) => token + 1);
  };

  const openFirstRunSignIn = useCallback((downloadAfterSignIn: boolean) => {
    setSignInIntent({ returnToChat: true, downloadAfterSignIn });
    setPane("account");
  }, []);

  const finishSignIn = useCallback(() => {
    if (!signInIntent) return;
    if (signInIntent.downloadAfterSignIn) {
      setStarterDownloadRequest((request) => request + 1);
    }
    if (signInIntent.returnToChat) setPane("chat");
    setSignInIntent(null);
  }, [signInIntent]);

  // Inbound: a coding agent (via the local server) can drive the GUI to a pane.
  useEffect(() => {
    if (!isTauri()) return;
    const valid: PaneId[] = [
      "status",
      "chat",
      "models",
      "account",
      "monitor",
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
        <RuntimeRepairPrompt quiet={chatTrainingActive} />
        <ModelDownloadNotice
          quiet={chatTrainingActive}
          starterDownloadRequest={starterDownloadRequest}
          onOpenAccount={openFirstRunSignIn}
        />
      </div>
      <Sidebar
        active={pane}
        onSelect={(next) => {
          setPane(next);
        }}
        connected={connected}
        sessions={chatHistory}
        archivedSessions={archivedChatHistory}
        activeSessionId={activeChatSessionId}
        historyLoading={chatHistoryLoading}
        historyError={chatHistoryError}
        archiveBusy={chatArchiveBusy}
        archiveActiveDisabled={chatStreaming}
        onArchiveSession={archiveChatSession}
        onRestoreSession={restoreChatSession}
        onArchiveAll={archiveAllChatSessions}
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
            activeSessionId={activeChatSessionId}
            requestedSession={requestedChatSession}
            onSessionChange={handleChatSessionChange}
            onHistoryChanged={refreshChatHistory}
            onStreamingChange={setChatStreaming}
            onTrainingChange={setChatTrainingActive}
            onNeedsSignIn={() => openFirstRunSignIn(false)}
          />
        )}
        {pane === "models" && <ModelsPane />}
        {pane === "capture" && <CapturePane />}
        {pane === "rlm" && <RlmPane />}
        {isTrainingPane(pane) && <TrainingPane section={pane} />}
        {pane === "account" && (
          <AccountPane
            onSignedIn={signInIntent ? finishSignIn : undefined}
            prioritizeSignIn={Boolean(signInIntent)}
          />
        )}
        {pane === "usage" && <UsagePane status={status} />}
        {pane === "monitor" && <MonitorPane onOpenAccount={() => setPane("account")} />}
        {pane === "traces" && <TracesPane />}
      </main>
    </div>
  );
}
