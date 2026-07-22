/**
 * Multi-objective (Pareto) projection over eval rows — pure, deterministic.
 *
 * Derives one point per arm (model) from eval_result rows: quality is the
 * MACRO-average of per-task mean scores (the same statistic the bootstrap CI
 * brackets, so the CI whiskers always bracket the plotted dot — note this can
 * differ from the leaderboard's per-row micro-average `overall` when tasks
 * have unequal rollout counts), plus mean cost per task, mean rollout
 * latency, and optional local-perf fields (tokens/sec, memory) when rows
 * carry them. Anomaly-flagged rows are excluded exactly like the leaderboard
 * (marked, never dropped from counts).
 *
 * `paretoFrontier` computes the non-dominated set for a chosen objective
 * vector. Trivial calibration arms (null/spam agents) are never frontier
 * candidates — they are floors, rendered as reference lines by the chart.
 */

import { bootstrapCI, perTaskMeans, type BootstrapCI } from "./bootstrap";
import { isAnomalousRow, isTrivialArmRow } from "./scores";
import type { EvalRow } from "./types";

export type ParetoPoint = {
  model: string;
  /** Macro-average of per-task mean scores (the CI's statistic); null when no scored rows. */
  quality: number | null;
  /** Seeded percentile-bootstrap 95% CI over per-task means (error whiskers). */
  ci: BootstrapCI | null;
  /** Mean cost per scored row carrying a numeric cost; null when none do. */
  costPerTask: number | null;
  /** Mean latency_ms over scored rows carrying it; null when none do. */
  latencyMeanMs: number | null;
  /** Mean tokens/sec when rows carry a local-perf throughput field; else null. */
  tokensPerSec: number | null;
  /** Mean peak memory (MB) when rows carry a local-perf memory field; else null. */
  memoryMb: number | null;
  /** Distinct scored tasks (the CI's effective N). */
  scoredTaskCount: number;
  scoredRowCount: number;
  /** Trivial calibration arm (null/spam agent): plottable floor, never on the frontier. */
  trivial: boolean;
  /** Capture-producing model rerun. */
  incumbent: boolean;
};

