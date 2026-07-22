"use client";

import { Fragment, useMemo, useState } from "react";
import { computeLeaderboard, formatCost, formatLatency, formatScore, hasSplits } from "@/lib/scores";
import type { BenchmarkManifest, EvalRow, TaskSplit } from "@/lib/types";
import { RouteBadge } from "@/components/badges";
import { cn } from "@/lib/utils";

type SortKey = "model" | "overall" | "costPerSuccess" | "p50" | "tasks";

/** Numeric column ids used for top-3 shading. */
type ShadeCol = "overall" | "costPerSuccess" | "p50";

/** Top-3 per-column cell fills — accent tints rederived for the dark field. */
const SHADES = ["var(--shade-1)", "var(--shade-2)", "var(--shade-3)"];

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
  const [localOnly, setLocalOnly] = useState(false);
  const [showRoute, setShowRoute] = useState(true);
  const [search, setSearch] = useState("");
  const [split, setSplit] = useState<TaskSplit | "all">(splitsExist ? "holdout" : "all");
  const [sortKey, setSortKey] = useState<SortKey>("overall");
  const [sortDesc, setSortDesc] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const summaries = useMemo(() => {
    let list = computeLeaderboard(manifest, rows, {
      excludeTaskIds: excludeFlagged ? new Set(flaggedTaskIds) : undefined,
      split,
    });
    if (localOnly) list = list.filter((s) => s.route === "local");
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((s) => s.model.toLowerCase().includes(q));
    }
    const value = (s: (typeof list)[number]): number | string => {
      if (sortKey === "model") return s.model;
      if (sortKey === "overall") return s.overall ?? -1;
      if (sortKey === "costPerSuccess") return s.costPerSuccess ?? Number.POSITIVE_INFINITY;
      if (sortKey === "p50") return s.p50LatencyMs ?? Number.POSITIVE_INFINITY;
      return s.taskCount;
    };
    list.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sortDesc ? -c : c;
    });
    return list;
  }, [manifest, rows, flaggedTaskIds, excludeFlagged, localOnly, search, split, sortKey, sortDesc]);

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
    rank("overall", (s) => s.overall, false);
    rank("costPerSuccess", (s) => s.costPerSuccess, true);
    rank("p50", (s) => s.p50LatencyMs, true);
    return ranks;
  }, [summaries]);

  const shade = (col: ShadeCol, model: string): React.CSSProperties => {
    const r = topRanks.get(col)?.get(model);
    return r == null ? {} : { background: SHADES[r] };
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

  const header = (key: SortKey, label: string, opts?: { left?: boolean; className?: string }) => (
    <th key={key} onClick={() => toggleSort(key)} className={cn(opts?.left && "l", opts?.className)}>
      {label}
      {sortKey === key && <span className="arr">{sortDesc ? " ▼" : " ▲"}</span>}
    </th>
  );

  const chip = (label: string, on: boolean, toggle: () => void) => (
    <button className="u-chip" aria-pressed={on} onClick={toggle}>
      {label}
    </button>
  );

  const nCols = 6;
  const denseMetric = manifest.verifier.dense_metric;

  return (
    <div>
      {/* Controls: search + toggle chips + split select */}
      <div className="u-controls">
        <div className="u-search">
          <input
            type="search"
            placeholder="Search models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search models"
          />
        </div>
        {chip("Local only", localOnly, () => setLocalOnly((v) => !v))}
        {chip("Show route", showRoute, () => setShowRoute((v) => !v))}
        {chip(`Exclude flagged (${flaggedTaskIds.length})`, excludeFlagged, () => setExcludeFlagged((v) => !v))}
        <select
          className="u-org-select"
          value={split}
          onChange={(e) => setSplit(e.target.value as TaskSplit | "all")}
          aria-label="Split"
        >
          <option value="all">split: all</option>
          <option value="holdout">split: holdout</option>
          <option value="dev">split: dev</option>
          <option value="train">split: train</option>
          <option value="none">split: none</option>
        </select>
      </div>
      {splitsExist && split !== "holdout" && (
        <div className="u-warn mb-3 text-xs">
          <span className="lab">Non-holdout view</span> — numbers may be optimizer-touched.
        </div>
      )}
      {summaries.length === 0 ? (
        rows.length === 0 ? (
          <div className="u-empty">
            <p className="what">No runs yet — nothing has been evaluated against this benchmark.</p>
            <span className="next">
              {"run your harness and drop understudy.eval_result.v1 lines into rows-*.jsonl next to benchmark.json\n" +
                "e.g. node normalize-and-project.mjs <results.jsonl> <model> <run-id>  # see the demo dir's DOGFOOD.md"}
            </span>
          </div>
        ) : (
          <div className="u-empty">
            <p className="what">
              {rows.length} eval row{rows.length === 1 ? "" : "s"} exist, but none match the current filter — the
              leaderboard defaults to the frozen holdout split so optimizer-touched numbers never headline.
            </p>
            <span className="next">split: all  # or tag rows with split: &quot;holdout&quot;</span>
          </div>
        )
      ) : (
        <div className="u-tbl-scroll">
          <table className="u-tbl w-full">
            <thead>
              <tr>
                <th aria-label="expand" />
                {header("model", "Model", { left: true })}
                {header("overall", "Overall")}
                {header("costPerSuccess", "Cost p/ success")}
                {header("p50", "P50 latency")}
                {header("tasks", "Tasks")}
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => {
                const isOpen = expanded.has(s.model);
                return (
                  <Fragment key={s.model}>
                    <tr className={cn("row", isOpen && "open")} onClick={() => toggleExpanded(s.model)} aria-expanded={isOpen}>
                      <td className="u-rank">
                        <span className="u-exp">▸</span>
                      </td>
                      <td className="l">
                        <span className="u-mdl">
                          <span className="nm">{s.model}</span>
                          {showRoute && <RouteBadge route={s.route} />}
                        </span>
                      </td>
                      <td className="u-ovr" style={shade("overall", s.model)}>
                        {formatScore(s.overall)}
                      </td>
                      <td className={s.costPerSuccess == null ? "na" : undefined} style={shade("costPerSuccess", s.model)}>
                        {formatCost(s.costPerSuccess)}
                      </td>
                      <td style={shade("p50", s.model)} className={s.p50LatencyMs == null ? "na" : undefined}>
                        {formatLatency(s.p50LatencyMs)}
                      </td>
                      <td>{s.taskCount}</td>
                    </tr>
                    {isOpen && (
                      <tr className="u-detail">
                        <td colSpan={nCols}>
                          <div className="u-detail-in">
                            <div className="u-det-grid">
                              {/* Run quality — moved out of the main columns */}
                              <div className="u-det-cat">
                                <div className="h">Run quality</div>
                                <div className="u-subt">
                                  <span className="n">scored rows</span>
                                  <span className="v">{s.scoredCount}</span>
                                </div>
                                <div className="u-subt">
                                  <span className="n">unscored</span>
                                  <span className="v">{s.unscoredCount}</span>
                                </div>
                                <div className="u-subt">
                                  <span className="n">errors</span>
                                  <span className="v" style={s.errorCount > 0 ? { color: "var(--bad)" } : undefined}>
                                    {s.errorCount}
                                  </span>
                                </div>
                              </div>
                              {manifest.taxonomy.map((c) => {
                                const d = s.categoryDetail[c.category_id];
                                return (
                                  <div key={c.category_id} className="u-det-cat">
                                    <div className="h">{c.name ?? c.category_id}</div>
                                    <div className="u-subt">
                                      <span className="n">strict ({manifest.verifier.strict_metric})</span>
                                      <span className="v">{formatScore(d?.strict)}</span>
                                    </div>
                                    <div className="u-subt">
                                      <span className="n">dense ({denseMetric ?? "n/a"})</span>
                                      <span className="v">{denseMetric ? formatScore(d?.dense) : "—"}</span>
                                    </div>
                                    <div className="u-subt">
                                      <span className="n">rows</span>
                                      <span className="v">{d?.rowCount ?? 0}</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
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
      <div className="flex flex-col gap-0.5">
        <span className="u-foot-note">{"// overall = mean strict score (" + manifest.verifier.strict_metric + ") over scored rows (status ok, score present)"}</span>
        <span className="u-foot-note !mt-0">{"// cost p/ successful task = Σ cost ÷ scored rows ÷ mean strict score; blank when rows carry no cost or score is 0"}</span>
        <span className="u-foot-note !mt-0">{"// dense metric: " + (denseMetric ?? "none declared in manifest")}</span>
        <span className="u-foot-note !mt-0">{"// shading marks the top 3 per column (score: higher better; cost + latency: lower better)"}</span>
        <span className="u-foot-note !mt-0">{"// per-category scores, unscored counts, and errors live in the row expansion (▸)"}</span>
        <span className="u-foot-note !mt-0">
          {excludeFlagged
            ? `// flagged tasks are EXCLUDED right now (${flaggedTaskIds.length} open task flags)`
            : `// flagged tasks are INCLUDED right now (${flaggedTaskIds.length} open task flags)`}
        </span>
      </div>
    </div>
  );
}
