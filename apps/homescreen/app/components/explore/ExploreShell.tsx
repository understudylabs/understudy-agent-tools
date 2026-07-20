"use client";

import { useState, type ComponentType } from "react";
import dynamic from "next/dynamic";

// Contract (see app/lib/exploreContract.ts, "Explore pane composition"):
type TimelinePaneProps = { onOpenSession: (id: string) => void };
type TasksPaneProps = { onOpenSession: (id: string) => void };
type TranscriptPaneProps = { sessionId: string; onBack: () => void };

const exploreLoading = () => (
  <div
    className="explore-loading mono"
    style={{ padding: 16, color: "var(--ink-muted)", fontSize: 12 }}
  >
    loading explore…
  </div>
);

// The timeline and session panes render WebGL scenes; the app is a static
// export (output: "export"), so they are loaded client-only.
const TimelinePane = dynamic<TimelinePaneProps>(
  () =>
    import("./timeline/TimelinePane") as Promise<{
      default: ComponentType<TimelinePaneProps>;
    }>,
  { ssr: false, loading: exploreLoading },
);
const TasksPane = dynamic<TasksPaneProps>(
  () =>
    import("./tasks/TasksPane") as Promise<{
      default: ComponentType<TasksPaneProps>;
    }>,
  { ssr: false, loading: exploreLoading },
);
const TranscriptPane = dynamic<TranscriptPaneProps>(
  () =>
    import("./session/TranscriptPane") as Promise<{
      default: ComponentType<TranscriptPaneProps>;
    }>,
  { ssr: false, loading: exploreLoading },
);

type ListView = "timeline" | "tasks";
type ExploreView = ListView | { session: string; from: ListView };

export function ExploreShell() {
  const [view, setView] = useState<ExploreView>("timeline");
  const sessionId = typeof view === "string" ? null : view.session;
  // list view the breadcrumb returns to (and the sub-nav highlights)
  const listView: ListView = typeof view === "string" ? view : view.from;

  const navLink = (v: ListView) => (
    <button
      key={v}
      type="button"
      onClick={() => setView(v)}
      aria-current={!sessionId && listView === v ? "page" : undefined}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        font: "inherit",
        color: !sessionId && listView === v ? "var(--ink)" : "var(--ink-muted)",
      }}
    >
      {v}
    </button>
  );

  return (
    <div
      className="explore-shell mono"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--field, #000)",
      }}
    >
      <div
        className="explore-subheader"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flex: "none",
          padding: "6px 12px",
          borderBottom: "1px solid var(--rule)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          letterSpacing: "0.04em",
          color: "var(--ink-muted)",
        }}
      >
        {sessionId ? (
          <>
            <button
              type="button"
              onClick={() => setView(listView)}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                font: "inherit",
                color: "var(--ink-muted)",
              }}
            >
              explore / {listView}
            </button>
            <span aria-hidden="true">/</span>
            <span style={{ color: "var(--ink)" }}>
              session {sessionId.slice(0, 8)}
            </span>
          </>
        ) : (
          <>
            <span>explore /</span>
            {navLink("timeline")}
            <span aria-hidden="true">·</span>
            {navLink("tasks")}
          </>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
        {sessionId ? (
          <TranscriptPane
            sessionId={sessionId}
            onBack={() => setView(listView)}
          />
        ) : listView === "tasks" ? (
          <TasksPane
            onOpenSession={(id: string) => setView({ session: id, from: "tasks" })}
          />
        ) : (
          <TimelinePane
            onOpenSession={(id: string) => setView({ session: id, from: "timeline" })}
          />
        )}
      </div>
    </div>
  );
}
