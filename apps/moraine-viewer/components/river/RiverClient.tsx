"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import RiverScene, { HoverInfo } from "./RiverScene";
import { buildRiver } from "./buildRiver";
import {
  RiverPayload,
  SessionDetail,
  SessionMark,
  ViewState,
  DAY,
  harnessColor,
} from "./types";

const MIN_PX_PER_DAY = 1.5;
const MAX_PX_PER_DAY = 900;

function fmtDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}
function fmtDateTime(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ");
}

type Tick = { x: number; label: string; major: boolean };

function computeTicks(view: ViewState, day0: number, width: number): Tick[] {
  const ticks: Tick[] = [];
  const dayAt = (px: number) => (px - view.offsetPx) / view.pxPerDay;
  const firstDay = Math.floor(dayAt(0));
  const lastDay = Math.ceil(dayAt(width));
  const p = view.pxPerDay;

  if (p >= 24) {
    // day ticks
    for (let d = firstDay; d <= lastDay; d++) {
      const t = new Date((day0 + d * DAY) * 1000);
      const dom = t.getUTCDate();
      ticks.push({
        x: view.offsetPx + d * p,
        label:
          dom === 1
            ? t.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })
            : String(dom).padStart(2, "0"),
        major: dom === 1,
      });
    }
  } else if (p >= 5) {
    // week ticks (Mondays), month labels on the 1st
    for (let d = firstDay; d <= lastDay; d++) {
      const t = new Date((day0 + d * DAY) * 1000);
      if (t.getUTCDate() === 1) {
        ticks.push({
          x: view.offsetPx + d * p,
          label: t.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
          major: true,
        });
      } else if (t.getUTCDay() === 1) {
        ticks.push({ x: view.offsetPx + d * p, label: String(t.getUTCDate()), major: false });
      }
    }
  } else {
    // month ticks only
    for (let d = firstDay; d <= lastDay; d++) {
      const t = new Date((day0 + d * DAY) * 1000);
      if (t.getUTCDate() === 1) {
        ticks.push({
          x: view.offsetPx + d * p,
          label: t.toLocaleDateString("en-US", {
            month: "short",
            year: "2-digit",
            timeZone: "UTC",
          }),
          major: true,
        });
      }
    }
  }
  return ticks.filter((t) => t.x >= -60 && t.x <= width + 60);
}

