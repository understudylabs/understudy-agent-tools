"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { binHistogram, scoreColor } from "@/lib/trajectory-core";
import { formatScore } from "@/lib/scores";
import { InlineHistogram } from "@/components/histogram";
import { Badge, ConfidenceChip, DecisionBadge, SplitChip } from "@/components/badges";

export type TaskTableRow = {
  taskId: string;
  href: string;
  /** authored intent_summary wins as display name; raw title demoted to hover/sub. */
  displayName: string;
  rawTitle?: string | null;
  split: string;
  /** promoted */
  rollouts?: number;
  avgScore?: number | null;
  /** proposed */
  confidence?: string | null;
  reviewDecision?: string | null;
  closeCall?: boolean;
  authored?: boolean;
  /** shared numeric distributions */
  promptLength: number;
  /** proposed, from benchmark-overview task_complexity */
  contextTokens?: number | null;
  frontier?: boolean;
  /** authored "easy" on a frontier-complex task */
  complexityMismatch?: boolean;
};

type SortKey = "name" | "rollouts" | "score" | "prompt" | "confidence" | "review" | "context";

const CONFIDENCE_ORDER: Record<string, number> = { high: 2, medium: 1, low: 0 };

/**
 * Grouped-by-example taskset table (Prime Environments Hub style): rows are
 * tasks, sortable column headers embed tiny distribution histograms (reward /
 * rollouts / prompt length) rendered as inline SVG from the theme's
 * --viz-series-* slots. One component serves both lifecycle stages: promoted
 * (rollouts + avg score) and proposed (confidence + review state).
 */
export function TaskTable({ rows, stage }: { rows: TaskTableRow[]; stage: "proposed" | "promoted" }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });

  const histograms = useMemo(
    () => ({
      score: binHistogram(rows.map((r) => r.avgScore)),
      rollouts: binHistogram(rows.map((r) => r.rollouts)),
      prompt: binHistogram(rows.map((r) => r.promptLength)),
      confidence: binHistogram(rows.map((r) => (r.confidence ? CONFIDENCE_ORDER[r.confidence] ?? null : null)), 3),
      context: binHistogram(rows.map((r) => r.contextTokens)),
    }),
    [rows],
  );

  const sorted = useMemo(() => {
    const value = (r: TaskTableRow): string | number => {
      switch (sort.key) {
        case "rollouts":
          return r.rollouts ?? -1;
        case "score":
          return r.avgScore ?? -1;
        case "prompt":
          return r.promptLength;
        case "context":
          return r.contextTokens ?? -1;
        case "confidence":
          return r.confidence ? CONFIDENCE_ORDER[r.confidence] ?? -1 : -1;
        case "review":
          return r.reviewDecision ?? "";
        default:
          return r.displayName.toLowerCase();
      }
    };
    return [...rows].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return cmp * sort.dir;
    });
  }, [rows, sort]);

  const header = (key: SortKey, label: string, hist?: { h: ReturnType<typeof binHistogram>; color: string; title: string }) => (
    <th
      className="l"
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((s.dir * -1) as 1 | -1) : -1 }))}
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <span className="flex flex-col gap-1">
        <span>
          {label}
          {sort.key === key && <span aria-hidden="true"> {sort.dir === 1 ? "↑" : "↓"}</span>}
        </span>
        {hist && <InlineHistogram histogram={hist.h} color={hist.color} title={hist.title} />}
      </span>
    </th>
  );

  return (
    <div className="u-tbl-scroll mt-5">
      <table className="u-tbl w-full">
        <thead>
          <tr>
            {header("name", "task")}
            <th className="l" style={{ cursor: "default" }}>split</th>
            {stage === "promoted" && header("rollouts", "rollouts", { h: histograms.rollouts, color: "var(--viz-series-1)", title: "rollouts per task" })}
            {stage === "promoted" && header("score", "avg reward", { h: histograms.score, color: "var(--viz-series-3)", title: "reward distribution" })}
            {stage === "proposed" && header("confidence", "confidence", { h: histograms.confidence, color: "var(--viz-series-5)", title: "machine confidence distribution" })}
            {stage === "proposed" && header("review", "review")}
            {header("prompt", "prompt len", { h: histograms.prompt, color: "var(--viz-series-2)", title: "prompt-length distribution (chars)" })}
            {stage === "proposed" && histograms.context.count > 0 && header("context", "~ctx tokens", { h: histograms.context, color: "var(--viz-series-4)", title: "approx context-token distribution" })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.taskId}>
              <td className="l" style={{ whiteSpace: "normal", maxWidth: 460 }}>
                <Link href={r.href} title={r.rawTitle ?? undefined}>
                  {r.displayName}
                </Link>
                <span className="mono block text-[10px] text-faint">{r.taskId}</span>
                {stage === "proposed" && (
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {r.authored && <Badge className="text-ok border-ok/50">authored</Badge>}
                    {r.closeCall && <Badge className="border-warn/40 text-warn">close call</Badge>}
                    {r.frontier && <Badge className="border-warn/40 text-warn">frontier</Badge>}
                    {r.complexityMismatch && <Badge className="border-bad/40 text-bad">authored easy · frontier-complex</Badge>}
                  </span>
                )}
              </td>
              <td className="l">
                <SplitChip split={r.split} />
              </td>
              {stage === "promoted" && <td className="l mono text-xs">{r.rollouts ?? 0}</td>}
              {stage === "promoted" && (
                <td className="l mono text-xs font-bold" style={{ color: scoreColor(r.avgScore) }}>
                  {formatScore(r.avgScore)}
                </td>
              )}
              {stage === "proposed" && (
                <td className="l">
                  <ConfidenceChip level={r.confidence} />
                </td>
              )}
              {stage === "proposed" && (
                <td className="l">
                  <DecisionBadge decision={r.reviewDecision} />
                </td>
              )}
              <td className="l mono text-xs text-ink-muted">{r.promptLength}</td>
              {stage === "proposed" && rows.some((x) => x.contextTokens != null) && (
                <td className="l mono text-xs text-ink-muted">{r.contextTokens ?? "—"}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
