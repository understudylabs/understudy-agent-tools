"use client";

import { useMemo, useState } from "react";
import { formatCost, formatLatency, formatScore } from "@/lib/scores";
import type { ModelSummary } from "@/lib/scores";
import { cn } from "@/lib/utils";

/**
 * Colorblind-safe categorical slots (dataviz skill reference palette, dark
 * steps, validated all-pairs against surface #141519). Fixed order, assigned
 * to arms by alphabetical model name — color follows the entity, never rank.
 */
export const SERIES = ["#3987e5", "#008300", "#d55181", "#c98500"];
const OVERFLOW = "#898781";

export function seriesColor(model: string, allModels: string[]): string {
  const idx = [...allModels].sort().indexOf(model);
  return idx >= 0 && idx < SERIES.length ? SERIES[idx] : OVERFLOW;
}

type XMode = "cost" | "latency";

const W = 640;
const H = 320;
const PAD = { top: 16, right: 24, bottom: 40, left: 48 };
const GUTTER_W = 56; // pinned "≈$0 (local)" band at the left edge

/**
 * Quality-vs-cost scatter: strict score (y) vs cost-per-successful-task
 * (x, log). Zero/near-zero-cost arms (local routes) render in a pinned
 * "≈$0 (local)" gutter band instead of being dropped from the log axis.
 * A step "value frontier" line traces the best score at each cost.
 */
