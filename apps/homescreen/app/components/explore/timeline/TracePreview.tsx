"use client";

import { useEffect, useState } from "react";
import { fetchTracePreview, type TracePreviewEvent } from "@/app/lib/exploreData";

// Compact trace preview for the timeline side panel: a color-railed event list.
// Data comes through the exploreData adapter (fetchTracePreview — the ported
// anatomy event query). The full transcript lives in the session pane.

const TYPE_COLORS: Record<string, string> = {
  user_input: "var(--model-clay)",
  assistant_response: "var(--model-house)",
  reasoning: "var(--model-violet)",
  tool_call: "var(--model-mint)",
  tool_response: "var(--model-mint)",
  system: "var(--ink-muted)",
  runtime: "var(--ink-muted)",
  compaction: "var(--model-amber)",
};

const MAX_EVENTS = 40;
const SNIPPET = 110;

export default function TracePreview({ sessionId }: { sessionId: string }) {
  const [events, setEvents] = useState<TracePreviewEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stale = false;
    setEvents(null);
    setFailed(false);
    fetchTracePreview(sessionId)
      .then((rows) => {
        if (!stale) setEvents(rows);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [sessionId]);

  if (failed) return <div className="mono text-[11px] text-ink-muted">trace unavailable</div>;
  if (events === null)
    return <div className="mono breath text-[11px] text-ink-muted">reading trace…</div>;
  if (events.length === 0)
    return <div className="mono text-[11px] text-ink-muted">no events projected</div>;

  // plumbing events (system/runtime/unknown with no text) drown the story — skip them
  const meaningful = events.filter(
    (e) =>
      !(
        ["system", "runtime", "unknown"].includes(e.event_type) &&
        !(e.preview || "").trim()
      ),
  );
  const shown = meaningful.slice(0, MAX_EVENTS);
  let lastTurn = -1;

  return (
    <div className="max-h-[38vh] overflow-y-auto rounded-[8px] border border-rule bg-window/60">
      {shown.map((e) => {
        const turnBreak = e.turn_seq !== lastTurn;
        lastTurn = e.turn_seq;
        const color = TYPE_COLORS[e.event_type] ?? "var(--ink-muted)";
        const text = (e.preview || "").replace(/\s+/g, " ").trim();
        return (
          <div key={e.event_order}>
            {turnBreak && (
              <div className="mono border-b border-rule/60 px-2.5 pt-2 pb-0.5 text-[9px] tracking-widest text-ink-muted/70">
                T{e.turn_seq}
              </div>
            )}
            <div className="flex gap-2 px-2.5 py-1">
              <span
                className="mt-[5px] block h-[calc(100%-6px)] w-[2px] shrink-0 self-stretch rounded-full"
                style={{ background: color, opacity: 0.8 }}
              />
              <div className="min-w-0">
                <span className="mono text-[10px]" style={{ color }}>
                  {e.event_type === "tool_call" || e.event_type === "tool_response"
                    ? `${e.event_type === "tool_call" ? "→" : "←"} ${e.name || "tool"}`
                    : e.event_type}
                </span>
                {text && (
                  <p className="truncate text-[11px] leading-snug text-ink-muted">
                    {text.slice(0, SNIPPET)}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {meaningful.length > shown.length && (
        <div className="mono border-t border-rule px-2.5 py-1.5 text-[10px] text-ink-muted">
          +{meaningful.length - shown.length} more events — open the full transcript for the rest
        </div>
      )}
    </div>
  );
}
