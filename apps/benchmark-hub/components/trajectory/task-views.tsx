"use client";

import { useState } from "react";
import { TrajectoryExplorer } from "@/components/trajectory/explorer";
import { ReplayView } from "@/components/trajectory/replay";

/**
 * Tabbed task views (Poolside Verifier-tab style): Conversation (the
 * flattened oracle history) and Replay (deterministic score-accumulation
 * over the same trajectory) as peers. `rail` is optional (the proposed task
 * page dropped its right-hand rail — design feedback); `replayExtras`
 * renders under the Replay view (e.g. the world model's initial state).
 */
export function TaskViews({
  slug,
  taskId,
  rail = null,
  replayExtras = null,
  mode = "proposed",
}: {
  slug: string;
  taskId: string;
  rail?: React.ReactNode;
  /** Extra full-width content under the Replay tab (world model, etc.). */
  replayExtras?: React.ReactNode;
  /** proposed = foundry captures; promoted = eval rows joined to trace branches. */
  mode?: "proposed" | "promoted";
}) {
  const [tab, setTab] = useState<"conversation" | "replay">("conversation");
  return (
    <div>
      <div className="u-tabs" role="tablist">
        {(["conversation", "replay"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={"u-tab mono" + (tab === t ? " on" : "")}
            onClick={() => setTab(t)}
          >
            {t === "conversation" ? "Conversation" : "Replay"}
          </button>
        ))}
      </div>
      {tab === "conversation" ? (
        <TrajectoryExplorer slug={slug} taskId={taskId} mode={mode} rail={rail} />
      ) : rail ? (
        <div className="u-explorer" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(220px,320px)" }}>
          <section style={{ minWidth: 0 }}>
            <ReplayView slug={slug} taskId={taskId} />
            {replayExtras}
          </section>
          <aside className="u-explorer-right">{rail}</aside>
        </div>
      ) : (
        <div>
          <ReplayView slug={slug} taskId={taskId} />
          {replayExtras}
        </div>
      )}
    </div>
  );
}
