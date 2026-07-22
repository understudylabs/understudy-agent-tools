"use client";

import { useMemo, useState } from "react";
import { formatCost, formatLatency, formatScore } from "@/lib/scores";
import type { ModelSummary } from "@/lib/scores";
import type { BenchmarkManifest } from "@/lib/types";

/**
 * Per-model categorical slots (LiveBench colors dots per org; we color per
 * model/arm). Values live in globals.css as --series-* — dark-band steps
 * validated all-pairs against #141519 and #000000 (dataviz validator).
 * Fixed order, assigned by alphabetical model name — color follows the
 * entity, never rank.
 */
export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];
const OVERFLOW = "var(--series-overflow)";

export function seriesColor(model: string, allModels: string[]): string {
  const idx = [...allModels].sort().indexOf(model);
  return idx >= 0 && idx < SERIES.length ? SERIES[idx] : OVERFLOW;
}

type XMode = "cost" | "latency";

const W = 640;
const H = 320;
const PAD = { top: 16, right: 24, bottom: 40, left: 48 };
const GUTTER_W = 56; // pinned "≈$0 (local)" band at the left edge
const EPS = 1e-6; // "near-zero spend" threshold for the ≈$0 gutter
const LAT_FLOOR = 1; // ms — log10(0) guard: latencies clamp to this floor

const GRID = "var(--border)";
const MUTED = "var(--muted)";
const ACCENT = "var(--accent)"; // stamp — dashed value-frontier line

/** Score getter for the active cost-view scope (Overall or one category). */
function scopedScore(s: ModelSummary, scope: string | null): number | null {
  return scope ? (s.perCategory[scope] ?? null) : s.overall;
}

/**
 * Insights block: "COST VIEW" scope chips + two side-by-side cards
 * (quality-vs-cost scatter with value frontier; cost-ranked bars).
 */
export function InsightsSection({
  manifest,
  summaries,
}: {
  manifest: BenchmarkManifest;
  summaries: ModelSummary[];
}) {
  const [scope, setScope] = useState<string | null>(null);
  return (
    <div>
      <div className="lb-cats" style={{ marginTop: 18 }}>
        <span className="lb-cats-label">Cost view</span>
        <button className="lb-chip" aria-pressed={scope == null} onClick={() => setScope(null)}>
          Overall
        </button>
        {manifest.taxonomy.map((c) => (
          <button
            key={c.category_id}
            className="lb-chip"
            aria-pressed={scope === c.category_id}
            onClick={() => setScope((cur) => (cur === c.category_id ? null : c.category_id))}
          >
            {c.name ?? c.category_id}
          </button>
        ))}
      </div>
      <div className="lb-ins-grid" style={{ marginTop: 0 }}>
        <QualityCostScatter summaries={summaries} scope={scope} />
        <CostRanked summaries={summaries} />
      </div>
    </div>
  );
}

/**
 * Quality-vs-cost scatter: strict score (y) vs cost-per-successful-task
 * (x, log). Zero/near-zero-cost arms (local routes) render in a pinned
 * "≈$0 (local)" gutter band instead of being dropped from the log axis.
 * A step "value frontier" line traces the best score at each cost.
 */
