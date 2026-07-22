"use client";

import { useMemo, useState } from "react";
import { formatCost, formatLatency, formatScore, TRIVIAL_ARM_LABELS } from "@/lib/scores";
import {
  availableAxes,
  PARETO_AXES,
  paretoFrontier,
  paretoPointsToCsv,
  paretoTieGroups,
  type ParetoAxis,
  type ParetoPoint,
} from "@/lib/pareto";
import { seriesColor } from "@/components/insights";

/**
 * "Trade-offs" — multi-objective Pareto view (the und-289 payoff shape):
 * quality (y, CI whiskers) vs a selectable objective (cost | latency |
 * tokens/sec), the non-dominated frontier traced as a step line, incumbent
 * highlighted, trivial calibration floors as horizontal reference lines.
 * Hand-rolled SVG on the trace-viewer theme contract, matching insights.tsx.
 */

const W = 640;
const H = 340;
const PAD = { top: 18, right: 120, bottom: 40, left: 48 }; // right pad hosts arm labels

const GRID = "var(--border)";
const MUTED = "var(--muted-foreground)";
const ACCENT = "var(--primary)";

function formatAxisValue(axis: ParetoAxis, v: number): string {
  if (axis === "costPerTask") return formatCost(v);
  if (axis === "latencyMeanMs") return formatLatency(v);
  return v >= 100 ? Math.round(v) + " tok/s" : v.toFixed(1) + " tok/s";
}

export function ParetoSection({ points }: { points: ParetoPoint[] }) {
  const axes = useMemo(() => availableAxes(points), [points]);
  const [axis, setAxis] = useState<ParetoAxis | null>(null);
  const activeAxis: ParetoAxis | null = axis && axes.includes(axis) ? axis : (axes[0] ?? null);

  const csvHref = useMemo(
    () => "data:text/csv;charset=utf-8," + encodeURIComponent(paretoPointsToCsv(points)),
    [points],
  );

  if (activeAxis == null) {
    // Sparse-data honesty: fewer than 2 arms carry any secondary objective —
    // no trade-off exists, so say that instead of rendering an empty chart.
    return (
      <div className="u-card">
        <h3>Trade-offs</h3>
        <div className="u-state">
          No trade-off to plot yet — fewer than 2 arms carry cost, latency, or throughput data alongside a score.
          Rows need a numeric <code className="mono">cost</code>, <code className="mono">latency_ms</code>, or{" "}
          <code className="mono">tokens_per_sec</code> field.
        </div>
        <p className="u-foot-note">
          <a href={csvHref} download="pareto-points.csv" className="mono">
            download projected points (CSV)
          </a>
        </p>
      </div>
    );
  }

  return (
    <ParetoChart
      points={points}
      axis={activeAxis}
      axes={axes}
      onAxisChange={setAxis}
      csvHref={csvHref}
    />
  );
}

