"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import type { EventRow, SessionDetail, SessionRow } from "./types";
import { COLORS } from "./layout";
import type { HoverInfo } from "./TraceScene";

const TraceScene = dynamic(() => import("./TraceScene"), { ssr: false });

const LEGEND: { label: string; color: string; dim?: boolean }[] = [
  { label: "user_input", color: COLORS.user_input },
  { label: "assistant_response", color: COLORS.assistant_response },
  { label: "reasoning", color: COLORS.reasoning },
  { label: "tool_call / tool_response", color: COLORS.tool_call },
  { label: "compaction", color: COLORS.compaction },
  { label: "system / runtime", color: COLORS.system, dim: true },
];

function fmtDuration(a: string, b: string): string {
  const ms = new Date(b.replace(" ", "T") + "Z").getTime() - new Date(a.replace(" ", "T") + "Z").getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function sessionLabel(s: SessionRow): string {
  return s.title.trim() || s.session_id.slice(0, 12);
}

export default function AnatomyClient() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [selected, setSelected] = useState<EventRow | null>(null);

  useEffect(() => {
    fetch("/api/anatomy/sessions")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setSessions(body.sessions);
        if (body.sessions.length) setSelectedId((cur) => cur ?? body.sessions[0].session_id);
      })
      .catch((e) => setListError(e.message));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let stale = false;
    setLoading(true);
    setDetailError(null);
    setSelected(null);
    setHover(null);
    fetch(`/api/anatomy/session?id=${encodeURIComponent(selectedId)}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        if (!stale) setDetail(body);
      })
      .catch((e) => {
        if (!stale) setDetailError(e.message);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [selectedId]);

  const onHover = useCallback((h: HoverInfo | null) => setHover(h), []);
  const onSelect = useCallback((e: EventRow) => setSelected(e), []);

  const s = detail?.session;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[var(--field)] text-[var(--ink)]">
      {/* left rail: session picker */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--rule)]">
        <div className="mono px-4 pb-2 pt-4 text-[11px] uppercase tracking-[0.2em] text-[var(--ink-muted)]">
          Trace anatomy
        </div>
        <div className="mono px-4 pb-3 text-[10px] text-[var(--ink-muted)]">
          recent sessions · claude-code / codex
        </div>
        <div className="flex-1 overflow-y-auto">
          {listError && <div className="mono px-4 py-2 text-[11px] text-[var(--state-bad)]">{listError}</div>}
          {sessions.map((row) => {
            const active = row.session_id === selectedId;
            return (
              <button
                key={row.session_id}
                onClick={() => setSelectedId(row.session_id)}
                className={`block w-full border-l-2 px-4 py-2 text-left transition-colors ${
                  active
                    ? "border-[var(--model-clay)] bg-[var(--hover)]"
                    : "border-transparent hover:bg-[var(--card)]"
                }`}
              >
                <div className="truncate text-[12px] text-[var(--ink)]">{sessionLabel(row)}</div>
                <div className="mono mt-0.5 text-[10px] text-[var(--ink-muted)]">
                  {row.harness} · {row.total_turns}t · {row.total_events}ev · {row.tool_calls} tools
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* main column */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* stats header */}
        <header className="flex items-baseline gap-6 border-b border-[var(--rule)] px-5 py-3">
          {s ? (
            <>
              <span className="truncate text-[13px] text-[var(--ink-bright)]">{sessionLabel(s)}</span>
              <Stat label="turns" value={String(s.total_turns)} />
              <Stat label="events" value={String(detail?.events.length ?? 0)} />
              <Stat label="tool calls" value={String(s.tool_calls)} />
              <Stat label="tokens" value={fmtTokens(detail?.totalTokens ?? 0)} />
              <Stat label="duration" value={fmtDuration(s.first_event_time, s.last_event_time)} />
              <Stat label="model" value={detail?.models.join(", ") || "—"} />
              {detail?.truncated && (
                <span className="mono text-[10px] text-[var(--state-warn)]">truncated @2000</span>
              )}
            </>
          ) : (
            <span className="mono text-[11px] text-[var(--ink-muted)]">select a session</span>
          )}
        </header>

        {/* canvas */}
        <div className="relative min-h-0 flex-1">
          {detail && !loading && (
            <TraceScene
              events={detail.events}
              selectedOrder={selected?.event_order ?? null}
              onHover={onHover}
              onSelect={onSelect}
            />
          )}
          {loading && (
            <div className="mono absolute inset-0 flex items-center justify-center text-[11px] text-[var(--ink-muted)]">
              dissecting…
            </div>
          )}
          {detailError && (
            <div className="mono absolute inset-0 flex items-center justify-center text-[11px] text-[var(--state-bad)]">
              {detailError}
            </div>
          )}

          {/* legend */}
          <div className="pointer-events-none absolute bottom-3 left-4 rounded-[var(--radius-control)] border border-[var(--rule)] bg-black/70 px-3 py-2">
            {LEGEND.map((l) => (
              <div key={l.label} className="mono flex items-center gap-2 py-0.5 text-[10px] text-[var(--ink-muted)]">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: l.color, opacity: l.dim ? 0.4 : 1 }}
                />
                {l.label}
              </div>
            ))}
            <div className="mono pt-1 text-[9px] text-[var(--ink-muted)] opacity-60">
              node size ∝ tokens · drag to pan · scroll to zoom
            </div>
          </div>

          {/* hover tooltip */}
          {hover && (
            <div
              className="mono pointer-events-none fixed z-50 max-w-sm rounded-[var(--radius-control)] border border-[var(--rule)] bg-black/90 px-3 py-2 text-[10px] leading-relaxed"
              style={{ left: hover.clientX + 14, top: hover.clientY + 14 }}
            >
              <div style={{ color: COLORS[hover.event.event_type] ?? "#9b9da3" }}>
                {hover.event.event_type}
                {hover.event.name ? ` · ${hover.event.name}` : ""}
              </div>
              <div className="text-[var(--ink-muted)]">
                turn {hover.event.turn_seq} · {hover.event.event_time}
                {hover.event.tokens > 0 ? ` · ${fmtTokens(hover.event.tokens)} tok` : ""}
              </div>
              {hover.event.preview && (
                <div className="mt-1 whitespace-pre-wrap break-words text-[var(--ink)] opacity-80">
                  {hover.event.preview.slice(0, 300)}
                  {hover.event.preview.length > 300 ? "…" : ""}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* side panel: full-ish content of clicked event */}
      {selected && (
        <aside className="flex w-96 shrink-0 flex-col border-l border-[var(--rule)] bg-[var(--window)]">
          <div className="flex items-center justify-between border-b border-[var(--rule)] px-4 py-3">
            <div className="mono text-[11px]" style={{ color: COLORS[selected.event_type] ?? "#9b9da3" }}>
              {selected.event_type}
              {selected.name ? ` · ${selected.name}` : ""}
            </div>
            <button
              onClick={() => setSelected(null)}
              className="mono text-[11px] text-[var(--ink-muted)] hover:text-[var(--ink)]"
            >
              ✕
            </button>
          </div>
          <div className="mono border-b border-[var(--rule)] px-4 py-2 text-[10px] text-[var(--ink-muted)]">
            #{selected.event_order} · turn {selected.turn_seq} · {selected.actor_role} · {selected.event_time}
            {selected.tokens > 0 && <> · {fmtTokens(selected.tokens)} tok</>}
            {selected.call_id && <> · call {selected.call_id.slice(0, 10)}</>}
          </div>
          <pre className="mono flex-1 overflow-y-auto whitespace-pre-wrap break-words px-4 py-3 text-[11px] leading-relaxed text-[var(--ink)]">
            {selected.preview || "(empty text_content)"}
            {selected.text_len > selected.preview.length && (
              <span className="text-[var(--ink-muted)]">
                {"\n\n"}… truncated ({fmtTokens(selected.text_len)} chars total)
              </span>
            )}
          </pre>
        </aside>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="mono whitespace-nowrap text-[11px] text-[var(--ink-muted)]">
      {label} <span className="text-[var(--ink)]">{value}</span>
    </span>
  );
}
