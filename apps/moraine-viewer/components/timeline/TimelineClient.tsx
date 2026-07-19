"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TimelineScene, { type LaneLayout } from "./TimelineScene";
import TracePreview from "./TracePreview";
import {
  DAY,
  FALLBACK_COLOR,
  HARNESS_COLORS,
  LANE_ORDER,
  harnessColor,
  hashJitter,
  type SearchPayload,
  type SearchResult,
  type SessionDetail,
  type TimelinePayload,
  type TimelinePoint,
  type TimelineSession,
  type ViewState,
} from "./types";

const MIN_PX_PER_DAY = 1.5;
const MIN_LANE_FRACTION = 0.05; // lanes under 5% of all sessions start collapsed
const MAX_PX_PER_DAY = 900;
const AXIS_H = 36; // px reserved for the date axis

function fmtDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}
function fmtDateTime(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ");
}

type Tick = { x: number; label: string; major: boolean };

// adaptive mono date axis: months → weeks → days by px/day (river's approach)
function computeTicks(view: ViewState, day0: number, width: number): Tick[] {
  const ticks: Tick[] = [];
  const dayAt = (px: number) => (px - view.offsetPx) / view.pxPerDay;
  const firstDay = Math.floor(dayAt(0));
  const lastDay = Math.ceil(dayAt(width));
  const p = view.pxPerDay;

  if (p >= 24) {
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
    for (let d = firstDay; d <= lastDay; d++) {
      const t = new Date((day0 + d * DAY) * 1000);
      if (t.getUTCDate() === 1) {
        ticks.push({
          x: view.offsetPx + d * p,
          label: t.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }),
          major: true,
        });
      }
    }
  }
  return ticks.filter((t) => t.x >= -60 && t.x <= width + 60);
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

type HoverInfo = { point: TimelinePoint; clientX: number; clientY: number };

