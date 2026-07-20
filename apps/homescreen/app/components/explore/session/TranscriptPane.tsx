"use client";

// Full lossless transcript view — ported from the moraine-viewer prototype's
// TranscriptClient. Every event type renders verbatim; long bodies and
// reasoning collapse; substream (subagent) runs nest one level under a
// labeled group header; pagination via event_order cursor; live tail polling.
//
// Desktop adaptations: data flows through fetchTranscript (Tauri invoke);
// a back button (props.onBack) replaces nav links; scrolling/follow-mode is
// computed against the pane's own scroll container instead of window (the
// pane lives inside the shell's overflow container, not a scrolling page).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchTranscript } from "@/app/lib/exploreData";
import type { SessionMeta, TranscriptEvent, TranscriptPage } from "./types";

const LONG_TEXT = 2000;
const TOOL_PREVIEW_LINES = 3;
const GROUP_AUTOCOLLAPSE = 30;

// live tailing
const LIVE_WINDOW_MS = 3 * 60 * 1000; // < 3 min since last event => live
const LIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000; // keep a slow pulse so a sleeping session can wake
const FRESH_FADE_MS = 2_500;
const FOLLOW_SLACK_PX = 160; // "near bottom" threshold

// ---------- helpers ----------

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function parseChTime(t: string): number {
  return Date.parse(t.replace(" ", "T") + "Z");
}

