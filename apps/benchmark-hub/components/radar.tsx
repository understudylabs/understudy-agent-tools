"use client";

import { useMemo, useState } from "react";
import { formatScore } from "@/lib/scores";
import type { ModelSummary } from "@/lib/scores";
import type { BenchmarkManifest } from "@/lib/types";
import { seriesColor } from "@/components/insights";

// Generous padding so axis labels never clip at the card edge.
const SIZE = 340;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 104;

/** Mono axis abbreviation (LiveBench-style: Rsn / Cod / Agt). */
function abbrev(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.map((w) => w[0].toUpperCase()).join("").slice(0, 3);
  const w = words[0] ?? name;
  return w[0].toUpperCase() + w.slice(1, 3);
}

/**
 * "Category profile" radar comparing 2–3 selected arms across categories.
 * Rendered only when ≥3 categories have scored rows (caller gates too).
 */
export function CategoryRadar({
  manifest,
  summaries,
}: {
  manifest: BenchmarkManifest;
  summaries: ModelSummary[];
}) {
  const categories = useMemo(
    () =>
      manifest.taxonomy.filter((c) =>
        summaries.some((s) => (s.categoryDetail[c.category_id]?.rowCount ?? 0) > 0),
      ),
    [manifest.taxonomy, summaries],
  );
  const allModels = summaries.map((s) => s.model);
  const [selected, setSelected] = useState<string[]>(allModels.slice(0, Math.min(3, allModels.length)));

  if (categories.length < 3) return null; // graceful hide

  const remove = (model: string) => setSelected((cur) => cur.filter((m) => m !== model));
  const add = (model: string) =>
    setSelected((cur) => {
      if (cur.includes(model)) return cur;
      if (cur.length >= 3) return [...cur.slice(1), model];
      return [...cur, model];
    });

  const angle = (i: number) => (Math.PI * 2 * i) / categories.length - Math.PI / 2;
  const pt = (i: number, r: number) => [CX + r * Math.cos(angle(i)), CY + r * Math.sin(angle(i))] as const;

  const shown = summaries.filter((s) => selected.includes(s.model));
  const unshown = allModels.filter((m) => !selected.includes(m));

  return (
    <div className="lb-card" style={{ marginTop: 18 }}>
      <h3>Category profile</h3>
      <p className="ch-sub">Per-category strict scores for the selected arms</p>
      <div className="lb-radar-wrap">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="lb-chart"
          style={{ maxWidth: 360 }}
          role="img"
          aria-label="Category profile radar chart"
        >
          {[0.25, 0.5, 0.75, 1].map((t) => (
            <polygon
              key={t}
              points={categories.map((_, i) => pt(i, R * t).join(",")).join(" ")}
              fill="none"
              stroke="#e4e9f2"
            />
          ))}
          {categories.map((c, i) => {
            const [x, y] = pt(i, R);
            const [lx, ly] = pt(i, R + 16);
            return (
              <g key={c.category_id}>
                <line x1={CX} y1={CY} x2={x} y2={y} stroke="#e4e9f2" />
                <text
                  x={lx}
                  y={ly + 3}
                  textAnchor={Math.abs(lx - CX) < 8 ? "middle" : lx > CX ? "start" : "end"}
                  fill="#5a6b85"
                  className="mono"
                  fontSize="10"
                >
                  <title>{c.name ?? c.category_id}</title>
                  {abbrev(c.name ?? c.category_id)}
                </text>
              </g>
            );
          })}
          {shown.map((s, si) => {
            const color = seriesColor(s.model, allModels);
            const pts = categories.map((c, i) => pt(i, R * (s.perCategory[c.category_id] ?? 0)).join(",")).join(" ");
            // Identical traces overlap; vary opacity + dash per slot so all stay visible.
            const dash = ["", "6 4", "2 4"][si] || "";
            const fillOpacity = [0.14, 0.09, 0.06][si] ?? 0.06;
            return (
              <g key={s.model}>
                <polygon
                  points={pts}
                  fill={color}
                  fillOpacity={fillOpacity}
                  stroke={color}
                  strokeWidth="2"
                  strokeDasharray={dash || undefined}
                />
                {categories.map((c, i) => {
                  const [x, y] = pt(i, R * (s.perCategory[c.category_id] ?? 0));
                  // Offset coincident vertices slightly so overlapping arms both show.
                  return <circle key={c.category_id} cx={x} cy={y} r={3.5 - si} fill={color} stroke="#fff" strokeWidth="1.5" />;
                })}
              </g>
            );
          })}
        </svg>
        <div>
          <div className="lb-radar-chips">
            {shown.map((s) => {
              const color = seriesColor(s.model, allModels);
              return (
                <button key={s.model} className="lb-rchip" aria-pressed onClick={() => remove(s.model)}>
                  <span className="sw" style={{ background: color }} />
                  {s.model}
                  <span aria-hidden style={{ color: "var(--faint)" }}>
                    ×
                  </span>
                </button>
              );
            })}
            <select
              className="lb-radar-add"
              value=""
              onChange={(e) => e.target.value && add(e.target.value)}
              disabled={unshown.length === 0}
              aria-label="Add model"
            >
              <option value="">+ Add model…</option>
              {unshown.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <p className="lb-foot-note" style={{ marginTop: 12 }}>
            Compare any 2–3 models · category averages · ranked by overall
          </p>
          {/* table view of the same data (accessibility) */}
          <table className="mono mt-3 text-xs">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left font-medium text-ink-muted">category</th>
                {shown.map((s) => (
                  <th key={s.model} className="px-2 py-1 text-right font-medium" style={{ color: seriesColor(s.model, allModels) }}>
                    {s.model}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.category_id} className="border-t border-rule">
                  <td className="px-2 py-1 text-ink-muted">
                    {abbrev(c.name ?? c.category_id)} — {c.name ?? c.category_id}
                  </td>
                  {shown.map((s) => (
                    <td key={s.model} className="px-2 py-1 text-right tabular-nums">
                      {formatScore(s.perCategory[c.category_id])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
