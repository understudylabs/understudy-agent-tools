"use client";

import { Fragment, useMemo, useState } from "react";
import { computeLeaderboard, formatCost, formatLatency, formatScore, hasSplits } from "@/lib/scores";
import type { BenchmarkManifest, EvalRow, TaskSplit } from "@/lib/types";
import { RouteBadge } from "@/components/badges";
import { cn } from "@/lib/utils";

type SortKey =
  | "model"
  | "overall"
  | "costPerSuccess"
  | "p50"
  | "tasks"
  | "unscored"
  | "errors"
  | `cat:${string}`;

/** Numeric column ids used for top-3 shading. */
type ShadeCol = "overall" | "costPerSuccess" | "p50" | `cat:${string}`;

export function Leaderboard({
  manifest,
  rows,
  flaggedTaskIds,
}: {
  manifest: BenchmarkManifest;
  rows: EvalRow[];
  flaggedTaskIds: string[];
}) {
  const splitsExist = hasSplits(manifest);
  const [excludeFlagged, setExcludeFlagged] = useState(true);
  const [split, setSplit] = useState<TaskSplit | "all">(splitsExist ? "holdout" : "all");
  const [sortKey, setSortKey] = useState<SortKey>("overall");
  const [sortDesc, setSortDesc] = useState(true);
  const [category, setCategory] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const summaries = useMemo(() => {
    const list = computeLeaderboard(manifest, rows, {
      excludeTaskIds: excludeFlagged ? new Set(flaggedTaskIds) : undefined,
      split,
    });
    const value = (s: (typeof list)[number]): number | string => {
      if (sortKey === "model") return s.model;
      if (sortKey === "overall") return (category ? s.perCategory[category] : s.overall) ?? -1;
      if (sortKey === "costPerSuccess") return s.costPerSuccess ?? Number.POSITIVE_INFINITY;
      if (sortKey === "p50") return s.p50LatencyMs ?? Number.POSITIVE_INFINITY;
      if (sortKey === "tasks") return s.taskCount;
      if (sortKey === "unscored") return s.unscoredCount;
      if (sortKey === "errors") return s.errorCount;
      return s.perCategory[sortKey.slice(4)] ?? -1;
    };
    list.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sortDesc ? -c : c;
    });
    return list;
  }, [manifest, rows, flaggedTaskIds, excludeFlagged, split, sortKey, sortDesc, category]);

  // Top-3 shading per numeric column. Lower is better for cost + latency.
  const topRanks = useMemo(() => {
    const ranks = new Map<ShadeCol, Map<string, number>>();
    const rank = (col: ShadeCol, get: (s: (typeof summaries)[number]) => number | null, asc: boolean) => {
      const vals = summaries
        .map((s) => ({ model: s.model, v: get(s) }))
        .filter((x): x is { model: string; v: number } => x.v != null)
        .sort((a, b) => (asc ? a.v - b.v : b.v - a.v));
      const m = new Map<string, number>();
      vals.slice(0, 3).forEach((x, i) => m.set(x.model, i));
      ranks.set(col, m);
    };
    rank("overall", (s) => (category ? s.perCategory[category] : s.overall), false);
    rank("costPerSuccess", (s) => s.costPerSuccess, true);
    rank("p50", (s) => s.p50LatencyMs, true);
    for (const c of manifest.taxonomy) rank(`cat:${c.category_id}`, (s) => s.perCategory[c.category_id], false);
    return ranks;
  }, [summaries, manifest.taxonomy, category]);

  const shade = (col: ShadeCol, model: string) => {
    const r = topRanks.get(col)?.get(model);
    if (r == null) return "";
    return ["bg-stamp/15", "bg-stamp/10", "bg-stamp/5"][r];
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(key !== "model");
    }
  };

  const toggleExpanded = (model: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });

  const header = (key: SortKey, label: string, align: "left" | "right" = "right") => (
    <th
      onClick={() => toggleSort(key)}
      className={cn(
        "cursor-pointer select-none whitespace-nowrap px-3 py-2 font-mono text-[11px] font-medium text-ink-muted hover:text-ink",
        align === "right" ? "text-right" : "text-left",
        sortKey === key && "text-ink",
      )}
    >
      {label}
      {sortKey === key ? (sortDesc ? " ↓" : " ↑") : ""}
    </th>
  );

  const visibleCategories = category
    ? manifest.taxonomy.filter((c) => c.category_id === category)
    : manifest.taxonomy;
  const nCols = 7 + visibleCategories.length;
  const denseMetric = manifest.verifier.dense_metric;

  return (
    <div>
      {/* Category chips: re-scope the columns to one category's view. */}
      {manifest.taxonomy.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setCategory(null)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 font-mono text-[11px]",
              category == null ? "border-stamp/60 bg-stamp/10 text-stamp" : "border-rule-strong text-ink-muted hover:text-ink",
            )}
          >
            all categories
          </button>
          {manifest.taxonomy.map((c) => (
            <button
              key={c.category_id}
              onClick={() => setCategory((cur) => (cur === c.category_id ? null : c.category_id))}
              className={cn(
                "rounded-full border px-2.5 py-0.5 font-mono text-[11px]",
                category === c.category_id
                  ? "border-stamp/60 bg-stamp/10 text-stamp"
                  : "border-rule-strong text-ink-muted hover:text-ink",
              )}
            >
              {c.name ?? c.category_id}
            </button>
          ))}
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-1.5 text-ink-muted">
          <input
            type="checkbox"
            checked={excludeFlagged}
            onChange={(e) => setExcludeFlagged(e.target.checked)}
            className="accent-[#d7623e]"
          />
          Exclude flagged tasks ({flaggedTaskIds.length})
        </label>
        <label className="flex items-center gap-1.5 text-ink-muted">
          Split
          <select
            value={split}
            onChange={(e) => setSplit(e.target.value as TaskSplit | "all")}
            className="rounded border border-rule-strong bg-paper px-2 py-0.5 font-mono"
          >
            <option value="all">all</option>
            <option value="holdout">holdout</option>
            <option value="dev">dev</option>
            <option value="train">train</option>
            <option value="none">none</option>
          </select>
        </label>
        {splitsExist && split !== "holdout" && (
          <span className="text-warn">Non-holdout view: numbers may be optimizer-touched.</span>
        )}
      </div>
      {summaries.length === 0 ? (
        <div className="rounded-md border border-rule bg-card p-4 text-sm text-ink-muted">
          No eval rows match this filter. Drop rows-*.jsonl (understudy.eval_result.v1) next to benchmark.json, or
          widen the split filter.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-rule">
          <table className="w-full border-collapse bg-card text-sm">
            <thead className="border-b border-rule">
              <tr>
                {header("model", "model", "left")}
                {header("overall", category ? `${category} (strict)` : "overall (strict)")}
                {header("costPerSuccess", "cost / success")}
                {header("p50", "p50 latency")}
                {visibleCategories.map((c) => header(`cat:${c.category_id}`, c.name ?? c.category_id))}
                {header("tasks", "tasks")}
                {header("unscored", "unscored")}
                {header("errors", "errors")}
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => {
                const isOpen = expanded.has(s.model);
                return (
                  <Fragment key={s.model}>
                    <tr
                      onClick={() => toggleExpanded(s.model)}
                      className={cn("cursor-pointer border-b border-rule last:border-0 hover:bg-hover", isOpen && "bg-hover/50")}
                      aria-expanded={isOpen}
                    >
                      <td className="px-3 py-2.5 font-mono text-xs">
                        <span className="mr-1.5 inline-block w-3 text-ink-muted">{isOpen ? "▾" : "▸"}</span>
                        {s.model}
                        <span className="ml-2">
                          <RouteBadge route={s.route} />
                        </span>
                      </td>
                      <td className={cn("px-3 py-2.5 text-right font-mono text-base font-bold tabular-nums", shade("overall", s.model))}>
                        {formatScore(category ? s.perCategory[category] : s.overall)}
                      </td>
                      <td className={cn("px-3 py-2.5 text-right font-mono tabular-nums", shade("costPerSuccess", s.model))}>
                        {formatCost(s.costPerSuccess)}
                      </td>
                      <td className={cn("px-3 py-2.5 text-right font-mono tabular-nums", shade("p50", s.model))}>
                        {formatLatency(s.p50LatencyMs)}
                      </td>
                      {visibleCategories.map((c) => (
                        <td
                          key={c.category_id}
                          className={cn(
                            "px-3 py-2.5 text-right font-mono tabular-nums text-ink-muted",
                            shade(`cat:${c.category_id}`, s.model),
                          )}
                        >
                          {formatScore(s.perCategory[c.category_id])}
                        </td>
                      ))}
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">{s.taskCount}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-muted">{s.unscoredCount}</td>
                      <td className={cn("px-3 py-2.5 text-right font-mono tabular-nums", s.errorCount > 0 ? "text-bad" : "text-ink-muted")}>
                        {s.errorCount}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-rule last:border-0">
                        <td colSpan={nCols} className="bg-paper/60 px-6 py-4">
                          <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-ink-muted">
                            Per-category breakdown — {s.model}
                          </div>
                          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                            {manifest.taxonomy.map((c) => {
                              const d = s.categoryDetail[c.category_id];
                              return (
                                <div key={c.category_id} className="rounded-md border border-rule bg-card p-3">
                                  <div className="text-xs font-medium">{c.name ?? c.category_id}</div>
                                  <div className="mt-1.5 flex flex-col gap-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
                                    <div className="flex justify-between gap-3">
                                      <span>strict ({manifest.verifier.strict_metric})</span>
                                      <span className="font-semibold text-ink">{formatScore(d?.strict)}</span>
                                    </div>
                                    <div className="flex justify-between gap-3">
                                      <span>dense ({denseMetric ?? "n/a"})</span>
                                      <span>{denseMetric ? formatScore(d?.dense) : "—"}</span>
                                    </div>
                                    <div className="flex justify-between gap-3">
                                      <span>rows</span>
                                      <span>{d?.rowCount ?? 0}</span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {/* Legibility footnotes: state the formulas in force. */}
      <div className="mt-2 flex flex-col gap-0.5 font-mono text-[11px] leading-4 text-ink-muted/80">
        <span>{"// overall = mean strict score (" + manifest.verifier.strict_metric + ") over scored rows (status ok, score present)"}</span>
        <span>{"// cost/success = Σ cost ÷ scored rows ÷ mean strict score; blank when rows carry no cost or score is 0"}</span>
        <span>{"// dense metric: " + (denseMetric ?? "none declared in manifest")}</span>
        <span>{"// shading marks the top 3 per column (score: higher better; cost + latency: lower better)"}</span>
        <span>
          {excludeFlagged
            ? `// flagged tasks are EXCLUDED right now (${flaggedTaskIds.length} open task flags)`
            : `// flagged tasks are INCLUDED right now (${flaggedTaskIds.length} open task flags)`}
        </span>
      </div>
    </div>
  );
}