export default function RiverClient() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<RiverPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 700 });
  const [view, setView] = useState<ViewState>({ offsetPx: 40, pxPerDay: 12 });
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [selected, setSelected] = useState<SessionMark | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const dragRef = useRef<{ x: number; offset: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    fetch("/api/river")
      .then((r) => {
        if (!r.ok) throw new Error(`api/river ${r.status}`);
        return r.json();
      })
      .then((d: RiverPayload) => setData(d))
      .catch((e) => setError(String(e)));
  }, []);

  const river = useMemo(() => (data ? buildRiver(data.daily) : null), [data]);

  // fit whole range on first load
  useEffect(() => {
    if (!river || !wrapRef.current) return;
    const w = wrapRef.current.clientWidth;
    const p = Math.min(
      MAX_PX_PER_DAY,
      Math.max(MIN_PX_PER_DAY, (w - 80) / Math.max(river.numDays, 1))
    );
    setView({ offsetPx: 40, pxPerDay: p });
  }, [river]);

  // resize observer
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ width: el.clientWidth, height: el.clientHeight })
    );
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // wheel zoom (non-passive so we can preventDefault)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const v = viewRef.current;
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        const factor = Math.exp(-e.deltaY * 0.0016);
        const p = Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, v.pxPerDay * factor));
        const dayAtCursor = (cx - v.offsetPx) / v.pxPerDay;
        setView({ pxPerDay: p, offsetPx: cx - dayAtCursor * p });
      } else {
        setView({ ...v, offsetPx: v.offsetPx - e.deltaX });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, offset: viewRef.current.offsetPx };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    setView({ ...viewRef.current, offsetPx: dragRef.current.offset + dx });
  }, []);
  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onSelect = useCallback((s: SessionMark) => {
    setSelected(s);
    setDetail(null);
    setDetailLoading(true);
    fetch(`/api/river?session=${encodeURIComponent(s.id)}`)
      .then((r) => r.json())
      .then((d: { session?: SessionDetail }) => setDetail(d.session ?? null))
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }, []);

  const ticks = useMemo(
    () => (river ? computeTicks(view, river.day0, size.width) : []),
    [river, view, size.width]
  );

  const legend = useMemo(
    () =>
      river
        ? river.bands.map((b) => ({
            harness: b.harness,
            color: harnessColor(b.harness),
            total: b.totalEvents,
          }))
        : [],
    [river]
  );

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-field text-ink">
      {/* header */}
      <div className="pointer-events-none absolute left-5 top-4 z-20">
        <div className="mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">
          moraine / river
        </div>
        <div className="mt-1 text-sm text-ink-bright">
          history river — daily event flow per harness
        </div>
      </div>

      {/* legend */}
      <div className="pointer-events-none absolute right-5 top-4 z-20 flex flex-col gap-1">
        {legend.map((l) => (
          <div key={l.harness} className="mono flex items-center gap-2 text-[11px]">
            <span
              className="inline-block h-[3px] w-5 rounded-full"
              style={{ background: l.color }}
            />
            <span className="text-ink">{l.harness}</span>
            <span className="text-ink-muted">{l.total.toLocaleString()}</span>
          </div>
        ))}
      </div>

      {/* canvas */}
      <div
        ref={wrapRef}
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {river && (
          <Canvas
            orthographic
            camera={{ position: [0, 0, 100], zoom: 1, near: 0.1, far: 1000 }}
            gl={{ antialias: true, alpha: true }}
            style={{ background: "transparent" }}
          >
            <RiverScene
              river={river}
              sessions={data?.sessions ?? []}
              view={view}
              width={size.width}
              onHover={setHover}
              onLeave={() => setHover(null)}
              onSelect={onSelect}
              selectedId={selected?.id ?? null}
            />
          </Canvas>
        )}
        {!river && !error && (
          <div className="mono breath flex h-full items-center justify-center text-xs text-ink-muted">
            reading the moraine…
          </div>
        )}
        {error && (
          <div className="mono flex h-full items-center justify-center text-xs text-[#f85149]">
            {error}
          </div>
        )}
      </div>

      {/* date axis */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 h-9 border-t border-rule bg-field/70">
        {ticks.map((t, i) => (
          <div key={i} className="absolute bottom-0 h-9" style={{ left: t.x }}>
            <div
              className="absolute bottom-5 h-2 w-px"
              style={{ background: t.major ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.15)" }}
            />
            <div
              className={`mono absolute bottom-1 -translate-x-1/2 whitespace-nowrap text-[10px] ${
                t.major ? "text-ink" : "text-ink-muted"
              }`}
            >
              {t.label}
            </div>
          </div>
        ))}
      </div>

      {/* tooltip */}
      {hover && (
        <div
          className="mono pointer-events-none fixed z-30 max-w-xs rounded-[8px] border border-rule bg-card px-3 py-2 text-[11px] leading-relaxed shadow-xl"
          style={{
            left: Math.min(hover.clientX + 14, size.width - 280),
            top: hover.clientY + 14,
          }}
        >
          <div className="truncate text-ink-bright">
            {hover.session.title || hover.session.id.slice(0, 18)}
          </div>
          <div className="text-ink-muted">
            {fmtDate(hover.session.start)}
            {fmtDate(hover.session.end) !== fmtDate(hover.session.start)
              ? ` → ${fmtDate(hover.session.end)}`
              : ""}
          </div>
          <div className="flex gap-3">
            <span style={{ color: harnessColor(hover.session.harness) }}>
              {hover.session.harness}
            </span>
            <span className="text-ink">{hover.session.events.toLocaleString()} ev</span>
          </div>
          {hover.session.model && hover.session.model !== "unknown" && (
            <div className="text-ink-muted">{hover.session.model}</div>
          )}
        </div>
      )}

      {/* side panel */}
      {selected && (
        <div className="absolute bottom-12 right-4 top-16 z-20 w-[380px] overflow-y-auto rounded-[12px] border border-rule bg-card/95 p-4 backdrop-blur">
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm text-ink-bright">
              {selected.title || "untitled session"}
            </div>
            <button
              className="mono text-xs text-ink-muted hover:text-ink"
              onClick={() => setSelected(null)}
            >
              ✕
            </button>
          </div>
          <div className="mono mt-2 space-y-1 text-[11px] text-ink-muted">
            <div>
              <span style={{ color: harnessColor(selected.harness) }}>{selected.harness}</span>
              {selected.model && selected.model !== "unknown" ? ` · ${selected.model}` : ""}
            </div>
            <div>
              {fmtDateTime(selected.start)} → {fmtDateTime(selected.end)}
            </div>
            <div>{selected.events.toLocaleString()} events · {selected.mode}</div>
            <div className="truncate text-ink-muted/70">{selected.id}</div>
          </div>
          <div className="my-3 h-px bg-rule" />
          {detailLoading && (
            <div className="mono breath text-[11px] text-ink-muted">loading summary…</div>
          )}
          {detail && (
            <>
              <div className="mono mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-muted">
                <span>{detail.totalTurns} turns</span>
                <span>{detail.userMessages} user msgs</span>
                <span>{detail.toolCalls} tool calls</span>
              </div>
              {detail.cwd && (
                <div className="mono mb-2 truncate text-[10px] text-ink-muted/70">
                  {detail.cwd}
                </div>
              )}
              <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink">
                {detail.summary || "no session summary recorded."}
              </div>
            </>
          )}
          {!detailLoading && !detail && (
            <div className="mono text-[11px] text-ink-muted">no detail available.</div>
          )}
        </div>
      )}

      {/* hint */}
      <div className="mono pointer-events-none absolute bottom-12 left-5 z-10 text-[10px] text-ink-muted/70">
        drag to pan · wheel to zoom time · hover marks · click for summary
      </div>
    </div>
  );
}