function fmtDuration(first: string, last: string): string {
  const ms = parseChTime(last) - parseChTime(first);
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function eventAccent(t: string): string {
  switch (t) {
    case "user_input": return "var(--model-clay)";
    case "tool_call":
    case "tool_response": return "var(--model-mint)";
    case "reasoning": return "var(--model-violet)";
    case "compaction": return "var(--model-amber)";
    case "assistant_response": return "var(--ink)";
    default: return "var(--ink-muted)";
  }
}

function firstLines(text: string, n: number): { head: string; more: boolean } {
  const lines = text.split("\n");
  if (lines.length <= n && text.length <= LONG_TEXT) return { head: text, more: false };
  return { head: lines.slice(0, n).join("\n").slice(0, LONG_TEXT), more: true };
}

// ---------- collapsible long text ----------

function LongText({ text, truncated }: { text: string; truncated: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_TEXT;
  const shown = open || !long ? text : text.slice(0, LONG_TEXT);
  return (
    <div>
      <pre className="mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, fontSize: 12, lineHeight: 1.55 }}>
        {shown}
        {!open && long ? "…" : ""}
      </pre>
      {long && (
        <button onClick={() => setOpen(!open)} style={btnStyle}>
          {open ? "collapse" : `show all ${fmtInt(text.length)} chars`}
        </button>
      )}
      {truncated && (
        <span className="mono" style={{ fontSize: 10, color: "var(--model-amber)", marginLeft: 8 }}>
          truncated at 20,000 chars
        </span>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--rule)",
  borderRadius: 4,
  color: "var(--ink-muted)",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  padding: "2px 8px",
  marginTop: 6,
  cursor: "pointer",
};

// ---------- single event card ----------

function EventCard({
  ev,
  highlighted,
  nested,
  fresh = false,
}: {
  ev: TranscriptEvent;
  highlighted: boolean;
  nested: boolean;
  fresh?: boolean;
}) {
  const collapsedByDefault =
    ev.event_type === "reasoning" ||
    ev.event_type === "tool_call" ||
    ev.event_type === "tool_response" ||
    ev.event_type === "system" ||
    ev.event_type === "runtime" ||
    ev.event_type === "unknown";
  const [open, setOpen] = useState(!collapsedByDefault);
  const [showRaw, setShowRaw] = useState(false);
  const accent = eventAccent(ev.event_type);
  const dim = ev.event_type === "system" || ev.event_type === "runtime" || ev.event_type === "unknown";
  const isTool = ev.event_type === "tool_call" || ev.event_type === "tool_response";
  const preview = useMemo(() => firstLines(ev.text, TOOL_PREVIEW_LINES), [ev.text]);

  const label = isTool
    ? `${ev.event_type === "tool_call" ? "→" : "←"} ${ev.name || "tool"}`
    : ev.event_type;

  return (
    <div
      id={`event-${ev.event_order}`}
      style={{
        borderLeft: `2px solid ${ev.event_type === "user_input" ? "var(--model-clay)" : "transparent"}`,
        background: highlighted
          ? "rgba(242,179,76,0.10)"
          : isTool
            ? "rgba(158,219,211,0.04)"
            : ev.event_type === "reasoning"
              ? "rgba(167,139,250,0.04)"
              : "transparent",
        borderRadius: 4,
        padding: nested ? "6px 10px 6px 8px" : "8px 12px 8px 10px",
        opacity: dim ? 0.55 : 1,
        margin: "2px 0",
        animation: fresh ? "live-fresh 2s var(--ease)" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--ink-muted)", minWidth: 42 }}>
          #{ev.event_order}
        </span>
        <span className="mono" style={{ fontSize: 11, color: accent, fontWeight: 600 }}>
          {ev.event_type === "compaction" ? "◆ compaction" : label}
        </span>
        {ev.call_id && (
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-muted)" }}>
            {ev.call_id.slice(0, 12)}
          </span>
        )}
        <span className="mono" style={{ fontSize: 10, color: "var(--ink-muted)" }}>
          {ev.event_time.slice(11, 19)}
        </span>
        {ev.tokens > 0 && (
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-muted)" }}>
            {fmtInt(ev.tokens)} tok
          </span>
        )}
        <span style={{ flex: 1 }} />
        {collapsedByDefault && (ev.text || ev.payload_json) && (
          <button onClick={() => setOpen(!open)} style={{ ...btnStyle, marginTop: 0 }}>
            {open ? "collapse" : "expand"}
          </button>
        )}
        {ev.payload_json && (
          <button
            onClick={() => setShowRaw(!showRaw)}
            style={{ ...btnStyle, marginTop: 0, color: showRaw ? "var(--model-amber)" : "var(--ink-muted)" }}
          >
            raw
          </button>
        )}
      </div>

      {ev.text && (
        <div style={{ marginTop: 4, color: ev.event_type === "reasoning" ? "var(--model-violet)" : dim ? "var(--ink-muted)" : "var(--ink)" }}>
          {open ? (
            <LongText text={ev.text} truncated={ev.text_truncated === 1} />
          ) : (
            <pre className="mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, fontSize: 12, lineHeight: 1.55, color: "var(--ink-muted)" }}>
              {preview.head}
              {(preview.more || ev.text.length > preview.head.length) && " …"}
            </pre>
          )}
        </div>
      )}

      {showRaw && (
        <div style={{ marginTop: 6 }}>
          <pre
            className="mono"
            style={{
              margin: 0,
              fontSize: 11,
              lineHeight: 1.5,
              maxHeight: 320,
              overflow: "auto",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid var(--rule)",
              borderRadius: 4,
              padding: 8,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              color: "var(--ink-muted)",
            }}
          >
            {ev.payload_json}
          </pre>
          {ev.payload_truncated === 1 && (
            <span className="mono" style={{ fontSize: 10, color: "var(--model-amber)" }}>
              payload truncated at 20,000 chars
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- substream group ----------

function SubstreamGroup({
  runId,
  label,
  events,
  highlightOrder,
  freshOrders,
}: {
  runId: string;
  label: string;
  events: TranscriptEvent[];
  highlightOrder: number | null;
  freshOrders: ReadonlySet<number>;
}) {
  const containsHighlight = highlightOrder !== null && events.some((e) => e.event_order === highlightOrder);
  const [open, setOpen] = useState(events.length <= GROUP_AUTOCOLLAPSE || containsHighlight);
  return (
    <div style={{ margin: "6px 0 6px 0" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          ...btnStyle,
          marginTop: 0,
          display: "block",
          width: "100%",
          textAlign: "left",
          borderColor: "rgba(167,139,250,0.35)",
          color: "var(--model-violet)",
          padding: "5px 10px",
        }}
      >
        {open ? "▾" : "▸"} subagent: {label || "unlabeled"} · run {runId.slice(0, 8)}… · {events.length} events
      </button>
      {open && (
        <div style={{ marginLeft: 18, borderLeft: "2px solid rgba(167,139,250,0.35)", paddingLeft: 8 }}>
          {events.map((e) => (
            <EventCard key={e.event_order} ev={e} nested highlighted={e.event_order === highlightOrder} fresh={freshOrders.has(e.event_order)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- stream assembly ----------

type StreamItem =
  | { kind: "event"; ev: TranscriptEvent }
  | { kind: "turn"; turn: number }
  | { kind: "group"; runId: string; label: string; events: TranscriptEvent[] };

function buildStream(events: TranscriptEvent[]): StreamItem[] {
  const items: StreamItem[] = [];
  let lastTurn = -1;
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.turn_seq !== lastTurn) {
      items.push({ kind: "turn", turn: ev.turn_seq });
      lastTurn = ev.turn_seq;
    }
    if (ev.is_substream === 1 && ev.agent_run_id) {
      // consecutive events of the same agent_run_id group together
      const group: TranscriptEvent[] = [];
      const run = ev.agent_run_id;
      while (i < events.length && events[i].is_substream === 1 && events[i].agent_run_id === run) {
        group.push(events[i]);
        i++;
      }
      items.push({ kind: "group", runId: run, label: group.find((g) => g.agent_label)?.agent_label ?? "", events: group });
    } else {
      items.push({ kind: "event", ev });
      i++;
    }
  }
  return items;
}

// ---------- chips ----------

function Chip({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 10,
        border: "1px solid var(--rule)",
        borderRadius: 999,
        padding: "2px 10px",
        color: color ?? "var(--ink-muted)",
      }}
    >
      {children}
    </span>
  );
}

// ---------- main pane ----------

export default function TranscriptPane({
  sessionId,
  onBack,
  initialEvent = null,
}: {
  sessionId: string;
  onBack: () => void;
  initialEvent?: number | null;
}) {
  const [session, setSession] = useState<SessionMeta | null>(null);
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrolledRef = useRef(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // live tailing state
  const [lastEventMs, setLastEventMs] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [freshOrders, setFreshOrders] = useState<ReadonlySet<number>>(new Set());
  const [following, setFollowing] = useState(true);
  const eventsRef = useRef<TranscriptEvent[]>([]);
  const followingRef = useRef(true);
  const appendedRef = useRef(false);
  const pollBusyRef = useRef(false);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  const nearBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return true;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - FOLLOW_SLACK_PX;
  }, []);

  const loadPage = useCallback(
    async (cursor: number) => {
      setLoading(true);
      setError(null);
      try {
        const page: TranscriptPage = await fetchTranscript(sessionId, cursor, 500);
        setSession(page.session);
        setEvents((prev) => (cursor === 0 ? page.events : [...prev, ...page.events]));
        setNextCursor(page.nextCursor);
        if (page.lastEventAgoS != null) setLastEventMs(Date.now() - page.lastEventAgoS * 1000);
        else if (page.lastEventTime) setLastEventMs(parseChTime(page.lastEventTime));
        setNow(Date.now());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    // reset when the pane is pointed at another session
    scrolledRef.current = false;
    setSession(null);
    setEvents([]);
    setNextCursor(null);
    setLastEventMs(null);
    setFreshOrders(new Set());
    void loadPage(0);
  }, [loadPage]);

  // ---- live tail polling ----
  const isLive = lastEventMs !== null && now - lastEventMs < LIVE_WINDOW_MS;

  const poll = useCallback(async () => {
    // don't burn ClickHouse queries in background windows
    if (document.visibilityState !== "visible") return;
    if (pollBusyRef.current) return;
    pollBusyRef.current = true;
    try {
      const loaded = eventsRef.current;
      const cursor = loaded.length ? loaded[loaded.length - 1].event_order : 0;
      const page: TranscriptPage = await fetchTranscript(sessionId, cursor, 500);
      setSession(page.session);
      setNextCursor(page.nextCursor);
      if (page.lastEventAgoS != null) setLastEventMs(Date.now() - page.lastEventAgoS * 1000);
      else if (page.lastEventTime) setLastEventMs(parseChTime(page.lastEventTime));
      setNow(Date.now());
      const have = new Set(loaded.map((e) => e.event_order));
      const fresh = page.events.filter((e) => !have.has(e.event_order));
      if (fresh.length) {
        appendedRef.current = true;
        // snapshot "near bottom" BEFORE the new events render (the scroll
        // listener alone goes stale when content grows under a user who
        // never scrolled)
        followingRef.current = nearBottom();
        setFollowing(followingRef.current);
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.event_order));
          return [...prev, ...fresh.filter((e) => !seen.has(e.event_order))];
        });
        const orders = fresh.map((e) => e.event_order);
        setFreshOrders((prev) => new Set([...prev, ...orders]));
        window.setTimeout(() => {
          setFreshOrders((prev) => {
            const next = new Set(prev);
            for (const o of orders) next.delete(o);
            return next;
          });
        }, FRESH_FADE_MS);
      }
    } catch {
      // transient poll failures are silent; next tick retries
    } finally {
      pollBusyRef.current = false;
    }
  }, [sessionId, nearBottom]);

  useEffect(() => {
    // 5s cadence while live, 30s idle heartbeat so a woken session flips back
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void poll();
    }, isLive ? LIVE_POLL_MS : IDLE_POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [isLive, poll]);

  // ---- follow mode (against the pane's own scroll container) ----
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const nb = nearBottom();
      followingRef.current = nb;
      setFollowing(nb);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [nearBottom]);

  useEffect(() => {
    if (!appendedRef.current) return;
    appendedRef.current = false;
    const el = scrollerRef.current;
    if (followingRef.current && el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [events]);

  const jumpToLive = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const idleMinutes = lastEventMs !== null ? Math.max(1, Math.floor((now - lastEventMs) / 60_000)) : null;

  // deep link: scroll to and highlight ?event=<event_order> once it exists
  useEffect(() => {
    if (initialEvent === null || scrolledRef.current) return;
    const el = document.getElementById(`event-${initialEvent}`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      scrolledRef.current = true;
    } else if (nextCursor !== null && !loading && events.length > 0 && events[events.length - 1].event_order < initialEvent) {
      void loadPage(nextCursor);
    }
  }, [initialEvent, events, nextCursor, loading, loadPage]);

  const stream = useMemo(() => buildStream(events), [events]);

  return (
    <div
      ref={scrollerRef}
      style={{ position: "relative", flex: 1, minHeight: 0, overflowY: "auto" }}
    >
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 20px 80px" }}>
        <style>{`@keyframes live-fresh { from { background-color: rgba(110,231,160,0.08); } to { background-color: transparent; } }`}</style>
        {/* header */}
        <header style={{ borderBottom: "1px solid var(--rule)", paddingBottom: 16, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <button
              onClick={onBack}
              className="mono"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                fontSize: 11,
                color: "var(--model-mint)",
                cursor: "pointer",
              }}
            >
              ← timeline
            </button>
            <h1 className="mono" style={{ fontSize: 15, margin: 0, color: "var(--ink-bright)" }}>
              {session?.title || "untitled session"}
            </h1>
            {isLive ? (
              <span className="mono breath" style={{ fontSize: 11, color: "#6ee7a0" }}>● live</span>
            ) : idleMinutes !== null ? (
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                idle · last event {idleMinutes}m ago
              </span>
            ) : null}
          </div>
          <div className="mono" style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 4, wordBreak: "break-all" }}>
            {sessionId}
          </div>
          {session && (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                <Chip color="var(--model-clay)">{session.harness || "unknown harness"}</Chip>
                <Chip>{session.mode}</Chip>
                {session.models.map((m) => (
                  <Chip key={m} color="var(--model-mint)">{m}</Chip>
                ))}
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 10 }}>
                {fmtInt(session.turns)} turns · {fmtInt(session.events)} events · {fmtInt(session.totalTokens)} tokens ·{" "}
                {fmtDuration(session.firstEventTime, session.lastEventTime)}
              </div>
            </>
          )}
        </header>

        {error && (
          <div className="mono" style={{ color: "var(--model-amber)", fontSize: 12, padding: 12, border: "1px solid var(--rule)", borderRadius: 6 }}>
            {error}
          </div>
        )}

        {/* stream */}
        {stream.map((item, idx) => {
          if (item.kind === "turn") {
            return (
              <div key={`t-${item.turn}-${idx}`} style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0 6px" }}>
                <span className="mono" style={{ fontSize: 10, color: "var(--ink-muted)" }}>T{item.turn}</span>
                <div style={{ flex: 1, borderTop: "1px solid var(--rule)" }} />
              </div>
            );
          }
          if (item.kind === "group") {
            return (
              <SubstreamGroup
                key={`g-${item.runId}-${item.events[0].event_order}`}
                runId={item.runId}
                label={item.label}
                events={item.events}
                highlightOrder={initialEvent}
                freshOrders={freshOrders}
              />
            );
          }
          return (
            <EventCard
              key={item.ev.event_order}
              ev={item.ev}
              nested={false}
              highlighted={item.ev.event_order === initialEvent}
              fresh={freshOrders.has(item.ev.event_order)}
            />
          );
        })}

        {/* follow-mode pill */}
        {isLive && !following && (
          <button
            onClick={jumpToLive}
            className="mono"
            style={{
              position: "fixed",
              bottom: 24,
              right: 24,
              zIndex: 20,
              background: "var(--paper, #111)",
              border: "1px solid rgba(110,231,160,0.4)",
              borderRadius: 999,
              color: "#6ee7a0",
              fontSize: 11,
              padding: "6px 14px",
              cursor: "pointer",
              boxShadow: "0 2px 12px rgba(0,0,0,0.35)",
            }}
          >
            ↓ following off — jump to live
          </button>
        )}

        {/* pagination */}
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 12 }}>
          {session && (
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
              showing {fmtInt(events.length)} of {fmtInt(session.events)}
            </span>
          )}
          {loading && (
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>loading…</span>
          )}
          {nextCursor !== null && !loading && (
            <button onClick={() => void loadPage(nextCursor)} style={{ ...btnStyle, marginTop: 0, padding: "6px 16px", fontSize: 11 }}>
              load more
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
