"use client";

import { useMemo, useState } from "react";
import { formatScore } from "@/lib/scores";
import type { ModelSummary } from "@/lib/scores";
import type { BenchmarkManifest } from "@/lib/types";
import { seriesColor } from "@/components/insights";
import { cn } from "@/lib/utils";

const SIZE = 300;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 100;

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

  const toggle = (model: string) =>
    setSelected((cur) => {
      if (cur.includes(model)) return cur.filter((m) => m !== model);
      if (cur.length >= 3) return [...cur.slice(1), model];
      return [...cur, model];
    });

  const angle = (i: number) => (Math.PI * 2 * i) / categories.length - Math.PI / 2;
  const pt = (i: number, r: number) => [CX + r * Math.cos(angle(i)), CY + r * Math.sin(angle(i))] as const;

  return (
    <div className="rounded-lg border border-rule bg-card p-4">
      <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-ink-muted">
        category profile — select 2–3 arms
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {allModels.map((m) => {
          const on = selected.includes(m);
          const color = seriesColor(m, allModels);
          return (
            <button
              key={m}
              onClick={() => toggle(m)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px]",
                on ? "border-rule-strong text-ink" : "border-rule text-ink-muted hover:text-ink",
              )}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: on ? color : "transparent", boxShadow: on ? "" : `inset 0 0 0 1px ${color}` }}
              />
              {m}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="max-w-[320px] flex-1" role="img" aria-label="Category profile radar chart">
          {[0.25, 0.5, 0.75, 1].map((t) => (
            <polygon
              key={t}
              points={categories.map((_, i) => pt(i, R * t).join(",")).join(" ")}
              fill="none"
              stroke="rgba(255,255,255,0.07)"
            />
          ))}
          {categories.map((c, i) => {
            const [x, y] = pt(i, R);
            const [lx, ly] = pt(i, R + 18);
            return (
              <g key={c.category_id}>
                <line x1={CX} y1={CY} x2={x} y2={y} stroke="rgba(255,255,255,0.07)" />
                <text
                  x={lx}
                  y={ly + 3}
                  textAnchor={Math.abs(lx - CX) < 8 ? "middle" : lx > CX ? "start" : "end"}
                  className="fill-ink-muted font-mono"
                  fontSize="9"
                >
                  {c.name ?? c.category_id}
                </text>
              </g>
            );
          })}
          {summaries
            .filter((s) => selected.includes(s.model))
            .map((s) => {
              const color = seriesColor(s.model, allModels);
              const pts = categories.map((c, i) => pt(i, R * (s.perCategory[c.category_id] ?? 0)).join(",")).join(" ");
              return (
                <g key={s.model}>
                  <polygon points={pts} fill={color} fillOpacity="0.12" stroke={color} strokeWidth="2" />
                  {categories.map((c, i) => {
                    const [x, y] = pt(i, R * (s.perCategory[c.category_id] ?? 0));
                    return <circle key={c.category_id} cx={x} cy={y} r={3} fill={color} stroke="#141519" strokeWidth="1.5" />;
                  })}
                </g>
              );
            })}
        </svg>
        {/* table view of the same data (accessibility) */}
        <table className="text-xs">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left font-mono text-[11px] font-medium text-ink-muted">category</th>
              {summaries
                .filter((s) => selected.includes(s.model))
                .map((s) => (
                  <th key={s.model} className="px-2 py-1 text-right font-mono text-[11px] font-medium" style={{ color: seriesColor(s.model, allModels) }}>
                    {s.model}
                  </th>
                ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.category_id} className="border-t border-rule">
                <td className="px-2 py-1 text-ink-muted">{c.name ?? c.category_id}</td>
                {summaries
                  .filter((s) => selected.includes(s.model))
                  .map((s) => (
                    <td key={s.model} className="px-2 py-1 text-right font-mono tabular-nums">
                      {formatScore(s.perCategory[c.category_id])}
                    </td>
                  ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