/** One objective of the frontier: a numeric ParetoPoint field + direction. */
export type ParetoObjective = {
  key: "quality" | "costPerTask" | "latencyMeanMs" | "tokensPerSec" | "memoryMb";
  direction: "min" | "max";
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function finiteNumbers(rows: EvalRow[], pick: (r: EvalRow) => unknown): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = pick(r);
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** First numeric value among candidate row fields (rows are open maps). */
function perfField(row: EvalRow, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Throughput field candidates emitted by local perf harnesses. */
const TOKENS_PER_SEC_KEYS = ["tokens_per_sec", "tokens_per_second", "tok_per_sec", "throughput_tok_s"];
/** Memory field candidates (MB unless suffixed _gb). */
const MEMORY_MB_KEYS = ["memory_mb", "peak_memory_mb", "rss_mb"];
const MEMORY_GB_KEYS = ["memory_gb", "peak_memory_gb"];

function memoryMbOf(row: EvalRow): number | null {
  const mb = perfField(row, MEMORY_MB_KEYS);
  if (mb != null) return mb;
  const gb = perfField(row, MEMORY_GB_KEYS);
  return gb != null ? gb * 1024 : null;
}

export type ProjectOptions = {
  /** Tasks excluded before aggregation (e.g. open-flagged tasks). */
  excludeTaskIds?: Set<string>;
  /** CI seed prefix — pass the benchmark_id so CIs match the leaderboard's. */
  benchmarkId?: string;
};

/**
 * Project eval rows into per-arm Pareto points. Anomaly-flagged rows never
 * enter aggregates; only status=ok rows with a numeric score count as scored.
 * Output is sorted by model name (deterministic regardless of row order).
 */
export function projectParetoPoints(rows: EvalRow[], options: ProjectOptions = {}): ParetoPoint[] {
  const excluded = options.excludeTaskIds ?? new Set<string>();
  const byModel = new Map<string, EvalRow[]>();
  for (const row of rows) {
    if (excluded.has(row.task_id)) continue;
    const model = row.model ?? "(unknown model)";
    const list = byModel.get(model) ?? [];
    list.push(row);
    byModel.set(model, list);
  }

  const points: ParetoPoint[] = [];
  for (const [model, modelRows] of byModel) {
    const trusted = modelRows.filter((r) => !isAnomalousRow(r));
    const scored = trusted.filter((r) => r.status === "ok" && typeof r.score === "number");
    const taskMeans = perTaskMeans(scored.map((r) => [r.task_id, r.score as number]));
    const seed = `${options.benchmarkId ?? "benchmark"}::${model}`;
    points.push({
      model,
      quality: mean(taskMeans),
      ci: bootstrapCI(taskMeans, { seed }),
      costPerTask: mean(finiteNumbers(scored, (r) => r.cost)),
      latencyMeanMs: mean(finiteNumbers(scored, (r) => r.latency_ms)),
      tokensPerSec: mean(finiteNumbers(scored, (r) => perfField(r, TOKENS_PER_SEC_KEYS))),
      memoryMb: mean(finiteNumbers(scored, (r) => memoryMbOf(r))),
      scoredTaskCount: taskMeans.length,
      scoredRowCount: scored.length,
      trivial: modelRows.some(isTrivialArmRow),
      incumbent: modelRows.some((r) => r.arm_kind === "incumbent"),
    });
  }
  points.sort((a, b) => a.model.localeCompare(b.model));
  return points;
}

/** Signed objective value: larger is always better after this transform. */
function directed(point: ParetoPoint, obj: ParetoObjective): number | null {
  const v = point[obj.key];
  if (v == null || !Number.isFinite(v)) return null;
  return obj.direction === "max" ? v : -v;
}

/**
 * Non-dominated set for the given objectives. A point is dominated when some
 * other eligible point is at least as good on EVERY objective and strictly
 * better on at least one. Ties (identical objective vectors) dominate
 * neither way, so all tied points stay on the frontier. Excluded up front:
 * trivial calibration arms (floors, not candidates) and points missing any
 * objective value. Output order is deterministic: by the first objective
 * (best first), then model name.
 */
export function paretoFrontier(points: ParetoPoint[], objectives: ParetoObjective[]): ParetoPoint[] {
  if (objectives.length === 0) return [];
  const eligible = points
    .filter((p) => !p.trivial)
    .map((p) => ({ point: p, vec: objectives.map((o) => directed(p, o)) }))
    .filter((e): e is { point: ParetoPoint; vec: number[] } => e.vec.every((v): v is number => v != null));

  const frontier = eligible.filter((a) =>
    !eligible.some(
      (b) => b !== a && b.vec.every((v, i) => v >= a.vec[i]) && b.vec.some((v, i) => v > a.vec[i]),
    ),
  );
  frontier.sort((a, b) => b.vec[0] - a.vec[0] || a.point.model.localeCompare(b.point.model));
  return frontier.map((e) => e.point);
}

/**
 * Statistical-tie groups over Pareto points, mirroring the leaderboard's
 * discipline: sort non-trivial arms by quality (desc) and chain ADJACENT
 * arms whose 95% CIs overlap. Returns model → group index only for groups of
 * size >= 2. Overlapping CIs mean the quality separation is not supported at
 * this N — the chart flags those labels instead of implying a real ordering.
 */
export function paretoTieGroups(points: ParetoPoint[]): Map<string, number> {
  const ranked = points
    .filter((p) => p.ci != null && p.quality != null && !p.trivial)
    .sort((a, b) => (b.quality as number) - (a.quality as number) || a.model.localeCompare(b.model));
  const groups = new Map<string, number>();
  let group: ParetoPoint[] = [];
  let groupIndex = 0;
  const flush = () => {
    if (group.length >= 2) {
      for (const p of group) groups.set(p.model, groupIndex);
      groupIndex += 1;
    }
    group = [];
  };
  for (const p of ranked) {
    const prev = group[group.length - 1];
    const overlaps = prev != null && prev.ci != null && p.ci != null && p.ci.hi >= prev.ci.lo && prev.ci.hi >= p.ci.lo;
    if (!overlaps) flush();
    group.push(p);
  }
  flush();
  return groups;
}

/* ---- CSV escape hatch (the und-289 analyses lived in spreadsheets) ---- */

const CSV_COLUMNS = [
  "model",
  "quality",
  "ci_lo",
  "ci_hi",
  "cost_per_task",
  "latency_mean_ms",
  "tokens_per_sec",
  "memory_mb",
  "scored_task_count",
  "scored_row_count",
  "trivial",
  "incumbent",
] as const;

function csvCell(value: string | number | boolean | null): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Render the projected points as a spreadsheet-ready CSV (header + one row per arm). */
export function paretoPointsToCsv(points: ParetoPoint[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const p of points) {
    lines.push(
      [
        p.model,
        p.quality,
        p.ci?.lo ?? null,
        p.ci?.hi ?? null,
        p.costPerTask,
        p.latencyMeanMs,
        p.tokensPerSec,
        p.memoryMb,
        p.scoredTaskCount,
        p.scoredRowCount,
        p.trivial,
        p.incumbent,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/* ---- Axis availability (sparse-data honesty) ---- */

export type ParetoAxis = "costPerTask" | "latencyMeanMs" | "tokensPerSec";

export const PARETO_AXES: Array<{ key: ParetoAxis; label: string; direction: "min" | "max" }> = [
  { key: "costPerTask", label: "cost / task", direction: "min" },
  { key: "latencyMeanMs", label: "mean latency", direction: "min" },
  { key: "tokensPerSec", label: "tokens / sec", direction: "max" },
];

/**
 * Axes worth offering: at least 2 non-trivial arms carry both quality and the
 * axis value (fewer can't form a trade-off — hide the option, not the chart).
 */
export function availableAxes(points: ParetoPoint[]): ParetoAxis[] {
  return PARETO_AXES.filter(
    (a) => points.filter((p) => !p.trivial && p.quality != null && p[a.key] != null).length >= 2,
  ).map((a) => a.key);
}
