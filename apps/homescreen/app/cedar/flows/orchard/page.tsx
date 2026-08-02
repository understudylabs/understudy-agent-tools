"use client";

/* 20 · orchard — every rewrite plants a grove. One continuous field
 * holds the whole outer loop: records walk a spine, failed proposals
 * orbit the record they tried to beat, each proposal unfolds into
 * dozens of solution searches and each search into its tree of nodes.
 * Drag to pan, wheel to dive from the whole climb to a single node —
 * the climb chart below is the replay scrubber. WebGL draws the mass,
 * the DOM draws the words. */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../../cedar.css";
import "../../../moodboard/moodboard.css";
import "../flows.css";
import { AMBER, BAD, CAND_C, GOOD, INC_C } from "../lib";
import { createEngine, type Camera, type Engine } from "./engine";
import { buildRealWorld, realTotals } from "./real";
import { buildWorkflowWorld, type WorkflowEvent } from "./live";
import { generateRun, MAX_STEP, type World } from "./run";

type DataSrc = "synthetic" | "und289" | "workflow";

const SPEED = 7; // outer steps per second during replay

/* ---- the replay ride: most granular first ----
 * ▶ opens on ONE tree of aide_0 growing node by node, rings its winner,
 * pulls back to the local grove, then back out to the whole field — and
 * only then lets the climb run at full speed. Camera beats fire once at
 * their timestamps; the step clock eases between keyframes so the world
 * reveals in sync with where the camera is looking. Grabbing the camera
 * (drag/wheel) or scrubbing the chart cancels the ride. */
const RIDE_END = 10.2;
type RideKey = { t: number; step: number };
const rideEase = (keys: RideKey[], t: number) => {
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      const k = (t - a.t) / (b.t - a.t);
      return a.step + (b.step - a.step) * (k * k * (3 - 2 * k));
    }
  }
  return keys[keys.length - 1].step;
};

type Sel =
  | { kind: "eval"; id: number }
  | { kind: "search"; id: number }
  | { kind: "node"; id: number }
  | null;

/* ---- chart geometry — derived per world (real runs have their own
 * step count and score range) ---- */
const CW = 1020;
const CH = 168;
const PX = 46;
const PT = 16;
const PB = 26;

type Geom = {
  maxStep: number;
  sx: (s: number) => number;
  sy: (v: number) => number;
  yTicks: number[];
  xTicks: number[];
};

function makeGeom(world: World): Geom {
  const maxStep = world.evals.length - 1;
  let lo = Infinity;
  let hi = -Infinity;
  for (const ev of world.evals) {
    lo = Math.min(lo, ev.perf);
    hi = Math.max(hi, ev.perf);
  }
  const pad = Math.max(0.004, (hi - lo) * 0.07);
  const yLo = lo - pad;
  const yHi = hi + pad;
  const sx = (s: number) => PX + (s / Math.max(1, maxStep)) * (CW - 2 * PX);
  const sy = (v: number) => PT + (1 - (v - yLo) / (yHi - yLo)) * (CH - PT - PB);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    maxStep,
    sx,
    sy,
    yTicks: [...new Set([r2(lo), r2((lo + hi) / 2), r2(hi)])],
    xTicks: [...new Set([0, Math.round(maxStep / 4), Math.round(maxStep / 2), Math.round((3 * maxStep) / 4), maxStep])],
  };
}

function hexPoints(x: number, y: number, r: number) {
  return Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 3) * k + Math.PI / 6;
    return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* ---- picking: level follows the semantic zoom ---- */
function pickAt(world: World, wx: number, wy: number, z: number): Sel {
  if (z >= 22) {
    // nodes — only searches whose eval is near the pointer
    const tol = 14 / z;
    let best = -1;
    let bd = tol;
    for (const ev of world.evals) {
      if (Math.hypot(ev.x - wx, ev.y - wy) > 9 + 4 + tol) continue;
      for (let gi = ev.n0; gi < ev.n1; gi++) {
        const d = Math.hypot(world.nx[gi] - wx, world.ny[gi] - wy);
        if (d < bd) {
          bd = d;
          best = gi;
        }
      }
    }
    if (best >= 0) return { kind: "node", id: best };
  }
  if (z >= 3) {
    const tol = 14 / z;
    let best = -1;
    let bd = Math.max(tol, 1.4);
    for (const se of world.searches) {
      const d = Math.hypot(se.x - wx, se.y - wy);
      if (d < bd) {
        bd = d;
        best = se.id;
      }
    }
    if (best >= 0) return { kind: "search", id: best };
  }
  const tol = Math.max(16 / z, 3);
  let best = -1;
  let bd = tol;
  for (const ev of world.evals) {
    const d = Math.hypot(ev.x - wx, ev.y - wy);
    if (d < bd) {
      bd = d;
      best = ev.id;
    }
  }
  return best >= 0 ? { kind: "eval", id: best } : null;
}

