"use client";

import { useState } from "react";
import { TrajectoryExplorer } from "@/components/trajectory/explorer";
import { ReplayView } from "@/components/trajectory/replay";

/**
 * Tabbed task views (Poolside Verifier-tab style): Conversation (the
 * flattened oracle history) and Replay (deterministic score-accumulation
 * over the same trajectory) as peers. The server-rendered rail rides along
 * both tabs.
 */
export function TaskViews({
  slug,
  taskId,
  rail,
  mode = "proposed",
}: {
  slug: string;
  taskId: string;
  rail: React.ReactNode;
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
      ) : (
        <div className="u-explorer" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(220px,320px)" }}>
          <section style={{ minWidth: 0 }}>
            <ReplayView slug={slug} taskId={taskId} />
          </section>
          <aside className="u-explorer-right">{rail}</aside>
        </div>
      )}
    </div>
  );
}
