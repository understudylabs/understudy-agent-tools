"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import MapScene, { HARNESS_COLORS, FALLBACK_COLOR, type HoverInfo } from "./MapScene";
import type { MapPoint, MapMeta, SessionDetail } from "./types";

function fmtDate(dt: string): string {
  return dt ? dt.slice(0, 16) : "—";
}

function Chip({
  label,
  color,
  active,
  onClick,
}: {
  label: string;
  color?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="mono text-[11px] px-2.5 py-1 rounded-full border transition-colors"
      style={{
        borderColor: active ? (color ?? "var(--ink-muted)") : "var(--rule)",
        color: active ? "var(--ink-bright)" : "var(--ink-muted)",
        background: active && color ? `${color}1a` : "transparent",
        transitionTimingFunction: "var(--ease)",
      }}
    >
      {color && (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
          style={{ background: color, opacity: active ? 1 : 0.4 }}
        />
      )}
      {label}
    </button>
  );
}

export default function MapView() {
  const [points, setPoints] = useState<MapPoint[]>([]);
  const [meta, setMeta] = useState<MapMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [harnessFilter, setHarnessFilter] = useState<Set<string>>(new Set());
  const [modeFilter, setModeFilter] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [selected, setSelected] = useState<MapPoint | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);

  useEffect(() => {
    fetch("/api/map")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((d: { points: MapPoint[]; meta: MapMeta }) => {
        setPoints(d.points);
        setMeta(d.meta);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let stale = false;
    fetch(`/api/map?session=${encodeURIComponent(selected.id)}`)
      .then((r) => r.json())
      .then((d: { session: SessionDetail }) => {
        if (!stale) setDetail(d.session);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [selected]);

  const filtered = useMemo(
    () =>
      points.filter(
        (p) =>
          (harnessFilter.size === 0 || harnessFilter.has(p.harness)) &&
          (modeFilter.size === 0 || modeFilter.has(p.mode)),
      ),
    [points, harnessFilter, modeFilter],
  );

  const toggle = (set: Set<string>, v: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setter(next);
  };

  const onHover = useCallback((h: HoverInfo | null) => setHover(h), []);
  const onSelect = useCallback((p: MapPoint | null) => setSelected(p), []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* filter chips */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-3 border-b border-rule">
        <span className="mono text-[11px] text-ink-muted mr-1">harness</span>
        {(meta?.harnesses ?? []).map((h) => (
          <Chip
            key={h}
            label={h}
            color={HARNESS_COLORS[h] ?? FALLBACK_COLOR}
            active={harnessFilter.size === 0 || harnessFilter.has(h)}
            onClick={() => toggle(harnessFilter, h, setHarnessFilter)}
          />
        ))}
        <span className="mono text-[11px] text-ink-muted ml-4 mr-1">mode</span>
        {(meta?.modes ?? []).map((m) => (
          <Chip
            key={m}
            label={m}
            active={modeFilter.size === 0 || modeFilter.has(m)}
            onClick={() => toggle(modeFilter, m, setModeFilter)}
          />
        ))}
        <span className="mono text-[11px] text-ink-muted ml-auto">
          {filtered.length}/{meta?.count ?? "…"} sessions
        </span>
      </div>

      {/* canvas + panel */}
      <div className="relative flex-1 min-h-0 flex">
        <div className="relative flex-1 min-w-0">
          {error ? (
            <div className="mono text-xs text-ink-muted p-6">
              couldn&apos;t reach clickhouse — {error}
            </div>
          ) : (
            <MapScene
              points={filtered}
              selectedId={selected?.id ?? null}
              onHover={onHover}
              onSelect={onSelect}
            />
          )}

          {/* axis labels */}
          <div className="pointer-events-none absolute bottom-3 left-0 right-0 text-center mono text-[10px] text-ink-muted">
            x — activity scale (log events · log duration)
          </div>
          <div
            className="pointer-events-none absolute left-3 top-1/2 mono text-[10px] text-ink-muted"
            style={{ transform: "rotate(-90deg) translateX(50%)", transformOrigin: "left center" }}
          >
            y — tool-heaviness (tool ratio · log turns)
          </div>
          <div className="pointer-events-none absolute top-3 left-4 mono text-[10px] text-ink-muted breath">
            placeholder projection — embeddings land in Stage 2
          </div>

          {/* hover tooltip */}
          {hover && (
            <div
              className="pointer-events-none fixed z-50 mono text-[11px] leading-relaxed px-3 py-2 rounded-lg border border-rule"
              style={{
                left: hover.clientX + 14,
                top: hover.clientY + 14,
                background: "rgba(11,12,14,0.92)",
                maxWidth: 320,
              }}
            >
              <div className="text-ink-bright truncate">
                {hover.point.title || hover.point.id.slice(0, 8)}
              </div>
              <div className="text-ink-muted">
                <span style={{ color: HARNESS_COLORS[hover.point.harness] ?? FALLBACK_COLOR }}>
                  {hover.point.harness}
                </span>
                {" · "}
                {hover.point.turns} turns · {fmtDate(hover.point.date)}
              </div>
            </div>
          )}
        </div>

        {/* side panel */}
        {selected && (
          <aside className="w-[340px] shrink-0 border-l border-rule overflow-y-auto p-5 bg-window">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-sm text-ink-bright leading-snug">
                {selected.title || "untitled session"}
              </h2>
              <button
                onClick={() => setSelected(null)}
                className="mono text-xs text-ink-muted hover:text-ink-bright transition-colors"
                aria-label="close panel"
              >
                ×
              </button>
            </div>
            <div className="mono text-[11px] text-ink-muted mt-1 break-all">{selected.id}</div>

            <dl className="mono text-[11px] mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <dt className="text-ink-muted">harness</dt>
              <dd style={{ color: HARNESS_COLORS[selected.harness] ?? FALLBACK_COLOR }}>
                {selected.harness}
              </dd>
              <dt className="text-ink-muted">mode</dt>
              <dd>{selected.mode}</dd>
              <dt className="text-ink-muted">turns</dt>
              <dd>{selected.turns}</dd>
              <dt className="text-ink-muted">events</dt>
              <dd>{selected.events}</dd>
              <dt className="text-ink-muted">tool calls</dt>
              <dd>{selected.toolCalls}</dd>
              <dt className="text-ink-muted">first event</dt>
              <dd>{fmtDate(selected.date)}</dd>
              {detail && (
                <>
                  <dt className="text-ink-muted">last event</dt>
                  <dd>{fmtDate(detail.last_event_time)}</dd>
                  {detail.origin_cwd && (
                    <>
                      <dt className="text-ink-muted">cwd</dt>
                      <dd className="break-all">{detail.origin_cwd}</dd>
                    </>
                  )}
                </>
              )}
            </dl>

            <div className="mt-5">
              <div className="mono text-[11px] text-ink-muted mb-1.5">summary</div>
              {detail === null ? (
                <div className="mono text-[11px] text-ink-muted breath">loading…</div>
              ) : detail.session_summary ? (
                <p className="text-[13px] leading-relaxed text-ink whitespace-pre-wrap">
                  {detail.session_summary}
                </p>
              ) : (
                <div className="mono text-[11px] text-ink-muted">no summary projected</div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