const evalOf = (world: World, s: Sel): number =>
  !s ? -1 : s.kind === "eval" ? s.id : s.kind === "search" ? world.searches[s.id].eval : world.searches[world.nsearch[s.id]].eval;

const NODE_STATE = ["root", "explored", "best of its search", "dead end", "running"] as const;
const NODE_COLOR = ["#f2f2f0", INC_C, CAND_C, BAD, "#f2f2f0"] as const;

export default function OrchardFlow() {
  const [src, setSrc] = useState<DataSrc>("synthetic");
  const [liveEvents, setLiveEvents] = useState<WorkflowEvent[]>([]);
  const [liveStatus, setLiveStatus] = useState<"idle" | "connecting" | "live" | "unavailable">("idle");
  const world = useMemo(
    () => src === "und289" ? buildRealWorld() : src === "workflow" ? buildWorkflowWorld(liveEvents) : generateRun(),
    [src, liveEvents],
  );
  const geom = useMemo(() => makeGeom(world), [world]);
  const geomRef = useRef(geom);
  geomRef.current = geom;
  const nameOf = useCallback(
    (id: number) => world.names?.[id] ?? `aide_${id}`,
    [world]
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const liveCamRef = useRef<Camera | null>(null);
  const [glFail, setGlFail] = useState(false);
  const [sel, setSelState] = useState<Sel>(null);
  const [playing, setPlaying] = useState(false);
  const [chartStep, setChartStep] = useState(MAX_STEP);

  const selRef = useRef<Sel>(null);
  const stepRef = useRef(MAX_STEP + 1.2); // start fully revealed
  const playingRef = useRef(false);
  const rideRef = useRef<{ t: number; fired: number } | null>(null);
  const rideKeysRef = useRef<RideKey[]>([{ t: 0, step: 0 }]);
  const chartIntRef = useRef(MAX_STEP);
  const hoverRef = useRef<{ sel: Sel; wx: number; wy: number } | null>(null);

  const hudStepRef = useRef<HTMLDivElement | null>(null);
  const hudPerfRef = useRef<HTMLDivElement | null>(null);
  const zoomCapRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<SVGLineElement | null>(null);
  const trailRef = useRef<SVGLineElement | null>(null);
  const recordEls = useRef<(HTMLDivElement | null)[]>([]);
  const hoverRingRef = useRef<HTMLDivElement | null>(null);
  const hoverCapRef = useRef<HTMLDivElement | null>(null);
  const selRingRef = useRef<HTMLDivElement | null>(null);

  const totals = useMemo(
    () => ({
      searches: world.searches.length,
      nodes: world.nodeCount,
      survived: world.records.length - 1,
      real: src === "und289" ? realTotals() : null,
    }),
    [world, src]
  );

  useEffect(() => {
    if (src !== "workflow") {
      setLiveStatus("idle");
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after = -1;
    const seen = new Map<number, WorkflowEvent>();
    setLiveEvents([]);
    setLiveStatus("connecting");
    const poll = async () => {
      try {
        const proxy = process.env.NEXT_PUBLIC_ORCHARD_EVENT_PROXY_URL ?? "http://127.0.0.1:1431";
        const response = await fetch(`${proxy.replace(/\/$/, "")}/events?after=${after}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`live source ${response.status}`);
        const payload = await response.json() as {
          events?: WorkflowEvent[];
          next_after?: number;
        };
        for (const event of payload.events ?? []) seen.set(event.sequence, event);
        after = payload.next_after ?? after;
        if (!stopped) {
          setLiveEvents([...seen.values()].sort((a, b) => a.sequence - b.sequence));
          setLiveStatus("live");
        }
      } catch {
        if (!stopped) setLiveStatus("unavailable");
      } finally {
        if (!stopped) timer = setTimeout(poll, 1_000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [src]);

  const select = useCallback(
    (s: Sel) => {
      selRef.current = s;
      setSelState(s);
      engineRef.current?.setFocus(evalOf(world, s));
    },
    [world]
  );

  const flyToEval = useCallback(
    (id: number, z = 6) => {
      const ev = world.evals[id];
      engineRef.current?.flyTo({ x: ev.x, y: ev.y, z });
      select({ kind: "eval", id });
    },
    [world, select]
  );

  /* ---- mount the engine ---- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    /* a fresh world starts fully revealed and unselected */
    stepRef.current = world.evals.length - 1 + 1.2;
    playingRef.current = false;
    setPlaying(false);
    rideRef.current = null;
    selRef.current = null;
    setSelState(null);

    const selPos = (s: Sel): [number, number] | null => {
      if (!s) return null;
      if (s.kind === "eval") return [world.evals[s.id].x, world.evals[s.id].y];
      if (s.kind === "search") return [world.searches[s.id].x, world.searches[s.id].y];
      return [world.nx[s.id], world.ny[s.id]];
    };

    const hoverLabel = (s: Sel): string => {
      if (!s) return "";
      if (s.kind === "eval") {
        const ev = world.evals[s.id];
        return world.names
          ? `${nameOf(ev.id)} · ${ev.perf.toFixed(4)}`
          : `aide_${ev.id} · ${ev.perf.toFixed(4)} · ${ev.s1 - ev.s0} searches`;
      }
      if (s.kind === "search") {
        const se = world.searches[s.id];
        return `s${se.id - world.evals[se.eval].s0} · best ${se.best.toFixed(4)} · ${se.n1 - se.n0} nodes`;
      }
      const st = world.nstate[s.id];
      if (world.ntrace?.[s.id]) {
        const t = world.ntrace[s.id].replace(/\s+/g, " ").replace(/^Source: (.+?) Post: ?/, "");
        return `${st === 1 ? "✓" : "✕"} ${t.slice(0, 76)}…`;
      }
      return `${world.nscore[s.id].toFixed(4)} · ${NODE_STATE[st]}`;
    };

    /* the ride's camera beats. The protagonist is the first eval that
     * has node-level data (synthetic: aide_0's trees; real: the first
     * run with graded cases). Three variants of the same granular →
     * group → field arc: tree worlds ring the winning node, case worlds
     * dive into the failure-map disc, sparse worlds ride one level up.
     * The step keys are protagonist-relative so the reveal reaches the
     * protagonist while the camera is on it. */
    const evP = world.evals.find((e) => e.n1 > e.n0) ?? world.evals[0];
    const pStep = evP.step;
    const rideKeys: RideKey[] = [
      { t: 0, step: 0 },
      { t: 3.6, step: pStep + 0.85 },
      { t: 5.2, step: pStep + 1.0 },
      { t: 7.6, step: pStep + 2.1 },
      { t: 10.2, step: Math.min(pStep + 6, world.evals.length - 1) },
    ];
    rideKeysRef.current = rideKeys;
    let winSearch = evP.s0;
    for (let i = evP.s0; i < evP.s1; i++)
      if (world.searches[i].best > world.searches[winSearch].best) winSearch = i;
    const winNode = world.searches[winSearch].bestNode;
    const beats: { t: number; go: () => void }[] =
      world.nodeCount > 0 && winNode >= 0
        ? [
            {
              t: 0,
              go: () => {
                const se = world.searches[winSearch];
                engine!.flyTo({ x: se.x, y: se.y, z: 64 }); // one tree
              },
            },
            {
              t: 3.6,
              go: () => {
                select({ kind: "node", id: winNode }); // the winner, ringed
                engine!.flyTo({ x: world.nx[winNode], y: world.ny[winNode], z: 100 });
              },
            },
            {
              t: 5.2,
              go: () => {
                select({ kind: "search", id: winSearch }); // its place in the grove
                engine!.flyTo({ x: evP.x, y: evP.y, z: 7 });
              },
            },
            {
              t: 7.6,
              go: () => {
                select(null); // the whole field
                engine!.fitAll();
              },
            },
          ]
        : world.nodeCount > 0
          ? [
              {
                t: 0,
                go: () => {
                  select({ kind: "eval", id: evP.id }); // the graded run
                  engine!.flyTo({ x: evP.x, y: evP.y, z: 44 });
                },
              },
              {
                t: 3.6,
                go: () => {
                  engine!.flyTo({ x: evP.x, y: evP.y, z: 110 }); // into the failure map
                },
              },
              {
                t: 5.2,
                go: () => {
                  engine!.flyTo({ x: evP.x, y: evP.y, z: 6 }); // its neighborhood
                },
              },
              {
                t: 7.6,
                go: () => {
                  select(null);
                  engine!.fitAll();
                },
              },
            ]
          : [
              {
                t: 0,
                go: () => {
                  select({ kind: "eval", id: evP.id }); // the first run
                  engine!.flyTo({ x: evP.x, y: evP.y, z: 24 });
                },
              },
              {
                t: 3.6,
                go: () => {
                  engine!.flyTo({ x: evP.x, y: evP.y, z: 6 }); // its neighborhood forms
                },
              },
              {
                t: 5.2,
                go: () => {
                  engine!.flyTo({ x: evP.x, y: evP.y, z: 2.2 }); // the local cluster
                },
              },
              {
                t: 7.6,
                go: () => {
                  select(null);
                  engine!.fitAll();
                },
              },
            ];

    const engine = createEngine(canvas, world, {
      onTap: (wx, wy) => {
        const z = engine!.cam().z;
        select(pickAt(world, wx, wy, z));
      },
      onGrab: () => {
        rideRef.current = null; // the user takes the wheel — ride yields
      },
      onDouble: (wx, wy) => {
        const z = engine!.cam().z;
        const p = pickAt(world, wx, wy, z);
        if (!p) return;
        select(p);
        if (p.kind === "eval") {
          const ev = world.evals[p.id];
          engine!.flyTo({ x: ev.x, y: ev.y, z: 6 });
        } else if (p.kind === "search") {
          const se = world.searches[p.id];
          engine!.flyTo({ x: se.x, y: se.y, z: 60 });
        } else {
          engine!.flyTo({ x: world.nx[p.id], y: world.ny[p.id], z: 140 });
        }
      },
      onHover: (wx, wy) => {
        const z = engine!.cam().z;
        const p = pickAt(world, wx, wy, z);
        hoverRef.current = p ? { sel: p, wx, wy } : null;
      },
      onHoverEnd: () => {
        hoverRef.current = null;
      },
      onFrame: (dt, cam) => {
        /* replay clock — scripted ride first, then full speed */
        if (playingRef.current) {
          const ride = rideRef.current;
          if (ride) {
            ride.t += dt;
            while (ride.fired < beats.length - 1 && ride.t >= beats[ride.fired + 1].t) {
              ride.fired++;
              beats[ride.fired].go();
            }
            stepRef.current = rideEase(rideKeysRef.current, ride.t);
            if (ride.t >= RIDE_END) rideRef.current = null;
          } else {
            stepRef.current = Math.min(stepRef.current + dt * SPEED, geomRef.current.maxStep + 1.2);
            if (stepRef.current >= geomRef.current.maxStep + 1.2) {
              playingRef.current = false;
              setPlaying(false);
            }
          }
        }
        const st = stepRef.current;
        engine!.setStep(st);

        /* HUD */
        const g = geomRef.current;
        const si = Math.min(g.maxStep, Math.floor(st));
        if (hudStepRef.current) hudStepRef.current.textContent = `${si} / ${g.maxStep}`;
        if (hudPerfRef.current)
          hudPerfRef.current.textContent = world.frontierByStep[si].toFixed(4);
        if (chartIntRef.current !== si) {
          chartIntRef.current = si;
          setChartStep(si);
        }

        /* chart cursor + trailing frontier */
        const cx = g.sx(Math.min(st, g.maxStep));
        if (cursorRef.current) {
          cursorRef.current.setAttribute("x1", `${cx}`);
          cursorRef.current.setAttribute("x2", `${cx}`);
        }
        if (trailRef.current) {
          let lastRec = 0;
          for (const r of world.records) if (r <= si) lastRec = r;
          const y = g.sy(world.frontierByStep[si]);
          trailRef.current.setAttribute("x1", `${g.sx(lastRec)}`);
          trailRef.current.setAttribute("x2", `${cx}`);
          trailRef.current.setAttribute("y1", `${y}`);
          trailRef.current.setAttribute("y2", `${y}`);
        }

        /* semantic-zoom caption */
        const z = cam.z;
        if (zoomCapRef.current) {
          const unit = src === "workflow"
            ? z < 2.8
              ? "one dot = a candidate"
              : z < 13
                ? "candidates · spokes = lineage"
                : "one dot = a task · white running · mint passed · red failed"
            : world.names
            ? z < 2.8
              ? "one dot = a modal run"
              : z < 13
                ? "runs · spokes = real lineage"
                : "one dot = one of derek's cases · mint right · red wrong"
            : z < 2.8
              ? "one dot = a rewrite's evaluation"
              : z < 13
                ? "one dot = a search"
                : "one dot = a node";
          zoomCapRef.current.textContent = `${unit} · zoom ${z < 10 ? z.toFixed(1) : Math.round(z)}×`;
        }

        /* record markers */
        const focus = engine!.getFocus();
        const lod = 1 - smooth(5, 8, z);
        world.records.forEach((rs, i) => {
          const el = recordEls.current[i];
          if (!el) return;
          const ev = world.evals[rs];
          const [x, y] = engine!.worldToCss(ev.x, ev.y);
          const dim = focus >= 0 && focus !== ev.id ? 0.25 : 1;
          el.style.opacity = `${(st >= ev.step ? 1 : 0) * lod * dim}`;
          el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
        });

        /* hover ring + caption */
        const hv = hoverRef.current;
        if (hoverRingRef.current && hoverCapRef.current) {
          if (hv && hv.sel) {
            const pos = selPos(hv.sel)!;
            const [x, y] = engine!.worldToCss(pos[0], pos[1]);
            const r = hv.sel.kind === "eval" ? 15 : hv.sel.kind === "search" ? 11 : 8;
            const ring = hoverRingRef.current;
            ring.style.opacity = "1";
            ring.style.width = `${r * 2}px`;
            ring.style.height = `${r * 2}px`;
            ring.style.transform = `translate3d(${(x - r).toFixed(1)}px,${(y - r).toFixed(1)}px,0)`;
            const cap = hoverCapRef.current;
            cap.style.opacity = "1";
            cap.style.transform = `translate3d(${(x + 14).toFixed(1)}px,${(y - 26).toFixed(1)}px,0)`;
            cap.textContent = hoverLabel(hv.sel);
          } else {
            hoverRingRef.current.style.opacity = "0";
            hoverCapRef.current.style.opacity = "0";
          }
        }

        /* selection ring */
        const s = selRef.current;
        if (selRingRef.current) {
          if (s) {
            const pos = selPos(s)!;
            const [x, y] = engine!.worldToCss(pos[0], pos[1]);
            const r = s.kind === "eval" ? 17 : s.kind === "search" ? 12 : 9;
            const ring = selRingRef.current;
            ring.style.opacity = "1";
            ring.style.width = `${r * 2}px`;
            ring.style.height = `${r * 2}px`;
            ring.style.transform = `translate3d(${(x - r).toFixed(1)}px,${(y - r).toFixed(1)}px,0)`;
          } else selRingRef.current.style.opacity = "0";
        }
      },
    });

    if (!engine) {
      setGlFail(true);
      return;
    }
    engineRef.current = engine;
    if (src === "workflow" && liveCamRef.current) engine.flyTo(liveCamRef.current);
    if (process.env.NODE_ENV === "development")
      (window as unknown as { __orchard?: unknown }).__orchard = { engine, world };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (src === "workflow") liveCamRef.current = engine.cam();
      engine.dispose();
      engineRef.current = null;
    };
    // select is stable (useCallback on [world]); world is memoized once
  }, [world, select, src]);

  /* ---- chart scrub ---- */
  const scrub = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * CW;
    const m = geomRef.current.maxStep;
    const s = Math.min(m, Math.max(0, ((x - PX) / (CW - 2 * PX)) * m));
    stepRef.current = s;
    rideRef.current = null;
    playingRef.current = false;
    setPlaying(false);
  }, []);

  const replay = useCallback(() => {
    if (playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      return;
    }
    stepRef.current = 0;
    rideRef.current = { t: 0, fired: -1 }; // the ride fires beat 0 on the next frame
    playingRef.current = true;
    setPlaying(true);
  }, []);

  /* ---- selection panel content ---- */
  const panel = useMemo(() => {
    if (!sel)
      return src === "workflow" ? (
        <>
          <span className="fx-cap">workflow event stream</span>
          <b style={{ fontFamily: "var(--font-mono)", fontSize: 15 }}>
            {world.evals.length} candidates · {world.nodeCount} tasks
          </b>
          <span className="fx-cap">
            {liveEvents.length} redacted events · {liveStatus}
          </span>
          <span className="fx-cap" style={{ marginLeft: "auto", color: "var(--dim2)" }}>
            white running · mint passed · red failed · cursor refresh 1s
          </span>
        </>
      ) : totals.real ? (
        <>
          <span className="fx-cap">{totals.real.campaign}</span>
          <b style={{ fontFamily: "var(--font-mono)", fontSize: 15 }}>
            {totals.real.scored} runs scored · {totals.survived} moved the record
          </b>
          <span className="fx-cap">
            {totals.real.failed} failed · {totals.real.stopped} stopped · ${totals.real.spend.toFixed(0)} spent ·{" "}
            {world.frontierByStep[0]?.toFixed(4)} → {world.frontierByStep[world.evals.length - 1]?.toFixed(4)} on the{" "}
            {totals.real.primaryBench}-row dev set
          </span>
          <span className="fx-cap" style={{ marginLeft: "auto", color: "var(--dim2)" }}>
            live campaign · snapshot {totals.real.asOf.slice(11, 16)}z
          </span>
        </>
      ) : (
        <>
          <span className="fx-cap">the run</span>
          <b style={{ fontFamily: "var(--font-mono)", fontSize: 15 }}>
            99 rewrites proposed · {totals.survived} survived
          </b>
          <span className="fx-cap">
            {totals.searches.toLocaleString()} searches · {totals.nodes.toLocaleString()} nodes ·{" "}
            0.7032 → 0.7784
          </span>
          <span className="fx-cap" style={{ marginLeft: "auto", color: "var(--dim2)" }}>
            drag to pan · wheel to dive · double-click to fly · chart scrubs the replay
          </span>
        </>
      );
    if (sel.kind === "eval") {
      const ev = world.evals[sel.id];
      return (
        <>
          <b style={{ fontFamily: "var(--font-mono)", fontSize: 15, color: ev.record ? AMBER : "var(--ink)" }}>
            {nameOf(ev.id)}
          </b>
          {ev.record ? (
            <span className="fx-chip" style={{ borderColor: AMBER, color: AMBER }}>
              ⬡ moved the record
            </span>
          ) : (
            <span className="fx-chip">did not survive</span>
          )}
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 20 }}>{ev.perf.toFixed(4)}</span>
          <span style={{ fontSize: 12.5, color: "var(--dim)" }}>{ev.rule}</span>
          <span className="fx-cap" style={{ marginLeft: "auto" }}>
            {world.names
              ? ev.parent >= 0
                ? `built on ${nameOf(ev.parent)}`
                : "the first run"
              : `${ev.s1 - ev.s0} searches · ${(ev.n1 - ev.n0).toLocaleString()} nodes` +
                (ev.parent >= 0 ? ` · rewrote aide_${ev.parent}` : " · the seed")}
          </span>
        </>
      );
    }
    if (sel.kind === "search") {
      const se = world.searches[sel.id];
      const ev = world.evals[se.eval];
      return (
        <>
          <b style={{ fontFamily: "var(--font-mono)", fontSize: 15 }}>
            {nameOf(ev.id)} · s{se.id - ev.s0}
          </b>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 20, color: CAND_C }}>
            {se.best.toFixed(4)}
          </span>
          <span className="fx-cap">
            best of {se.n1 - se.n0} nodes · depth {se.depth}
          </span>
        </>
      );
    }
    const gi = sel.id;
    const se = world.searches[world.nsearch[gi]];
    const ev = world.evals[se.eval];
    const st = world.nstate[gi];
    return (
      <>
        <b style={{ fontFamily: "var(--font-mono)", fontSize: 15 }}>
          {nameOf(ev.id)} · s{se.id - ev.s0} · n{gi - se.n0}
        </b>
        {world.nlabel ? (
          <>
            <span
              title={world.nlabel[gi]}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                color: NODE_COLOR[st],
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "58%",
                flexShrink: 0,
              }}
            >
              {world.nlabel[gi]}
            </span>
            {world.ntrace?.[gi] && (
              <span
                title={world.ntrace[gi]}
                style={{
                  fontSize: 12,
                  color: "var(--dim)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                  flex: 1,
                }}
              >
                {world.ntrace[gi].replace(/\s+/g, " ").replace(/^Source: (.+?) Post: ?/, "$1 · ")}
              </span>
            )}
          </>
        ) : (
          <>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 20, color: NODE_COLOR[st] }}>
              {world.nscore[gi].toFixed(4)}
            </span>
            <span className="fx-cap" style={{ color: NODE_COLOR[st] }}>
              {NODE_STATE[st]}
            </span>
          </>
        )}
      </>
    );
  }, [sel, world, totals, nameOf, src, liveEvents.length, liveStatus]);

  /* ---- breadcrumb ---- */
  const crumb = useMemo(() => {
    const parts: { label: string; act: () => void }[] = [
      {
        label: "run",
        act: () => {
          select(null);
          engineRef.current?.fitAll();
        },
      },
    ];
    if (sel) {
      const ei = evalOf(world, sel);
      parts.push({ label: nameOf(ei), act: () => flyToEval(ei) });
      if (sel.kind !== "eval") {
        const sid = sel.kind === "search" ? sel.id : world.nsearch[sel.id];
        const se = world.searches[sid];
        parts.push({
          label: `s${sid - world.evals[se.eval].s0}`,
          act: () => {
            select({ kind: "search", id: sid });
            engineRef.current?.flyTo({ x: se.x, y: se.y, z: 60 });
          },
        });
        if (sel.kind === "node") parts.push({ label: `n${sel.id - se.n0}`, act: () => {} });
      }
    }
    return parts;
  }, [sel, world, select, flyToEval, nameOf]);

  /* ---- chart data ---- */
  const frontierSegs = useMemo(() => {
    const segs: { x1: number; y1: number; x2: number; y2: number; at: number }[] = [];
    for (let i = 1; i < world.records.length; i++) {
      const a = world.evals[world.records[i - 1]];
      const b = world.evals[world.records[i]];
      segs.push({ x1: geom.sx(a.step), y1: geom.sy(a.frontier), x2: geom.sx(b.step), y2: geom.sy(a.frontier), at: b.step });
      segs.push({ x1: geom.sx(b.step), y1: geom.sy(a.frontier), x2: geom.sx(b.step), y2: geom.sy(b.frontier), at: b.step });
    }
    return segs;
  }, [world, geom]);

  return (
    <div className="cs fx">
      <div className="cs-inner" style={{ maxWidth: 1100 }}>
        <nav className="fx-nav fx-in">
          <Link href="/cedar/flows" className="fx-cap">
            ← flows
          </Link>
          <span className="fx-cap" style={{ color: "#f2f2f0" }}>
            20 · orchard
          </span>
          <span style={{ display: "inline-flex", gap: 6, marginLeft: 14 }}>
            {(
              [
                ["synthetic", "synthetic"],
                ["und289", "und-289 · real"],
                ["workflow", "workflow · live"],
              ] as [DataSrc, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                className="fx-chip"
                onClick={() => setSrc(id)}
                style={{
                  cursor: "pointer",
                  background: "none",
                  font: "inherit",
                  borderColor: src === id ? GOOD : undefined,
                  color: src === id ? GOOD : undefined,
                }}
              >
                {label}
              </button>
            ))}
          </span>
          {src === "workflow" && (
            <span className="fx-cap" style={{ marginLeft: 10, color: liveStatus === "live" ? GOOD : "var(--dim)" }}>
              {liveStatus} · {liveEvents.length} events
            </span>
          )}
          <span className="spacer" />
          <span className="fx-cap" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {crumb.map((c, i) => (
              <span key={c.label} style={{ display: "inline-flex", gap: 6 }}>
                {i > 0 && <span style={{ color: "var(--dim2)" }}>›</span>}
                <button
                  onClick={c.act}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    color: i === crumb.length - 1 ? "#f2f2f0" : "var(--dim)",
                    cursor: "pointer",
                    letterSpacing: "inherit",
                    textTransform: "inherit",
                  }}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </span>
        </nav>

        <p className="fx-in" style={{ fontSize: 12.5, color: "var(--dim)", lineHeight: 1.55, margin: "0 0 18px", maxWidth: 640 }}>
          every rewrite of the agent plants a grove — dozens of tree searches over the same
          benchmark. records walk the green spine; everything else orbits the record it failed
          to beat. one field, three scales: the climb, the grove, the node.
        </p>

        {/* ---- stage ---- */}
        <div
          className="fx-in"
          style={{
            position: "relative",
            height: 540,
            border: "1px solid var(--line)",
            borderRadius: 12,
            overflow: "hidden",
            background:
              "radial-gradient(120% 90% at 50% 0%, rgba(255,255,255,0.03), transparent 60%)",
          }}
        >
          {glFail ? (
            <div style={{ display: "grid", placeItems: "center", height: "100%" }} className="fx-cap">
              webgl2 unavailable — the orchard needs it
            </div>
          ) : (
            <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />
          )}

          {/* overlay: rings, labels, captions — words live in the DOM */}
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
            {world.records.map((rs, i) => {
              const ev = world.evals[rs];
              return (
                <div
                  key={rs}
                  ref={(el) => {
                    recordEls.current[i] = el;
                  }}
                  style={{ position: "absolute", left: 0, top: 0, willChange: "transform", opacity: 0 }}
                >
                  <svg width={34} height={34} style={{ position: "absolute", left: -17, top: -17, overflow: "visible" }}>
                    {rs === 0 ? (
                      <circle cx={17} cy={17} r={9} fill="none" stroke="rgba(242,242,240,0.55)" strokeWidth={1.2} />
                    ) : (
                      <polygon points={hexPoints(17, 17, 11)} className="mb-milestone on" />
                    )}
                  </svg>
                  <span
                    style={{
                      position: "absolute",
                      left: 16,
                      top: -6,
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      letterSpacing: "0.08em",
                      whiteSpace: "nowrap",
                      color: "var(--dim)",
                    }}
                  >
                    {nameOf(ev.id)} <b style={{ color: AMBER, fontWeight: 500 }}>{ev.perf.toFixed(4)}</b>
                  </span>
                </div>
              );
            })}
            <div
              ref={hoverRingRef}
              style={{ position: "absolute", left: 0, top: 0, borderRadius: 999, border: "1px solid rgba(242,242,240,0.45)", opacity: 0, willChange: "transform" }}
            />
            <div
              ref={selRingRef}
              style={{ position: "absolute", left: 0, top: 0, borderRadius: 999, border: "1.5px solid rgba(242,242,240,0.9)", opacity: 0, willChange: "transform" }}
            />
            <div
              ref={hoverCapRef}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.06em",
                color: "var(--dim)",
                background: "rgba(8,8,10,0.85)",
                border: "1px solid var(--line)",
                borderRadius: 6,
                padding: "3px 8px",
                whiteSpace: "nowrap",
                opacity: 0,
                willChange: "transform",
              }}
            />
          </div>

          {/* HUD */}
          <div style={{ position: "absolute", left: 18, top: 16, pointerEvents: "none", display: "grid", gap: 10 }}>
            <div>
              <div className="fx-cap">step</div>
              <div ref={hudStepRef} style={{ fontFamily: "var(--font-mono)", fontSize: 28, fontWeight: 500, letterSpacing: "-0.01em" }} />
            </div>
            <div>
              <div className="fx-cap">performance</div>
              <div ref={hudPerfRef} style={{ fontFamily: "var(--font-mono)", fontSize: 28, fontWeight: 500, letterSpacing: "-0.01em", color: GOOD }} />
            </div>
          </div>

          <div style={{ position: "absolute", right: 14, top: 14, display: "flex", gap: 8 }}>
            <button className="fx-btn" onClick={replay}>
              {playing ? "⏸ pause" : "▶ replay the climb"}
            </button>
            <button
              className="fx-btn ghost"
              onClick={() => {
                select(null);
                engineRef.current?.fitAll();
              }}
            >
              ⤢ fit
            </button>
          </div>

          <div ref={zoomCapRef} className="fx-cap" style={{ position: "absolute", left: 18, bottom: 14, pointerEvents: "none" }} />
        </div>

        {/* ---- selection / summary strip ---- */}
        <div className="tt-detail" key={sel ? `${sel.kind}-${sel.id}` : "summary"} style={{ alignItems: "center", gap: 18 }}>
          {panel}
        </div>

        {/* ---- the outer loop, climb idiom — doubles as the scrubber ---- */}
        <div className="fx-in" style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "14px 16px 8px", marginTop: 18, background: "var(--card)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
            <span className="fx-cap" style={{ color: GOOD }}>
              outer loop · rewrites of the agent
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            <span className="fx-cap">performance ↑ · click to scrub</span>
          </div>
          <svg
            viewBox={`0 0 ${CW} ${CH}`}
            style={{ width: "100%", display: "block", cursor: "crosshair", touchAction: "none" }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              scrub(e);
            }}
            onPointerMove={(e) => {
              if (e.buttons) scrub(e);
            }}
          >
            {geom.yTicks.map((v) => (
              <g key={v}>
                <line x1={PX} y1={geom.sy(v)} x2={CW - PX} y2={geom.sy(v)} stroke="rgba(255,255,255,0.07)" />
                <text x={PX - 8} y={geom.sy(v) + 3} textAnchor="end" className="cs-axis">
                  {v.toFixed(2)}
                </text>
              </g>
            ))}
            {geom.xTicks.map((s) => (
              <text key={s} x={geom.sx(s)} y={CH - 8} textAnchor="middle" className="cs-axis">
                {s}
              </text>
            ))}

            {/* honest scatter */}
            {world.evals.map((ev) =>
              ev.record ? null : (
                <circle
                  key={ev.id}
                  cx={geom.sx(ev.step)}
                  cy={geom.sy(ev.perf)}
                  r={2.2}
                  fill="rgba(242,242,240,0.32)"
                  style={{ opacity: chartStep >= ev.step ? 1 : 0, transition: "opacity 300ms var(--ease)" }}
                />
              )
            )}
            {/* frontier steps */}
            {frontierSegs.map((s, i) => (
              <line
                key={i}
                x1={s.x1}
                y1={s.y1}
                x2={s.x2}
                y2={s.y2}
                stroke={GOOD}
                strokeWidth={1.6}
                style={{ opacity: chartStep >= s.at ? 0.9 : 0, transition: "opacity 400ms var(--ease)" }}
              />
            ))}
            {/* trailing frontier to the cursor */}
            <line ref={trailRef} stroke={GOOD} strokeWidth={1.6} opacity={0.9} />
            {/* records */}
            {world.records.map((rs) => {
              const ev = world.evals[rs];
              return (
                <polygon
                  key={rs}
                  points={hexPoints(geom.sx(ev.step), geom.sy(ev.perf), 6.5)}
                  className="mb-milestone on"
                  style={{ opacity: chartStep >= ev.step ? 1 : 0, transition: "opacity 300ms var(--ease)", cursor: "pointer", pointerEvents: "auto" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    flyToEval(ev.id);
                  }}
                />
              );
            })}
            <line ref={cursorRef} y1={PT - 4} y2={CH - PB + 6} stroke="rgba(242,242,240,0.5)" strokeDasharray="2 3" />
          </svg>
        </div>

        {/* legend */}
        <div className="cs-controls fx-in" style={{ marginTop: 6 }}>
          {[
            [INC_C, "search node"],
            [CAND_C, "best of its search"],
            [BAD, "dead end"],
            ["rgba(242,242,240,0.6)", "a search · a rewrite"],
            [AMBER, "⬡ moved the record"],
            [GOOD, "the frontier"],
          ].map(([c, t]) => (
            <span key={t} className="fx-cap" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i className="fx-dot" style={{ background: c }} />
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
