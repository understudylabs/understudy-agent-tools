"use client";
import { useEffect, useState } from "react";
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
import { useStatus } from "./lib/useStatus";

export default function Page() {
  const [pane, setPane] = useState<PaneId>("chat");
  const [railOpen, setRailOpen] = useState(false);
  const [chatResetToken, setChatResetToken] = useState(0);
  const status = useStatus();
  const connected = status.snap?.connected ?? false;

  const newChat = () => {
    if (pane !== "chat") return;
    setChatResetToken((token) => token + 1);
  };

  // Inbound: a coding agent (via the local server) can drive the GUI to a pane.
  useEffect(() => {
    const valid: PaneId[] = [
      "status",
      "chat",
      "models",
      "capture",
      "account",
      "usage",
      "traces",
      "training-evals",
      "training-optimization",
      "training-datasets",
      "training-finetuning",
      "training-rl",
      "training-jobs",
    ];
    const u = listen<{ pane?: string }>("server-focus", (e) => {
      const p = (
        e.payload?.pane === "marketplace" ? "models" :
        e.payload?.pane === "training" ? "training-jobs" :
        e.payload?.pane
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
        <button
          type="button"
          className="titlebar-new-chat"
          aria-label="New chat"
          title="New chat (Cmd+N)"
          onClick={newChat}
        >
          <SquarePenIcon aria-hidden="true" size={15} strokeWidth={2} />
        </button>
      )}
      <DownloadQrButton />
      <Sidebar
        active={pane}
        onSelect={(next) => {
          setPane(next);
          setRailOpen(false);
        }}
        connected={connected}
      />
      <main className="content">
        {pane === "status" && <StatusPane status={status} />}
        {pane === "chat" && <ChatPane resetToken={chatResetToken} />}
        {pane === "models" && <ModelsPane />}
        {pane === "capture" && <CapturePane />}
        {isTrainingPane(pane) && <TrainingPane section={pane} />}
        {pane === "account" && <AccountPane />}
        {pane === "usage" && <UsagePane status={status} />}
        {pane === "traces" && <TracesPane />}
      </main>
    </div>
  );
}