export function QualityCostScatter({
  summaries,
  scope = null,
}: {
  summaries: ModelSummary[];
  scope?: string | null;
}) {
  const [xMode, setXMode] = useState<XMode>("cost");
  const [hover, setHover] = useState<string | null>(null);

  const points = useMemo(() => {
    const usable = summaries.filter(
      (s) => scopedScore(s, scope) != null && (xMode === "cost" ? s.totalCost != null : s.p50LatencyMs != null),
    );
    return usable.map((s) => {
      // costPerSuccess is null for zero-score arms; those plot at their RAW
      // total cost (they still spent money) as hollow "no successes" dots.
      const noSuccess = xMode === "cost" && s.costPerSuccess == null;
      const rawLatency = s.p50LatencyMs as number;
      return {
        model: s.model,
        y: scopedScore(s, scope) as number,
        // log10(0) guard: latency clamps to a 1ms floor.
        x: xMode === "cost" ? (s.costPerSuccess ?? (s.totalCost as number)) : Math.max(rawLatency, LAT_FLOOR),
        clamped: xMode === "latency" && rawLatency < LAT_FLOOR,
        noSuccess,
        totalCost: s.totalCost,
        route: s.route,
      };
    });
  }, [summaries, xMode, scope]);

  const allModels = summaries.map((s) => s.model);

  if (points.length === 0) {
    return (
      <div className="lb-card">
        <h3>Quality vs. cost</h3>
        <div className="lb-state">
          No arms carry {xMode === "cost" ? "cost" : "latency"} data yet — rows need a numeric{" "}
          <code className="mono">{xMode === "cost" ? "cost" : "latency_ms"}</code> field.
        </div>
      </div>
    );
  }

  // Gutter membership requires actual near-zero SPEND (Σ row costs < EPS),
  // never a null costPerSuccess — a costly zero-score arm must not render as
  // "≈$0 (local)" nor seed the frontier as cheapest.
  const gutterPts = xMode === "cost" ? points.filter((p) => (p.totalCost as number) < EPS) : [];
  const plotPts = points.filter((p) => !gutterPts.includes(p) && p.x > 0);

  const xs = plotPts.map((p) => p.x);
  const xMin = xs.length ? Math.min(...xs) : 1;
  const xMax = xs.length ? Math.max(...xs) : 10;
  const lo = Math.log10(xMin) - 0.25;
  const hi = Math.log10(xMax) + 0.25;
  const plotLeft = PAD.left + (gutterPts.length > 0 ? GUTTER_W : 0);
  const plotW = W - plotLeft - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const xPos = (x: number) => plotLeft + ((Math.log10(x) - lo) / Math.max(hi - lo, 0.01)) * plotW;
  // y-domain scales to the data: low-scoring benchmarks (e.g. 8% strict) get
  // headroom-fitted axes instead of a squashed band at the bottom of 0–100%.
  const yDataMax = points.length ? Math.max(...points.map((p) => p.y)) : 1;
  const yStep = [0.0125, 0.025, 0.05, 0.125, 0.25].find((s) => yDataMax * 1.15 <= s * 4) ?? 0.25;
  const yTop = yStep * 4;
  const yTicks = [0, 1, 2, 3, 4].map((i) => i * yStep);
  const yPos = (y: number) => PAD.top + (1 - y / yTop) * plotH;

  // Step value frontier: best score at each cost, walking left → right.
  // Gutter (≈$0 actual spend) arms are cheapest by definition and seed the
  // frontier; "no successes" arms never join it.
  const ordered = [
    ...gutterPts.map((p) => ({ ...p, px: plotLeft - GUTTER_W / 2 })),
    ...plotPts.map((p) => ({ ...p, px: xPos(p.x) })).sort((a, b) => a.px - b.px),
  ];
  const frontier: { px: number; py: number }[] = [];
  let best = -1;
  for (const p of ordered) {
    if (p.noSuccess) continue;
    if (p.y > best) {
      best = p.y;
      frontier.push({ px: p.px, py: yPos(p.y) });
    }
  }
  // The frontier's trailing step ends at the last REAL point, not the axis edge.
  const lastRealPx = ordered.length > 0 ? Math.max(...ordered.filter((p) => !p.noSuccess).map((p) => p.px), -1) : -1;
  let frontierPath = "";
  let frontierArea = "";
  if (frontier.length > 0) {
    frontierPath = `M ${frontier[0].px} ${frontier[0].py}`;
    for (let i = 1; i < frontier.length; i++) {
      frontierPath += ` H ${frontier[i].px} V ${frontier[i].py}`;
    }
    if (lastRealPx > frontier[frontier.length - 1].px) frontierPath += ` H ${lastRealPx}`;
    // Evidence gradient: area under the frontier (accent 18% → transparent,
    // stops centralized in globals.css as --grad-frontier-top).
    frontierArea = `${frontierPath} V ${H - PAD.bottom} H ${frontier[0].px} Z`;
  }

  // log ticks at powers of 10
  const ticks: number[] = [];
  for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) {
    const v = Math.pow(10, e);
    if (Math.log10(v) >= lo && Math.log10(v) <= hi) ticks.push(v);
  }

  return (
    <div className="lb-card">
      <div className="lb-card-tools" style={{ float: "right", display: "flex", gap: 6 }}>
        {(["cost", "latency"] as XMode[]).map((m) => (
          <button key={m} className="lb-chip" aria-pressed={xMode === m} onClick={() => setXMode(m)}>
            {m === "cost" ? "x: cost / success" : "x: p50 latency"}
          </button>
        ))}
      </div>
      <h3>Quality vs. cost</h3>
      <p className="ch-sub">
        Strict score vs {xMode === "cost" ? "cost per successful task (log x)" : "p50 latency (log x)"} · dashed line = value
        frontier
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="lb-chart" role="img" aria-label="Quality versus cost scatter plot">
        <defs>
          {/* Area under the value frontier — accent wash, gone by the baseline */}
          <linearGradient id="qc-frontier-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--grad-frontier-top)" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
          {/* Tiny radial highlight overlaid on every scatter dot */}
          <radialGradient id="qc-dot-sheen" cx="0.35" cy="0.3" r="0.65">
            <stop offset="0" stopColor="var(--chart-dot-sheen)" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* y gridlines + labels */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={yPos(t)} y2={yPos(t)} stroke={GRID} />
            <text x={PAD.left - 6} y={yPos(t) + 3} textAnchor="end" fill={MUTED} className="mono" fontSize="9">
              {Number.isInteger(t * 100) ? t * 100 : (t * 100).toFixed(2).replace(/0$/, "")}%
            </text>
          </g>
        ))}
        {/* x ticks */}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={xPos(v)} x2={xPos(v)} y1={PAD.top} y2={H - PAD.bottom} stroke={GRID} />
            <text x={xPos(v)} y={H - PAD.bottom + 14} textAnchor="middle" fill={MUTED} className="mono" fontSize="9">
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
              fill="var(--ground)"
              stroke="var(--border-strong)"
              strokeDasharray="3 3"
            />
            <text x={PAD.left + GUTTER_W / 2} y={H - PAD.bottom + 14} textAnchor="middle" fill={MUTED} className="mono" fontSize="9">
              ≈$0 (local)
            </text>
          </g>
        )}
        {/* value frontier (+ evidence area fill beneath it) */}
        {frontierArea && <path d={frontierArea} fill="url(#qc-frontier-fill)" stroke="none" />}
        {frontierPath && <path d={frontierPath} fill="none" stroke={ACCENT} strokeWidth="1.5" strokeDasharray="5 3" opacity="0.85" />}
        {/* marks */}
        {ordered.map((p) => {
          const color = seriesColor(p.model, allModels);
          const isHover = hover === p.model;
          return (
            <g key={p.model} onMouseEnter={() => setHover(p.model)} onMouseLeave={() => setHover(null)}>
              {/* oversize hit target */}
              <circle cx={p.px} cy={yPos(p.y)} r={14} fill="transparent" />
              {p.noSuccess ? (
                // Hollow dot: real spend, zero successes — off the frontier.
                <circle cx={p.px} cy={yPos(p.y)} r={isHover ? 6 : 5} fill="var(--surface)" stroke={color} strokeWidth="2" />
              ) : (
                <>
                  <circle cx={p.px} cy={yPos(p.y)} r={isHover ? 6 : 5} fill={color} stroke="var(--surface)" strokeWidth="2" />
                  {/* radial sheen on top of the series color (identity unchanged) */}
                  <circle cx={p.px} cy={yPos(p.y)} r={isHover ? 6 : 5} fill="url(#qc-dot-sheen)" pointerEvents="none" />
                </>
              )}
              {isHover && (
                <text x={p.px + 9} y={yPos(p.y) + 15} fill={MUTED} className="mono" fontSize="9">
                  {formatScore(p.y)} ·{" "}
                  {xMode === "cost"
                    ? p.noSuccess
                      ? formatCost(p.x) + " spent · no successes"
                      : (p.totalCost as number) < EPS
                        ? "≈$0"
                        : formatCost(p.x) + "/success"
                    : (p.clamped ? "≤" : "") + formatLatency(p.x)}
                </text>
              )}
            </g>
          );
        })}
        <text x={W - PAD.right} y={H - 4} textAnchor="end" fill={MUTED} className="mono" fontSize="9">
          — value frontier (best score at each {xMode === "cost" ? "cost" : "latency"})
        </text>
      </svg>
      <div className="lb-legend">
        {allModels.map((m) => (
          <span key={m} className="li">
            <span className="sw" style={{ background: seriesColor(m, allModels) }} />
            {m}
          </span>
        ))}
      </div>
    </div>
  );
}