export function QualityCostScatter({ summaries }: { summaries: ModelSummary[] }) {
  const [xMode, setXMode] = useState<XMode>("cost");
  const [hover, setHover] = useState<string | null>(null);

  const points = useMemo(() => {
    const usable = summaries.filter(
      (s) => s.overall != null && (xMode === "cost" ? s.totalCost != null : s.p50LatencyMs != null),
    );
    return usable.map((s) => ({
      model: s.model,
      y: s.overall as number,
      x: xMode === "cost" ? (s.costPerSuccess ?? 0) : (s.p50LatencyMs as number),
      route: s.route,
    }));
  }, [summaries, xMode]);

  const allModels = summaries.map((s) => s.model);

  if (points.length === 0) {
    return (
      <div className="rounded-md border border-rule bg-card p-4 text-sm text-ink-muted">
        No arms carry {xMode === "cost" ? "cost" : "latency"} data yet — rows need a numeric{" "}
        <code className="font-mono">{xMode === "cost" ? "cost" : "latency_ms"}</code> field.
      </div>
    );
  }

  const EPS = 1e-6;
  const gutterPts = xMode === "cost" ? points.filter((p) => p.x < EPS) : [];
  const plotPts = points.filter((p) => !gutterPts.includes(p));

  const xs = plotPts.map((p) => p.x);
  const xMin = xs.length ? Math.min(...xs) : 1;
  const xMax = xs.length ? Math.max(...xs) : 10;
  const lo = Math.log10(xMin) - 0.25;
  const hi = Math.log10(xMax) + 0.25;
  const plotLeft = PAD.left + (gutterPts.length > 0 ? GUTTER_W : 0);
  const plotW = W - plotLeft - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const xPos = (x: number) => plotLeft + ((Math.log10(x) - lo) / Math.max(hi - lo, 0.01)) * plotW;
  const yPos = (y: number) => PAD.top + (1 - y) * plotH;

  // Step value frontier: best score at each cost, walking left → right.
  // Gutter (≈$0) arms are cheapest by definition and seed the frontier.
  const ordered = [
    ...gutterPts.map((p) => ({ ...p, px: plotLeft - GUTTER_W / 2 })),
    ...plotPts.map((p) => ({ ...p, px: xPos(p.x) })).sort((a, b) => a.px - b.px),
  ];
  const frontier: { px: number; py: number }[] = [];
  let best = -1;
  for (const p of ordered) {
    if (p.y > best) {
      best = p.y;
      frontier.push({ px: p.px, py: yPos(p.y) });
    }
  }
  let frontierPath = "";
  if (frontier.length > 0) {
    frontierPath = `M ${frontier[0].px} ${frontier[0].py}`;
    for (let i = 1; i < frontier.length; i++) {
      frontierPath += ` H ${frontier[i].px} V ${frontier[i].py}`;
    }
    frontierPath += ` H ${W - PAD.right}`;
  }

  // log ticks at powers of 10 (and halves when the range is narrow)
  const ticks: number[] = [];
  for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) {
    const v = Math.pow(10, e);
    if (Math.log10(v) >= lo && Math.log10(v) <= hi) ticks.push(v);
  }

  return (
    <div className="rounded-lg border border-rule bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[11px] uppercase tracking-wide text-ink-muted">
          strict score vs {xMode === "cost" ? "cost per successful task (log)" : "p50 latency (log)"}
        </div>
        <div className="flex gap-1.5">
          {(["cost", "latency"] as XMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setXMode(m)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 font-mono text-[11px]",
                xMode === m ? "border-stamp/60 bg-stamp/10 text-stamp" : "border-rule-strong text-ink-muted hover:text-ink",
              )}
            >
              {m === "cost" ? "x: cost / success" : "x: p50 latency"}
            </button>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Quality versus cost scatter plot">
        {/* y gridlines + labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={yPos(t)} y2={yPos(t)} stroke="rgba(255,255,255,0.06)" />
            <text x={PAD.left - 6} y={yPos(t) + 3} textAnchor="end" className="fill-ink-muted font-mono" fontSize="9">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {/* x ticks */}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={xPos(v)} x2={xPos(v)} y1={PAD.top} y2={H - PAD.bottom} stroke="rgba(255,255,255,0.06)" />
            <text x={xPos(v)} y={H - PAD.bottom + 14} textAnchor="middle" className="fill-ink-muted font-mono" fontSize="9">
              {xMode === "cost" ? formatCost(v) : formatLatency(v)}
            </text>
          </g>
        ))}
        {/* ≈$0 gutter band */}
        {gutterPts.length > 0 && (
          <g>
            <rect
              x={PAD.left}
              y={PAD.top}
              width={GUTTER_W}
              height={plotH}
              fill="rgba(255,255,255,0.03)"
              stroke="rgba(255,255,255,0.10)"
              strokeDasharray="3 3"
            />
            <text
              x={PAD.left + GUTTER_W / 2}
              y={H - PAD.bottom + 14}
              textAnchor="middle"
              className="fill-ink-muted font-mono"
              fontSize="9"
            >
              ≈$0 (local)
            </text>
          </g>
        )}
        {/* value frontier */}
        {frontierPath && <path d={frontierPath} fill="none" stroke="#d7623e" strokeWidth="1.5" strokeDasharray="5 3" opacity="0.8" />}
        {/* marks */}
        {ordered.map((p) => {
          const color = seriesColor(p.model, allModels);
          const isHover = hover === p.model;
          return (
            <g key={p.model} onMouseEnter={() => setHover(p.model)} onMouseLeave={() => setHover(null)}>
              {/* oversize hit target */}
              <circle cx={p.px} cy={yPos(p.y)} r={14} fill="transparent" />
              <circle cx={p.px} cy={yPos(p.y)} r={isHover ? 6 : 5} fill={color} stroke="#141519" strokeWidth="2" />
              <text x={p.px + 9} y={yPos(p.y) + 3} className="fill-ink font-mono" fontSize="10">
                {p.model}
              </text>
              {isHover && (
                <text x={p.px + 9} y={yPos(p.y) + 15} className="fill-ink-muted font-mono" fontSize="9">
                  {formatScore(p.y)} ·{" "}
                  {xMode === "cost" ? (p.x < EPS ? "≈$0" : formatCost(p.x) + "/success") : formatLatency(p.x)}
                </text>
              )}
            </g>
          );
        })}
        <text x={W - PAD.right} y={H - 4} textAnchor="end" className="fill-ink-muted font-mono" fontSize="9">
          — value frontier (best score at each {xMode === "cost" ? "cost" : "latency"})
        </text>
      </svg>
    </div>
  );
}
