"use client";

// Timeline pane — the whole agent history as a temporal field of traces.
// Ported from the moraine-viewer prototype's TimelineClient; data flows
// through app/lib/exploreData.ts (Tauri invoke) instead of /api routes, and
// "open session" calls props.onOpenSession instead of navigating.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TimelineScene, { type LaneLayout } from "./TimelineScene";
import TracePreview from "./TracePreview";
import {
  fetchCommits,
  fetchCommitsDay,
  fetchHealth,
  fetchLanguages,
  fetchLive,
  fetchSessionDetail,
  fetchTimeline,
  searchTimeline,
  type SessionDetail,
} from "@/app/lib/exploreData";
import {
  COST_RAMP,
  DAY,
  FALLBACK_COLOR,
  HARNESS_COLORS,
  LANE_ORDER,
  clusterColor,
  fmtTokens,
  harnessColor,
  hashJitter,
  langColor,
  type ColorMode,
  type SearchPayload,
  type SearchResult,
  type TimelinePayload,
  type TimelinePoint,
  type TimelineSession,
  type ViewState,
} from "./types";

const MIN_PX_PER_DAY = 1.5;
const MIN_LANE_FRACTION = 0.05; // lanes under 5% of all sessions start collapsed
const MAX_PX_PER_DAY = 900;
const AXIS_H = 36; // px reserved for the date axis
const STRIP_H = 28; // px commit strip above the axis
const COMMIT_COLOR = "110, 231, 160"; // --state-promoted #6ee7a0 rgb
const COMMIT_STEPS = [0.18, 0.35, 0.6, 0.9]; // heatmap opacities by quantile

function fmtDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}
function fmtDateTime(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function fmtAgo(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

type Tick = { x: number; label: string; major: boolean };

// adaptive mono date axis: months → weeks → days by px/day
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

type CommitDay = { d: string; c: number };
type DayCommit = { hash7: string; repo: string; subject: string; ts: number; sessions: string[] };

export default function TimelinePane({
  onOpenSession,
}: {
  onOpenSession: (id: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<TimelinePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 700 });
  const [view, setView] = useState<ViewState>({ offsetPx: 40, pxPerDay: 12 });
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [selected, setSelected] = useState<TimelineSession | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [hiddenHarness, setHiddenHarness] = useState<Set<string>>(new Set());
  const [colorMode, setColorMode] = useState<ColorMode>("harness");
  const [hiddenClusters, setHiddenClusters] = useState<Set<number>>(new Set());
  const [hiddenLangs, setHiddenLangs] = useState<Set<string>>(new Set());
  const [showPlumbing, setShowPlumbing] = useState(false);
  const [langCounts, setLangCounts] = useState<Array<{ lang: string; sessions: number }>>([]);

  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchPayload | null>(null);
  const [searching, setSearching] = useState(false);

  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());
  const [health, setHealth] = useState<{ lastEventAgoS: number; ingesting: boolean } | null>(null);

  const [commitDays, setCommitDays] = useState<CommitDay[]>([]);
  const [commitHover, setCommitHover] = useState<{ d: string; c: number; clientX: number; clientY: number } | null>(null);
  const [commitPopover, setCommitPopover] = useState<{ d: string; x: number; commits: DayCommit[] | null } | null>(null);

  const dragRef = useRef<{ x: number; offset: number; moved: boolean } | null>(null);
  const cancelAnimRef = useRef<() => void>(() => {});
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    fetchTimeline()
      .then((d) => setData(d))
      .catch((e) => setError(String(e)));
  }, []);

  // commit layer (commits.sqlite via adapter; empty payload when absent)
  useEffect(() => {
    fetchCommits()
      .then((d) => setCommitDays(d.days ?? []))
      .catch(() => {});
  }, []);

  // language layer (langs.sqlite via adapter; empty payload when absent)
  useEffect(() => {
    fetchLanguages()
      .then((d) => setLangCounts(d.langs ?? []))
      .catch(() => {});
  }, []);

  // live "now" marker + ingest health: one shared 30s poll timer.
  // keep the Set's identity stable when membership hasn't changed — the scene's
  // applied-ref buffer rewrite keys on identity
  useEffect(() => {
    const tick = () => {
      fetchLive()
        .then((d) => {
          setLiveIds((prev) =>
            prev.size === d.ids.length && d.ids.every((id) => prev.has(id)) ? prev : new Set(d.ids),
          );
        })
        .catch(() => {});
      fetchHealth()
        .then((d) => setHealth(d))
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);

  // cost mode thresholds: quantiles over nonzero token totals (log-heat ramp)
  const costThresholds = useMemo(() => {
    const toks = (data?.sessions ?? [])
      .map((s) => s.tokens)
      .filter((t) => t > 0)
      .sort((a, b) => a - b);
    if (!toks.length) return [0, 0, 0];
    const q = (p: number) => toks[Math.min(toks.length - 1, Math.floor(p * toks.length))];
    return [q(0.25), q(0.5), q(0.75)];
  }, [data]);

  // harnesses: canonical order first, then any strays from the data
  const allHarnesses = useMemo(() => {
    const seen = new Set(data?.meta.harnesses ?? []);
    const out = LANE_ORDER.filter((h) => seen.has(h));
    for (const h of seen) if (!out.includes(h)) out.push(h);
    return out;
  }, [data]);

  const harnessCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of data?.sessions ?? []) {
      if (!showPlumbing && s.cluster === "cli plumbing") continue;
      counts.set(s.harness, (counts.get(s.harness) ?? 0) + 1);
    }
    return counts;
  }, [data, showPlumbing]);

  const plumbingCount = useMemo(
    () => (data?.sessions ?? []).filter((s) => s.cluster === "cli plumbing").length,
    [data],
  );

  // clusters present in the data (task color mode chips), by descending count
  const clusters = useMemo(() => {
    const map = new Map<number, { id: number; name: string; count: number }>();
    for (const s of data?.sessions ?? []) {
      if (s.clusterId == null) continue;
      const e = map.get(s.clusterId) ?? { id: s.clusterId, name: s.cluster ?? `cluster ${s.clusterId}`, count: 0 };
      e.count++;
      map.set(s.clusterId, e);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [data]);

  // plumbing (CodexBar /usage probes etc.) starts hidden in task mode so the
  // real work distribution reads; its chip stays one click away
  const autoHidPlumbing = useRef(false);
  useEffect(() => {
    if (autoHidPlumbing.current) return;
    const plumbing = clusters.find((c) => c.name === "cli plumbing");
    if (!plumbing) return;
    autoHidPlumbing.current = true;
    setHiddenClusters((prev) => new Set([...prev, plumbing.id]));
  }, [clusters]);

  // sparse lanes start hidden so the field isn't mostly empty rows; the chips
  // still show them (with counts) and one click brings the lane back
  const autoHidden = useRef(false);
  useEffect(() => {
    if (autoHidden.current || !data) return;
    autoHidden.current = true;
    const realSessions = data.sessions.filter((s) => s.cluster !== "cli plumbing").length;
    const minSessions = (realSessions || 1) * MIN_LANE_FRACTION;
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
      searchTimeline(q)
        .then((d) => {
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
    const usable = Math.max(1, size.height - AXIS_H - STRIP_H - top - 8);
    const gap = usable / Math.max(1, lanesList.length);
    return { top, gap, jitterAmp: gap * 0.3 };
  }, [size.height, lanesList.length]);

  const laneY = useCallback(
    (lane: number, jitter = 0) =>
      laneLayout.top + (lane + 0.5) * laneLayout.gap + jitter * laneLayout.jitterAmp,
    [laneLayout],
  );
  const dayX = useCallback((day: number) => view.offsetPx + day * view.pxPerDay, [view]);

  // shared visibility: harness hiding always, cluster hiding in task mode,
  // language hiding in language mode
  const isVisible = useCallback(
    (p: TimelinePoint) =>
      (showPlumbing || p.s.cluster !== "cli plumbing") &&
      !hiddenHarness.has(p.s.harness) &&
      !(colorMode === "task" && p.s.clusterId != null && hiddenClusters.has(p.s.clusterId)) &&
      !(colorMode === "language" && p.s.lang != null && hiddenLangs.has(p.s.lang)),
    [showPlumbing, hiddenHarness, colorMode, hiddenClusters, hiddenLangs],
  );

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
        if (!isVisible(p)) continue;
        const d = Math.hypot(dayX(p.day) - px, laneY(p.lane, p.jitter) - py);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      return best;
    },
    [points, isVisible, dayX, laneY],
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
    fetchSessionDetail(selected.id)
      .then((d) => {
        if (!stale) setDetail(d);
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

  const toggleCluster = useCallback((id: number) => {
    setHiddenClusters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleLang = useCallback((lang: string) => {
    setHiddenLangs((prev) => {
      const next = new Set(prev);
      if (next.has(lang)) next.delete(lang);
      else next.add(lang);
      return next;
    });
  }, []);

  const ticks = useMemo(
    () => (points.length ? computeTicks(view, day0, size.width) : []),
    [points.length, view, day0, size.width],
  );

  const visibleCount = useMemo(() => points.filter(isVisible).length, [points, isVisible]);

  // commit strip cells: same x mapping as everything else (day since day0)
  const commitCells = useMemo(() => {
    if (!commitDays.length || !day0) return [];
    return commitDays.map((r) => ({
      ...r,
      day: (Date.parse(`${r.d}T00:00:00Z`) / 1000 - day0) / DAY,
    }));
  }, [commitDays, day0]);

  // GitHub-heatmap semantics: 4 intensity steps by count quantiles (nonzero days)
  const commitOpacity = useMemo(() => {
    const counts = commitDays.map((r) => r.c).sort((a, b) => a - b);
    if (!counts.length) return () => 0;
    const q = (p: number) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))];
    const t = [q(0.25), q(0.5), q(0.75)];
    return (c: number) =>
      c <= 0 ? 0 : c <= t[0] ? COMMIT_STEPS[0] : c <= t[1] ? COMMIT_STEPS[1] : c <= t[2] ? COMMIT_STEPS[2] : COMMIT_STEPS[3];
  }, [commitDays]);

  const openCommitDay = useCallback((d: string, x: number) => {
    setCommitPopover((prev) => (prev?.d === d ? null : { d, x, commits: null }));
  }, []);
  useEffect(() => {
    if (!commitPopover || commitPopover.commits !== null) return;
    let stale = false;
    fetchCommitsDay(commitPopover.d)
      .then((d) => {
        if (!stale) setCommitPopover((prev) => (prev?.d === commitPopover.d ? { ...prev, commits: d.commits ?? [] } : prev));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [commitPopover]);

  // clicking a commit with mapped sessions flies to its trace
  const flyToSession = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        const p = points.find((pt) => pt.s.id === id);
        if (p) {
          flyToPointRef.current(p);
          return;
        }
      }
    },
    [points],
  );

  const selectedPoint = selected ? points.find((p) => p.s.id === selected.id) : null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* filter chips */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-3 border-b border-rule">
        {/* color-mode segmented control */}
        <span className="mono text-[11px] text-ink-muted">color:</span>
        <div className="mono flex items-center rounded-full border border-rule text-[11px] mr-2">
          {(["harness", "task", "language", "cost"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setColorMode(m)}
              className="px-2.5 py-1 rounded-full transition-colors"
              style={{
                color: colorMode === m ? "var(--ink-bright)" : "var(--ink-muted)",
                background: colorMode === m ? "var(--hover, rgba(255,255,255,0.06))" : "transparent",
                transitionTimingFunction: "var(--ease)",
              }}
            >
              {m}
            </button>
          ))}
        </div>
        {colorMode === "harness" ? (
          <>
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
          </>
        ) : colorMode === "task" ? (
          <>
            <span className="mono text-[11px] text-ink-muted mr-1">task</span>
            {clusters.length === 0 && (
              <span className="mono text-[11px] text-ink-muted/60">no clusters yet</span>
            )}
            {clusters.map((c) => (
              <Chip
                key={c.id}
                label={`${c.name} · ${c.count}`}
                color={clusterColor(c.id)}
                active={!hiddenClusters.has(c.id)}
                onClick={() => toggleCluster(c.id)}
              />
            ))}
          </>
        ) : colorMode === "cost" ? (
          <>
            {/* no chips in cost mode — a tiny sequential legend instead */}
            <span className="mono text-[11px] text-ink-muted mr-1">tokens</span>
            <span className="mono flex items-center gap-1 text-[10px] text-ink-muted">
              low
              {COST_RAMP.map((c) => (
                <span key={c} className="inline-block h-1.5 w-4 rounded-[2px]" style={{ background: c }} />
              ))}
              high
            </span>
          </>
        ) : (
          <>
            <span className="mono text-[11px] text-ink-muted mr-1">language</span>
            {langCounts.length === 0 && (
              <span className="mono text-[11px] text-ink-muted/60">no language data yet</span>
            )}
            {langCounts.map((l) => (
              <Chip
                key={l.lang}
                label={`${l.lang} · ${l.sessions}`}
                color={langColor(l.lang)}
                active={!hiddenLangs.has(l.lang)}
                onClick={() => toggleLang(l.lang)}
              />
            ))}
          </>
        )}
        <span className="ml-auto flex items-center gap-3">
          {plumbingCount > 0 && (
            <button
              onClick={() => setShowPlumbing((v) => !v)}
              className="mono text-[10px] px-2 py-0.5 rounded-full border transition-colors"
              style={{
                borderColor: showPlumbing ? "var(--ink-muted)" : "var(--rule)",
                color: showPlumbing ? "var(--ink)" : "rgba(155,157,163,0.5)",
              }}
              title="CodexBar /usage probe sessions — hidden by default in every mode"
            >
              plumbing · {plumbingCount}
            </button>
          )}
          <span className="mono text-[11px] text-ink-muted">
            {visibleCount}/{data?.meta.count ?? "…"} sessions
            {liveIds.size > 0 && <span style={{ color: "#6ee7a0" }}> · {liveIds.size} live</span>}
          </span>
        </span>
        {health && (
          <span
            className="mono text-[10px]"
            style={{ color: health.ingesting ? "var(--ink-muted)" : "#f85149" }}
          >
            {health.ingesting ? "ingest current" : "ingest stale"} · last event {fmtAgo(health.lastEventAgoS)} ago
          </span>
        )}
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
              colorMode={colorMode}
              hiddenClusters={hiddenClusters}
              hiddenLangs={hiddenLangs}
              liveIds={liveIds}
              costThresholds={costThresholds}
              showPlumbing={showPlumbing}
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
          {selectedPoint && isVisible(selectedPoint) && (
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

          {/* commit strip — a bottom row above the date axis, same x mapping */}
          {commitCells.length > 0 && (
            <div
              className="absolute left-0 right-0 z-10 overflow-hidden"
              style={{
                bottom: AXIS_H,
                height: STRIP_H,
                borderTop: "1px solid rgba(255,255,255,0.06)",
                background: "rgba(11,12,14,0.4)",
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerMove={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onPointerLeave={() => setCommitHover(null)}
            >
              {commitCells.map((cell) => {
                const x = view.offsetPx + cell.day * view.pxPerDay;
                if (x < -view.pxPerDay || x > size.width + view.pxPerDay) return null;
                const w = Math.max(2, view.pxPerDay - (view.pxPerDay >= 4 ? 1 : 0));
                return (
                  <div
                    key={cell.d}
                    className="absolute cursor-pointer"
                    style={{
                      left: x,
                      top: 7,
                      width: w,
                      height: STRIP_H - 13,
                      borderRadius: 1,
                      background: `rgba(${COMMIT_COLOR}, ${commitOpacity(cell.c)})`,
                    }}
                    onPointerMove={(e) => {
                      e.stopPropagation();
                      setCommitHover({ d: cell.d, c: cell.c, clientX: e.clientX, clientY: e.clientY });
                    }}
                    onPointerLeave={() => setCommitHover(null)}
                    onClick={() => openCommitDay(cell.d, x)}
                  />
                );
              })}
              <div className="mono pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[9px] tracking-wide text-ink-muted/70">
                commits
              </div>
            </div>
          )}

          {/* commit day popover */}
          {commitPopover && (
            <div
              className="mono absolute z-30 w-[380px] max-h-[40vh] overflow-y-auto rounded-[8px] border border-rule bg-window/95 backdrop-blur text-[10px]"
              style={{
                bottom: AXIS_H + STRIP_H + 6,
                left: Math.max(8, Math.min(commitPopover.x - 100, size.width - 396)),
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-rule px-3 py-2 text-ink-muted">
                <span>
                  {commitPopover.d} · {commitPopover.commits ? `${commitPopover.commits.length} commits` : "loading…"}
                </span>
                <button
                  onClick={() => setCommitPopover(null)}
                  className="text-ink-muted hover:text-ink-bright transition-colors"
                  aria-label="close commits"
                >
                  ×
                </button>
              </div>
              {commitPopover.commits?.map((c) => {
                const hasTrace = c.sessions.length > 0;
                return (
                  <button
                    key={c.hash7}
                    disabled={!hasTrace}
                    onClick={() => {
                      if (!hasTrace) return;
                      flyToSession(c.sessions);
                      setCommitPopover(null);
                    }}
                    className={`block w-full border-b border-rule px-3 py-1.5 text-left last:border-b-0 transition-colors ${
                      hasTrace ? "hover:bg-hover cursor-pointer" : "cursor-default"
                    }`}
                  >
                    <span className="text-ink-muted/70">{c.hash7}</span>{" "}
                    <span style={{ color: "#6ee7a0", opacity: 0.8 }}>{c.repo}</span>{" "}
                    <span className="text-ink">{c.subject}</span>
                    {hasTrace && <span className="text-ink-muted"> · in trace</span>}
                  </button>
                );
              })}
            </div>
          )}

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
          <div
            className="mono pointer-events-none absolute left-4 z-10 text-[10px] text-ink-muted/70"
            style={{ bottom: AXIS_H + (commitCells.length ? STRIP_H : 0) + 12 }}
          >
            drag to pan · wheel to zoom time · hover points · click for detail
          </div>
        </div>

        {/* commit cell tooltip */}
        {commitHover && (
          <div
            className="mono pointer-events-none fixed z-50 rounded-lg border border-rule px-3 py-2 text-[11px] leading-relaxed"
            style={{
              left: commitHover.clientX + 14,
              top: commitHover.clientY - 40,
              background: "rgba(11,12,14,0.92)",
            }}
          >
            <span className="text-ink-bright">{commitHover.d}</span>
            <span className="text-ink-muted">
              {" · "}
              {commitHover.c} commit{commitHover.c === 1 ? "" : "s"}
            </span>
          </div>
        )}

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
              {hover.point.s.tokens > 0 && <> · {fmtTokens(hover.point.s.tokens)} tok</>}
              {hover.point.s.lang && (
                <>
                  {" · "}
                  <span style={{ color: langColor(hover.point.s.lang) }}>{hover.point.s.lang}</span>
                </>
              )}
            </div>
            {hover.point.s.label && (
              <div style={{ color: clusterColor(hover.point.s.clusterId) }}>
                {hover.point.s.label}
              </div>
            )}
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
              {selected.tokens > 0 && (
                <>
                  <dt className="text-ink-muted">tokens</dt>
                  <dd>{fmtTokens(selected.tokens)}</dd>
                </>
              )}
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

            {/* language + tooling stack (langs.sqlite; absent = block hidden) */}
            {detail?.langs && detail.langs.length > 0 && (
              <div className="mt-5">
                <div className="mono text-[11px] text-ink-muted mb-1.5">stack</div>
                {(() => {
                  const total = detail.langs!.reduce((a, l) => a + l.files, 0) || 1;
                  return (
                    <>
                      <div className="flex h-1.5 w-full overflow-hidden rounded-full">
                        {detail.langs!.map((l) => (
                          <div
                            key={l.lang}
                            style={{
                              width: `${(100 * l.files) / total}%`,
                              background: langColor(l.lang),
                              opacity: 0.85,
                            }}
                          />
                        ))}
                      </div>
                      <div className="mono mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                        {detail.langs!.map((l) => (
                          <div key={l.lang} className="flex items-center gap-1.5">
                            <span
                              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ background: langColor(l.lang) }}
                            />
                            <span className="text-ink">{l.lang}</span>
                            <span className="ml-auto text-ink-muted">{l.files}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  );
                })()}
                {detail.tools && detail.tools.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {detail.tools.map((t) => (
                      <span
                        key={t.tool}
                        className="mono rounded-full border border-rule px-2 py-0.5 text-[10px] text-ink-muted"
                      >
                        {t.tool} <span className="text-ink-muted/60">×{t.uses}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

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

            {(detail?.label || selected.label || detail?.scan_summary) && (
              <div className="mt-5">
                <div className="mono text-[11px] text-ink-muted mb-1.5">scanned by gemma</div>
                {(detail?.label || selected.label) && (
                  <span
                    className="mono inline-block text-[11px] px-2.5 py-1 rounded-full border mb-2"
                    style={{
                      borderColor: clusterColor(detail?.clusterId ?? selected.clusterId),
                      color: "var(--ink-bright)",
                      background: `${clusterColor(detail?.clusterId ?? selected.clusterId)}1a`,
                    }}
                  >
                    {detail?.label ?? selected.label}
                  </span>
                )}
                {detail?.scan_summary && (
                  <p className="text-[13px] leading-relaxed text-ink whitespace-pre-wrap">
                    {detail.scan_summary}
                  </p>
                )}
              </div>
            )}

            <div className="mt-5">
              <div className="mono text-[11px] text-ink-muted mb-1.5">trace</div>
              <TracePreview sessionId={selected.id} />
            </div>

            <div className="mt-5 flex gap-4">
              <button
                onClick={() => onOpenSession(selected.id)}
                className="mono text-[11px] text-ink-bright underline decoration-rule underline-offset-4 hover:text-ink transition-colors cursor-pointer bg-transparent border-0 p-0"
              >
                full transcript →
              </button>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