/** "Cost, ranked" — horizontal cost-per-success bars, one row per arm. */
export function CostRanked({ summaries }: { summaries: ModelSummary[] }) {
  const allModels = summaries.map((s) => s.model);
  const withCost = useMemo(
    () =>
      summaries
        .filter((s) => s.totalCost != null)
        // null costPerSuccess = no successes: sorts LAST, never "cheapest".
        .sort(
          (a, b) =>
            (a.costPerSuccess ?? Number.POSITIVE_INFINITY) - (b.costPerSuccess ?? Number.POSITIVE_INFINITY),
        ),
    [summaries],
  );
  const [shown, setShown] = useState<string[]>(withCost.slice(0, 8).map((s) => s.model));
  const hidden = withCost.filter((s) => !shown.includes(s.model));
  const rows = withCost.filter((s) => shown.includes(s.model));
  const max = Math.max(...rows.map((s) => s.costPerSuccess ?? 0), 1e-9);

  return (
    <div className="lb-card">
      <h3>Cost, ranked</h3>
      <p className="ch-sub">Cost per successful task, cheapest first · ≈$0 = local route</p>
      <div className="lb-bar-add">
        <select
          className="lb-org-select"
          value=""
          onChange={(e) => e.target.value && setShown((cur) => [...cur, e.target.value])}
          disabled={hidden.length === 0}
          aria-label="Add a model"
        >
          <option value="">Add a model…</option>
          {hidden.map((s) => (
            <option key={s.model} value={s.model}>
              {s.model}
            </option>
          ))}
        </select>
      </div>
      {rows.length === 0 ? (
        <div className="lb-state">No arms carry cost data yet.</div>
      ) : (
        rows.map((s) => {
          const color = seriesColor(s.model, allModels);
          const noSuccess = s.costPerSuccess == null;
          const v = s.costPerSuccess ?? 0;
          return (
            <div key={s.model} className="lb-bar">
              <span className="name">
                <span className="lb-mdot" style={{ background: color }} />
                {s.model}
              </span>
              <span className="track">
                <span
                  className="fill"
                  // along-the-bar gradient lives in globals.css, keyed off --bar-color
                  style={{ display: "block", width: `${Math.max((v / max) * 100, 1.5)}%`, "--bar-color": color } as React.CSSProperties}
                />
              </span>
              <span className="val">{noSuccess ? "no successes" : v < EPS ? "≈$0" : formatCost(v)}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
