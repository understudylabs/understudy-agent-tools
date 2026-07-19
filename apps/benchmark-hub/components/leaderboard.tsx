"use client";

import { useMemo, useState } from "react";
import { computeLeaderboard, formatScore, hasSplits } from "@/lib/scores";
import type { BenchmarkManifest, EvalRow, TaskSplit } from "@/lib/types";
import { cn } from "@/lib/utils";

type SortKey = "model" | "overall" | "tasks" | "unscored" | "errors" | `cat:${string}`;

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

  const summaries = useMemo(() => {
    const list = computeLeaderboard(manifest, rows, {
      excludeTaskIds: excludeFlagged ? new Set(flaggedTaskIds) : undefined,
      split,
    });
    const value = (s: (typeof list)[number]): number | string => {
      if (sortKey === "model") return s.model;
      if (sortKey === "overall") return s.overall ?? -1;
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
  }, [manifest, rows, flaggedTaskIds, excludeFlagged, split, sortKey, sortDesc]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(key !== "model");
    }
  };

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

  return (
    <div>
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
                {header("overall", "overall (strict)")}
                {manifest.taxonomy.map((c) => header(`cat:${c.category_id}`, c.name ?? c.category_id))}
                {header("tasks", "tasks")}
                {header("unscored", "unscored")}
                {header("errors", "errors")}
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => (
                <tr key={s.model} className="border-b border-rule last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{s.model}</td>
                  <td className="px-3 py-2 text-right font-mono font-semibold">{formatScore(s.overall)}</td>
                  {manifest.taxonomy.map((c) => (
                    <td key={c.category_id} className="px-3 py-2 text-right font-mono text-ink-muted">
                      {formatScore(s.perCategory[c.category_id])}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-mono">{s.taskCount}</td>
                  <td className="px-3 py-2 text-right font-mono text-ink-muted">{s.unscoredCount}</td>
                  <td className={cn("px-3 py-2 text-right font-mono", s.errorCount > 0 ? "text-bad" : "text-ink-muted")}>
                    {s.errorCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
