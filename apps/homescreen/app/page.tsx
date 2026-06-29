"use client";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Sidebar, type PaneId } from "./components/Sidebar";
import { StatusPane } from "./components/StatusPane";
import { ModelsPane } from "./components/ModelsPane";
import { ChatPane } from "./components/ChatPane";
import { TracesPane } from "./components/TracesPane";
import { AccountPane } from "./components/AccountPane";
import { UsagePane } from "./components/UsagePane";
import { isTrainingPane, TrainingPane } from "./components/TrainingPane";
import { useStatus } from "./lib/useStatus";

export default function Page() {
  const [pane, setPane] = useState<PaneId>("chat");
  const status = useStatus();
  const connected = status.snap?.connected ?? false;

  // Inbound: a coding agent (via the local server) can drive the GUI to a pane.
  useEffect(() => {
    const valid: PaneId[] = [
      "status",
      "chat",
      "models",
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

  return (
    <div className="shell">
      <Sidebar active={pane} onSelect={setPane} connected={connected} />
      <main className="content">
        {pane === "status" && <StatusPane status={status} />}
        {pane === "chat" && <ChatPane status={status} />}
        {pane === "models" && <ModelsPane />}
        {isTrainingPane(pane) && <TrainingPane section={pane} />}
        {pane === "account" && <AccountPane />}
        {pane === "usage" && <UsagePane status={status} />}
        {pane === "traces" && <TracesPane />}
      </main>
    </div>
  );
}