function ParetoChart({
  points,
  axis,
  axes,
  onAxisChange,
  csvHref,
}: {
  points: ParetoPoint[];
  axis: ParetoAxis;
  axes: ParetoAxis[];
  onAxisChange: (a: ParetoAxis) => void;
  csvHref: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const axisMeta = PARETO_AXES.find((a) => a.key === axis)!;

  const candidates = points.filter((p) => !p.trivial && p.quality != null && p[axis] != null);
  const floors = points.filter((p) => p.trivial && p.quality != null);
  const frontier = useMemo(
    () =>
      paretoFrontier(points, [
        { key: "quality", direction: "max" },
        { key: axis, direction: axisMeta.direction },
      ]),
    [points, axis, axisMeta.direction],
  );
  const frontierSet = new Set(frontier.map((p) => p.model));
  const ties = useMemo(() => paretoTieGroups(points), [points]);
  const allModels = points.filter((p) => !p.trivial).map((p) => p.model);

  // x scale: log when every value is positive (cost/latency span orders of
  // magnitude), linear otherwise (e.g. ≈$0 local arms; log10(0) is a lie).
  const xs = candidates.map((p) => p[axis] as number);
  const useLog = xs.every((v) => v > 0) && Math.max(...xs) / Math.min(...xs) > 20;
  const xMinRaw = Math.min(...xs);
  const xMaxRaw = Math.max(...xs);
  const lo = useLog ? Math.log10(xMinRaw) - 0.2 : xMinRaw - Math.max((xMaxRaw - xMinRaw) * 0.06, 1e-9);
  const hi = useLog ? Math.log10(xMaxRaw) + 0.2 : xMaxRaw + Math.max((xMaxRaw - xMinRaw) * 0.06, 1e-9);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const xPos = (x: number) =>
    PAD.left + (((useLog ? Math.log10(x) : x) - lo) / Math.max(hi - lo, 1e-9)) * plotW;

  // y domain fits the data (CI tops included) instead of squashing low scores.
  const yDataMax = Math.max(...candidates.map((p) => p.ci?.hi ?? (p.quality as number)), ...floors.map((p) => p.quality as number), 0.01);
  const yStep = [0.0125, 0.025, 0.05, 0.125, 0.25].find((s) => yDataMax * 1.1 <= s * 4) ?? 0.25;
  const yTop = yStep * 4;
  const yTicks = [0, 1, 2, 3, 4].map((i) => i * yStep);
  const yPos = (y: number) => PAD.top + (1 - Math.min(y, yTop) / yTop) * plotH;

  // x ticks: powers of 10 on log, 5 even ticks on linear.
  const xTicks: number[] = [];
  if (useLog) {
    for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) {
      if (e >= lo && e <= hi) xTicks.push(Math.pow(10, e));
    }
  } else {
    for (let i = 0; i <= 4; i++) xTicks.push(lo + ((hi - lo) * i) / 4);
  }

  // Frontier step path: walk the non-dominated set in x order and trace the
  // staircase (each step holds the best quality until the next frontier arm).
  const steps = frontier
    .map((p) => ({ px: xPos(p[axis] as number), py: yPos(p.quality as number) }))
    .sort((a, b) => a.px - b.px);
  let frontierPath = "";
  if (steps.length > 0) {
    frontierPath = `M ${steps[0].px} ${steps[0].py}`;
    for (let i = 1; i < steps.length; i++) frontierPath += ` H ${steps[i].px} V ${steps[i].py}`;
  }

  const tieLetter = (model: string) => {
    const g = ties.get(model);
    return g == null ? null : String.fromCharCode(65 + (g % 26));
  };

  return (
    <div className="u-card">
      <div className="u-card-tools" style={{ float: "right", display: "flex", gap: 6, alignItems: "center" }}>
        {axes.map((a) => {
          const meta = PARETO_AXES.find((m) => m.key === a)!;
          return (
            <button key={a} className="u-chip" aria-pressed={axis === a} onClick={() => onAxisChange(a)}>
              x: {meta.label}
            </button>
          );
        })}
      </div>
      <h3>Trade-offs</h3>
      <p className="ch-sub">
        Quality (95% CI whiskers) vs {axisMeta.label} ({axisMeta.direction === "min" ? "lower" : "higher"} is better
        {useLog ? ", log x" : ""}) · dashed steps = Pareto frontier · shared letter = statistical tie
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="u-chart" role="img" aria-label={`Quality versus ${axisMeta.label} Pareto scatter`}>
        {/* y gridlines */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={yPos(t)} y2={yPos(t)} stroke={GRID} />
            <text x={PAD.left - 6} y={yPos(t) + 3} textAnchor="end" fill={MUTED} className="mono" fontSize="9">
              {Number.isInteger(t * 100) ? t * 100 : (t * 100).toFixed(2).replace(/0$/, "")}%
            </text>
          </g>
        ))}
        {/* x ticks */}
        {xTicks.map((v, i) => (
          <g key={i}>
            <line x1={xPos(v)} x2={xPos(v)} y1={PAD.top} y2={H - PAD.bottom} stroke={GRID} />
            <text x={xPos(v)} y={H - PAD.bottom + 14} textAnchor="middle" fill={MUTED} className="mono" fontSize="9">
              {formatAxisValue(axis, v)}
            </text>
          </g>
        ))}
        {/* trivial-arm floors: horizontal reference lines, never candidates */}
        {floors.map((p) => (
          <g key={p.model}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yPos(p.quality as number)}
              y2={yPos(p.quality as number)}
              stroke="var(--bad)"
              strokeDasharray="2 4"
              opacity="0.7"
            />
            <text
              x={W - PAD.right + 4}
              y={yPos(p.quality as number) + 3}
              fill="var(--bad)"
              className="mono"
              fontSize="9"
              opacity="0.85"
            >
              {(TRIVIAL_ARM_LABELS as Record<string, string>)[p.model] ?? p.model} floor {formatScore(p.quality)}
            </text>
          </g>
        ))}
        {/* Pareto frontier staircase */}
        {frontierPath && (
          <path d={frontierPath} fill="none" stroke={ACCENT} strokeWidth="1.5" strokeDasharray="5 3" opacity="0.85" />
        )}
        {/* arms: CI whisker + dot + label */}
        {candidates.map((p) => {
          const color = seriesColor(p.model, allModels);
          const px = xPos(p[axis] as number);
          const py = yPos(p.quality as number);
          const onFrontier = frontierSet.has(p.model);
          const isHover = hover === p.model;
          const letter = tieLetter(p.model);
          return (
            <g key={p.model} onMouseEnter={() => setHover(p.model)} onMouseLeave={() => setHover(null)}>
              <circle cx={px} cy={py} r={14} fill="transparent" />
              {p.ci && p.ci.hi > p.ci.lo && (
                <g stroke={color} strokeWidth="1.25" opacity="0.7">
                  <line x1={px} x2={px} y1={yPos(p.ci.lo)} y2={yPos(p.ci.hi)} />
                  <line x1={px - 3.5} x2={px + 3.5} y1={yPos(p.ci.lo)} y2={yPos(p.ci.lo)} />
                  <line x1={px - 3.5} x2={px + 3.5} y1={yPos(p.ci.hi)} y2={yPos(p.ci.hi)} />
                </g>
              )}
              {/* incumbent: accent ring around the dot */}
              {p.incumbent && <circle cx={px} cy={py} r={isHover ? 9 : 8} fill="none" stroke={ACCENT} strokeWidth="1.5" opacity="0.9" />}
              <circle
                cx={px}
                cy={py}
                r={isHover ? 6 : 5}
                fill={onFrontier ? color : "var(--surface-opaque)"}
                stroke={onFrontier ? "var(--surface-opaque)" : color}
                strokeWidth="2"
              />
              <text x={px + 9} y={py + 3} fill={isHover ? "var(--foreground)" : MUTED} className="mono" fontSize="9">
                {p.model}
                {p.incumbent ? " (incumbent)" : ""}
                {letter ? ` ≈${letter}` : ""}
              </text>
              {isHover && (
                <text x={px + 9} y={py + 15} fill={MUTED} className="mono" fontSize="9">
                  {formatScore(p.quality)} · {formatAxisValue(axis, p[axis] as number)}
                  {onFrontier ? " · on frontier" : " · dominated"}
                </text>
              )}
            </g>
          );
        })}
        <text x={W - PAD.right} y={H - 4} textAnchor="end" fill={MUTED} className="mono" fontSize="9">
          filled = non-dominated · hollow = dominated
        </text>
      </svg>
      <div className="u-legend">
        {allModels.map((m) => (
          <span key={m} className="li">
            <span className="sw" style={{ background: seriesColor(m, allModels) }} />
            {m}
          </span>
        ))}
      </div>
      <p className="u-foot-note">
        {frontier.length} of {candidates.length} arms non-dominated on quality × {axisMeta.label}
        {floors.length > 0 ? ` · ${floors.length} trivial floor${floors.length === 1 ? "" : "s"} shown as reference lines` : ""}
        {" · "}
        <a href={csvHref} download="pareto-points.csv" className="mono">
          download projected points (CSV)
        </a>
      </p>
    </div>
  );
}