export default function TimelineClient() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<TimelinePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 700 });
  const [view, setView] = useState<ViewState>({ offsetPx: 40, pxPerDay: 12 });
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [selected, setSelected] = useState<TimelineSession | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [hiddenHarness, setHiddenHarness] = useState<Set<string>>(new Set());

  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchPayload | null>(null);
  const [searching, setSearching] = useState(false);

  const dragRef = useRef<{ x: number; offset: number; moved: boolean } | null>(null);
  const cancelAnimRef = useRef<() => void>(() => {});
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    fetch("/api/timeline")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`api/timeline ${r.status}`))))
      .then((d: TimelinePayload) => setData(d))
      .catch((e) => setError(String(e)));
  }, []);

  // harnesses: canonical order first, then any strays from the data
  const allHarnesses = useMemo(() => {
    const seen = new Set(data?.meta.harnesses ?? []);
    const out = LANE_ORDER.filter((h) => seen.has(h));
    for (const h of seen) if (!out.includes(h)) out.push(h);
    return out;
  }, [data]);

  const harnessCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of data?.sessions ?? []) counts.set(s.harness, (counts.get(s.harness) ?? 0) + 1);
    return counts;
  }, [data]);

  // sparse lanes start hidden so the field isn't mostly empty rows; the chips
  // still show them (with counts) and one click brings the lane back
  const autoHidden = useRef(false);
  useEffect(() => {
    if (autoHidden.current || !data) return;
    autoHidden.current = true;
    const minSessions = (data.sessions.length || 1) * MIN_LANE_FRACTION;
    const sparse = allHarnesses.filter((h) => (harnessCounts.get(h) ?? 0) < minSessions);
    if (sparse.length) setHiddenHarness(new Set(sparse));
  }, [data, allHarnesses, harnessCounts]);

  // only visible harnesses get a lane row — hiding collapses the row entirely
  const lanesList = useMemo(
    () => allHarnesses.filter((h) => !hiddenHarness.has(h)),
    [allHarnesses, hiddenHarness],
  );

  const day0 = useMemo(() => {
    if (!data || data.sessions.length === 0) return 0;
    const min = Math.min(...data.sessions.map((s) => s.start));
    return Math.floor(min / DAY) * DAY;
  }, [data]);

  const points = useMemo<TimelinePoint[]>(() => {
    if (!data) return [];
    const laneIdx = new Map(lanesList.map((h, i) => [h, i]));
    return data.sessions.map((s) => {
      const mid = (s.start + s.end) / 2;
      return {
        s,
        day: (mid - day0) / DAY,
        dayStart: (s.start - day0) / DAY,
        dayEnd: (s.end - day0) / DAY,
        lane: laneIdx.get(s.harness) ?? lanesList.length - 1,
        jitter: hashJitter(s.id, 7),
        size: 2.4 + 2.1 * Math.log1p(s.events) * 0.45, // ∝ log(total_events)
        };
    });
  }, [data, lanesList, day0]);

  const numDays = useMemo(
    () => (points.length ? Math.max(...points.map((p) => p.dayEnd)) + 1 : 1),
    [points],
  );

  // fit the whole range (first load + reset button)
  const fitAll = useCallback(() => {
    if (!points.length || !wrapRef.current) return;
    const w = wrapRef.current.clientWidth;
    const p = Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, (w - 160) / Math.max(numDays, 1)));
    setView({ offsetPx: 120, pxPerDay: p });
  }, [points.length, numDays]);

  useEffect(() => {
    fitAll();
  }, [fitAll]);

  const fitView = useMemo(() => {
    const w = size.width;
    return {
      offsetPx: 120,
      pxPerDay: Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, (w - 160) / Math.max(numDays, 1))),
    };
  }, [size.width, numDays]);
  const isFit =
    Math.abs(view.pxPerDay - fitView.pxPerDay) < 0.01 && Math.abs(view.offsetPx - fitView.offsetPx) < 1;

  // resize observer
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // wheel zoom around cursor (non-passive so we can preventDefault)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimRef.current();
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

  // debounced search
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearch(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      fetch(`/api/timeline/search?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
        .then((d: SearchPayload) => {
          setSearch(d);
          setSearching(false);
        })
        .catch(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const matches = useMemo(() => (search ? new Set(search.ids) : null), [search]);

  // lane pixel layout (shared between shader uniforms, labels, and picking)
  const laneLayout = useMemo<LaneLayout>(() => {
    const top = 12;
    const usable = Math.max(1, size.height - AXIS_H - top - 8);
    const gap = usable / Math.max(1, lanesList.length);
    return { top, gap, jitterAmp: gap * 0.3 };
  }, [size.height, lanesList.length]);

  const laneY = useCallback(
    (lane: number, jitter = 0) =>
      laneLayout.top + (lane + 0.5) * laneLayout.gap + jitter * laneLayout.jitterAmp,
    [laneLayout],
  );
  const dayX = useCallback((day: number) => view.offsetPx + day * view.pxPerDay, [view]);

  // nearest visible point in screen space (Points raycast thresholds are awkward)
  const nearest = useCallback(
    (clientX: number, clientY: number): TimelinePoint | null => {
      const el = wrapRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      let best: TimelinePoint | null = null;
      let bestDist = 11;
      for (const p of points) {
        if (hiddenHarness.has(p.s.harness)) continue;
        const d = Math.hypot(dayX(p.day) - px, laneY(p.lane, p.jitter) - py);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      return best;
    },
    [points, hiddenHarness, dayX, laneY],
  );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    cancelAnimRef.current();
    dragRef.current = { x: e.clientX, offset: viewRef.current.offsetPx, moved: false };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragRef.current) {
        const dx = e.clientX - dragRef.current.x;
        if (Math.abs(dx) > 3) dragRef.current.moved = true;
        setView({ ...viewRef.current, offsetPx: dragRef.current.offset + dx });
        setHover(null);
        return;
      }
      const p = nearest(e.clientX, e.clientY);
      setHover(p ? { point: p, clientX: e.clientX, clientY: e.clientY } : null);
    },
    [nearest],
  );
  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const wasDrag = dragRef.current?.moved;
      dragRef.current = null;
      if (wasDrag) return;
      const p = nearest(e.clientX, e.clientY);
      if (p) flyToPointRef.current(p);
      else setSelected(null);
    },
    [nearest],
  );
  // defined below (needs animateTo); called through a ref to keep handler order simple
  const flyToPointRef = useRef<(p: TimelinePoint) => void>(() => {});
  const onPointerLeave = useCallback(() => {
    dragRef.current = null;
    setHover(null);
  }, []);

  // detail fetch on select
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let stale = false;
    setDetail(null);
    fetch(`/api/timeline?session=${encodeURIComponent(selected.id)}`)
      .then((r) => r.json())
      .then((d: { session?: SessionDetail }) => {
        if (!stale) setDetail(d.session ?? null);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [selected]);

  // animated camera move: zoom in log-space, converge the screen-center day
  const animRef = useRef<number | null>(null);
  const cancelAnim = useCallback(() => {
    if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    animRef.current = null;
  }, []);
  cancelAnimRef.current = cancelAnim;
  useEffect(() => cancelAnim, [cancelAnim]);

  const animateTo = useCallback(
    (target: ViewState) => {
      cancelAnim();
      const from = viewRef.current;
      const w = size.width;
      const centerFrom = (w / 2 - from.offsetPx) / from.pxPerDay;
      const centerTo = (w / 2 - target.offsetPx) / target.pxPerDay;
      const t0 = performance.now();
      const dur = 600;
      const ease = (t: number) => 1 - Math.pow(1 - t, 3);
      const step = (now: number) => {
        const k = ease(Math.min(1, (now - t0) / dur));
        const px = from.pxPerDay * Math.pow(target.pxPerDay / from.pxPerDay, k);
        const center = centerFrom + (centerTo - centerFrom) * k;
        setView({ pxPerDay: px, offsetPx: w / 2 - center * px });
        if (k < 1) animRef.current = requestAnimationFrame(step);
        else animRef.current = null;
      };
      animRef.current = requestAnimationFrame(step);
    },
    [cancelAnim, size.width],
  );

  // zoom onto a session's dot + select it (dot clicks and search results)
  const flyToPoint = useCallback(
    (p: TimelinePoint) => {
      const pxPerDay = Math.min(MAX_PX_PER_DAY, Math.max(viewRef.current.pxPerDay, 48));
      animateTo({ pxPerDay, offsetPx: size.width / 2 - p.day * pxPerDay });
      setSelected(p.s);
    },
    [animateTo, size.width],
  );

  flyToPointRef.current = flyToPoint;

  const flyTo = useCallback(
    (r: SearchResult) => {
      const p = points.find((pt) => pt.s.id === r.id);
      if (p) flyToPoint(p);
    },
    [points, flyToPoint],
  );

  const toggleHarness = useCallback((h: string) => {
    setHiddenHarness((prev) => {
      const next = new Set(prev);
      if (next.has(h)) next.delete(h);
      else next.add(h);
      return next;
    });
  }, []);

  const ticks = useMemo(
    () => (points.length ? computeTicks(view, day0, size.width) : []),
    [points.length, view, day0, size.width],
  );

  const visibleCount = useMemo(
    () => points.filter((p) => !hiddenHarness.has(p.s.harness)).length,
    [points, hiddenHarness],
  );

  const selectedPoint = selected ? points.find((p) => p.s.id === selected.id) : null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* filter chips */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-3 border-b border-rule">
        <span className="mono text-[11px] text-ink-muted mr-1">harness</span>
        {allHarnesses.map((h) => (
          <Chip
            key={h}
            label={`${h} · ${harnessCounts.get(h) ?? 0}`}
            color={HARNESS_COLORS[h] ?? FALLBACK_COLOR}
            active={!hiddenHarness.has(h)}
            onClick={() => toggleHarness(h)}
          />
        ))}
        <span className="mono text-[11px] text-ink-muted ml-auto">
          {visibleCount}/{data?.meta.count ?? "…"} sessions
        </span>
      </div>

      {/* field */}
      <div className="relative flex-1 min-h-0 flex">
        <div
          ref={wrapRef}
          className="relative flex-1 min-w-0 cursor-grab active:cursor-grabbing overflow-hidden"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
        >
          {/* faint lane rules + thin mono lane labels */}
          {points.length > 0 &&
            lanesList.map((h, i) => (
              <div key={h}>
                <div
                  className="pointer-events-none absolute left-0 right-0 h-px"
                  style={{ top: laneY(i), background: "rgba(255,255,255,0.05)" }}
                />
                <div
                  className="mono pointer-events-none absolute left-3 -translate-y-1/2 text-[10px] tracking-wide"
                  style={{
                    top: laneY(i),
                    color: hiddenHarness.has(h)
                      ? "rgba(155,157,163,0.3)"
                      : (HARNESS_COLORS[h] ?? FALLBACK_COLOR),
                    opacity: 0.75,
                  }}
                >
                  {h}
                </div>
              </div>
            ))}

          {points.length > 0 && (
            <TimelineScene
              points={points}
              view={view}
              width={size.width}
              height={size.height}
              lanes={laneLayout}
              matches={matches}
              hiddenHarness={hiddenHarness}
            />
          )}
          {!data && !error && (
            <div className="mono breath flex h-full items-center justify-center text-xs text-ink-muted">
              reading the moraine…
            </div>
          )}
          {error && (
            <div className="mono flex h-full items-center justify-center text-xs text-[#f85149]">
              couldn&apos;t reach clickhouse — {error}
            </div>
          )}

          {/* selection ring */}
          {selectedPoint && !hiddenHarness.has(selectedPoint.s.harness) && (
            <div
              className="pointer-events-none absolute breath rounded-full border"
              style={{
                left: dayX(selectedPoint.day) - 9,
                top: laneY(selectedPoint.lane, selectedPoint.jitter) - 9,
                width: 18,
                height: 18,
                borderColor: harnessColor(selectedPoint.s.harness),
              }}
            />
          )}

          {/* reset view */}
          {!isFit && (
            <button
              onClick={fitAll}
              onPointerDown={(e) => e.stopPropagation()}
              className="mono absolute right-4 top-3 z-20 rounded-[8px] border border-rule bg-window/90 px-3 py-1.5 text-[11px] text-ink-muted backdrop-blur transition-colors hover:bg-hover hover:text-ink-bright"
            >
              ⤢ reset view
            </button>
          )}

          {/* search overlay */}
          <div className="absolute left-4 top-3 z-20 w-[300px]" onPointerDown={(e) => e.stopPropagation()}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search your history…"
              spellCheck={false}
              className="mono w-full rounded-[8px] border border-rule bg-window/90 px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-muted/60 outline-none focus:border-ink-muted/50 backdrop-blur"
            />
            {search && (
              <div className="mono mt-1.5 text-[10px] text-ink-muted">
                {searching ? "searching…" : `${search.count} match${search.count === 1 ? "" : "es"}`}
              </div>
            )}
            {search && search.results.length > 0 && (
              <div className="mt-1.5 max-h-[42vh] overflow-y-auto rounded-[8px] border border-rule bg-window/90 backdrop-blur">
                {search.results.map((r) => {
                  const s = points.find((p) => p.s.id === r.id)?.s;
                  return (
                    <button
                      key={r.id}
                      onClick={() => flyTo(r)}
                      className="block w-full border-b border-rule px-3 py-2 text-left last:border-b-0 hover:bg-hover transition-colors"
                    >
                      <div className="mono flex items-center gap-2 text-[10px]">
                        <span
                          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: s ? harnessColor(s.harness) : FALLBACK_COLOR }}
                        />
                        <span className="truncate text-ink-bright">
                          {s?.title || r.id.slice(0, 18)}
                        </span>
                        {s && <span className="ml-auto shrink-0 text-ink-muted">{fmtDate(s.start)}</span>}
                      </div>
                      <div className="mono mt-0.5 truncate text-[10px] text-ink-muted">{r.snippet}</div>
                    </button>
                  );
                })}
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

          {/* hint */}
          <div className="mono pointer-events-none absolute bottom-12 left-4 z-10 text-[10px] text-ink-muted/70">
            drag to pan · wheel to zoom time · hover points · click for detail
          </div>
        </div>

        {/* hover tooltip */}
        {hover && (
          <div
            className="mono pointer-events-none fixed z-50 max-w-xs rounded-lg border border-rule px-3 py-2 text-[11px] leading-relaxed"
            style={{
              left: hover.clientX + 14,
              top: hover.clientY + 14,
              background: "rgba(11,12,14,0.92)",
            }}
          >
            <div className="truncate text-ink-bright">
              {hover.point.s.title || hover.point.s.id.slice(0, 18)}
            </div>
            <div className="text-ink-muted">
              <span style={{ color: harnessColor(hover.point.s.harness) }}>{hover.point.s.harness}</span>
              {" · "}
              {fmtDate(hover.point.s.start)}
            </div>
            <div className="text-ink-muted">
              {hover.point.s.events.toLocaleString()} events · {hover.point.s.turns} turns
            </div>
          </div>
        )}

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
              <dd style={{ color: harnessColor(selected.harness) }}>{selected.harness}</dd>
              <dt className="text-ink-muted">mode</dt>
              <dd>{selected.mode}</dd>
              <dt className="text-ink-muted">turns</dt>
              <dd>{selected.turns}</dd>
              <dt className="text-ink-muted">events</dt>
              <dd>{selected.events.toLocaleString()}</dd>
              {detail && (
                <>
                  <dt className="text-ink-muted">tool calls</dt>
                  <dd>{detail.tool_calls}</dd>
                </>
              )}
              <dt className="text-ink-muted">span</dt>
              <dd>
                {fmtDateTime(selected.start)} → {fmtDateTime(selected.end)}
              </dd>
              {detail?.origin_cwd && (
                <>
                  <dt className="text-ink-muted">cwd</dt>
                  <dd className="break-all">{detail.origin_cwd}</dd>
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

            <div className="mt-5">
              <div className="mono text-[11px] text-ink-muted mb-1.5">trace</div>
              <TracePreview sessionId={selected.id} />
            </div>

            <div className="mt-5">
              <a
                href={`/anatomy?session=${encodeURIComponent(selected.id)}`}
                className="mono text-[11px] text-ink-muted underline decoration-rule underline-offset-4 hover:text-ink-bright transition-colors"
              >
                open in anatomy →
              </a>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
