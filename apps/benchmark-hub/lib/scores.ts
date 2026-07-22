import { bootstrapCI, perTaskMeans, type BootstrapCI } from "./bootstrap";
import type { BenchmarkManifest, EvalRow, TaskSplit } from "./types";

export type CategoryDetail = {
  /** Mean strict score over scored rows in this category. */
  strict: number | null;
  /** Mean dense subscore (manifest dense_metric) when rows carry it. */
  dense: number | null;
  rowCount: number;
};

export type RouteKind = "local" | "gateway" | "byo" | null;

export type ModelSummary = {
  model: string;
  /** Mean strict score over scored (status ok, score!=null) rows. */
  overall: number | null;
  perCategory: Record<string, number | null>;
  /** Per-category strict/dense means + row counts (for inline expansion). */
  categoryDetail: Record<string, CategoryDetail>;
  taskCount: number;
  scoredCount: number;
  unscoredCount: number;
  errorCount: number;
  /** Rows a structural sentinel flagged (row.anomaly) — EXCLUDED from score/cost/latency aggregates by default, but always counted here. */
  anomalousCount: number;
  /** Σ cost over SCORED rows carrying a numeric cost; null when none do. */
  totalCost: number | null;
  /** Σ cost ÷ scored rows ÷ mean strict score; null when undefined (guards ÷0). */
  costPerSuccess: number | null;
  /** Median latency_ms over scored rows carrying it. */
  p50LatencyMs: number | null;
  /** Normalized route from rows' `route` field. */
  route: RouteKind;
  /** True when any row is labeled arm_kind "incumbent" (the capture-producing model rerun). */
  incumbent: boolean;
  /**
   * Seeded percentile-bootstrap 95% CI over PER-TASK mean scores (tasks are
   * the resampling unit; anomalous rows excluded exactly like `overall`).
   * Null when no scored tasks exist. At taskN=1 it is degenerate [m, m].
   */
  ci: BootstrapCI | null;
  /** Distinct tasks with at least one scored row (the CI's effective N). */
  scoredTaskCount: number;
};

export type LeaderboardOptions = {
  excludeTaskIds?: Set<string>;
  split?: TaskSplit | "all";
  /** Include anomaly-flagged rows in score aggregates (default false: marked rows are excluded, counts stay visible). */
  includeAnomalous?: boolean;
};

/** True when the executor's structural sentinels flagged this row (row.anomaly is an object with a kind). */
export function isAnomalousRow(row: EvalRow): boolean {
  return row.anomaly != null && typeof row.anomaly === "object" && typeof row.anomaly.kind === "string";
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Normalize a row's free-form route into local | gateway | byo. */
export function normalizeRoute(route: string | null | undefined): RouteKind {
  if (!route) return null;
  const r = route.toLowerCase();
  if (r.includes("local")) return "local";
  if (r.includes("gateway")) return "gateway";
  if (r.includes("byo") || r.includes("direct") || r.includes("passthrough")) return "byo";
  return null;
}

export function taskCategoryMap(manifest: BenchmarkManifest): Map<string, string> {
  return new Map(manifest.tasks.map((t) => [t.task_id, t.category_id]));
}

export function taskSplitMap(manifest: BenchmarkManifest): Map<string, TaskSplit> {
  return new Map(manifest.tasks.map((t) => [t.task_id, t.split]));
}

/** True when the manifest declares any split other than "none". */
export function hasSplits(manifest: BenchmarkManifest): boolean {
  return manifest.tasks.some((t) => t.split !== "none");
}

export function computeLeaderboard(
  manifest: BenchmarkManifest,
  rows: EvalRow[],
  options: LeaderboardOptions = {},
): ModelSummary[] {
  const categories = taskCategoryMap(manifest);
  const splits = taskSplitMap(manifest);
  const excluded = options.excludeTaskIds ?? new Set<string>();
  const splitFilter = options.split ?? "all";

  const byModel = new Map<string, EvalRow[]>();
  for (const row of rows) {
    if (excluded.has(row.task_id)) continue;
    if (splitFilter !== "all") {
      // The manifest's frozen split assignment wins over anything the row
      // declares; row.split is only trusted for tasks the manifest doesn't know.
      const split = splits.get(row.task_id) ?? row.split ?? "none";
      if (split !== splitFilter) continue;
    }
    const model = row.model ?? "(unknown model)";
    const list = byModel.get(model) ?? [];
    list.push(row);
    byModel.set(model, list);
  }

  const denseMetric = manifest.verifier.dense_metric ?? null;
  const summaries: ModelSummary[] = [];
  for (const [model, modelRows] of byModel) {
    // Anomaly-flagged rows never enter score/cost/latency aggregates unless
    // explicitly opted in — they are marked (counted below), not dropped.
    const trusted = options.includeAnomalous ? modelRows : modelRows.filter((r) => !isAnomalousRow(r));
    const scored = trusted.filter((r) => r.status === "ok" && typeof r.score === "number");
    const perCategory: Record<string, number | null> = {};
    const categoryDetail: Record<string, CategoryDetail> = {};
    for (const cat of manifest.taxonomy) {
      const catScored = scored.filter((r) => (r.category_id ?? categories.get(r.task_id)) === cat.category_id);
      const strict = mean(catScored.map((r) => r.score as number));
      const denseVals = catScored
        .map((r) => (denseMetric ? r.subscores?.[denseMetric] : null))
        .filter((v): v is number => typeof v === "number");
      perCategory[cat.category_id] = strict;
      categoryDetail[cat.category_id] = { strict, dense: mean(denseVals), rowCount: catScored.length };
    }

    // Cost and latency aggregate over the SAME population as scoring: rows
    // counted in the score denominator (status ok, score present). Rows that
    // errored or were skipped/unscored contribute to run-quality counts only.
    const costs = scored.map((r) => r.cost).filter((c): c is number => typeof c === "number" && Number.isFinite(c));
    const totalCost = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;
    // overall is a per-row micro-average of the strict score over scored rows
    // (duplicate rows for a task each count once; dedup is out of scope here).
    const overall = mean(scored.map((r) => r.score as number));
    // cost-per-successful-task = Σ cost ÷ scored rows ÷ mean strict score.
    const costPerSuccess =
      totalCost != null && scored.length > 0 && overall != null && overall > 0
        ? totalCost / scored.length / overall
        : null;
    const latencies = scored
      .map((r) => r.latency_ms)
      .filter((l): l is number => typeof l === "number" && Number.isFinite(l));
    const routes = new Set(modelRows.map((r) => normalizeRoute(r.route)).filter((r): r is Exclude<RouteKind, null> => r != null));
    // CI over per-task means (rollout repeats of one task are correlated, so
    // the task is the resampling unit). Seed = benchmark + model: deterministic
    // across renders and test runs, distinct across arms.
    const taskMeans = perTaskMeans(scored.map((r) => [r.task_id, r.score as number]));
    const ci = bootstrapCI(taskMeans, { seed: `${manifest.benchmark_id}::${model}` });
    summaries.push({
      model,
      overall,
      perCategory,
      categoryDetail,
      taskCount: new Set(modelRows.map((r) => r.task_id)).size,
      scoredCount: scored.length,
      unscoredCount: modelRows.filter((r) => r.status === "unscored" || r.status === "skipped").length,
      errorCount: modelRows.filter((r) => r.status === "error").length,
      anomalousCount: modelRows.filter(isAnomalousRow).length,
      totalCost,
      costPerSuccess,
      p50LatencyMs: median(latencies),
      route: routes.size === 1 ? [...routes][0] : null,
      incumbent: modelRows.some((r) => r.arm_kind === "incumbent"),
      ci,
      scoredTaskCount: taskMeans.length,
    });
  }
  summaries.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
  return summaries;
}

/** Per-category mean strict score across all models (for the detail taxonomy). */
export function categoryScoreSummary(
  manifest: BenchmarkManifest,
  rows: EvalRow[],
  excludeTaskIds?: Set<string>,
): Record<string, { score: number | null; n: number }> {
  const categories = taskCategoryMap(manifest);
  // Same trust discipline as the leaderboard: anomaly-flagged rows never enter means.
  const pool = (excludeTaskIds ? rows.filter((r) => !excludeTaskIds.has(r.task_id)) : rows).filter((r) => !isAnomalousRow(r));
  const out: Record<string, { score: number | null; n: number }> = {};
  for (const cat of manifest.taxonomy) {
    const scored = pool.filter(
      (r) => r.status === "ok" && typeof r.score === "number" && (r.category_id ?? categories.get(r.task_id)) === cat.category_id,
    );
    out[cat.category_id] = { score: mean(scored.map((r) => r.score as number)), n: scored.length };
  }
  return out;
}

/**
 * Statistical-tie detection over the overall ranking: sort arms by overall
 * (desc) and chain ADJACENT arms whose 95% CIs overlap into tie groups.
 * Returns model → tie-group index only for models in a group of size >= 2;
 * arms without a CI (no scored tasks) never tie. Overlapping CIs mean the
 * rank separation is not statistically supported at this N — the leaderboard
 * greys those separations out instead of implying a real ordering.
 */
export function statisticalTieGroups(summaries: ModelSummary[]): Map<string, number> {
  const ranked = summaries
    .filter((s) => s.ci != null && s.overall != null)
    .sort((a, b) => (b.overall as number) - (a.overall as number));
  const groups = new Map<string, number>();
  let group: ModelSummary[] = [];
  let groupIndex = 0;
  const flush = () => {
    if (group.length >= 2) {
      for (const s of group) groups.set(s.model, groupIndex);
      groupIndex += 1;
    }
    group = [];
  };
  for (const s of ranked) {
    const prev = group[group.length - 1];
    const overlaps = prev != null && prev.ci != null && s.ci != null && s.ci.hi >= prev.ci.lo && prev.ci.hi >= s.ci.lo;
    if (!overlaps) flush();
    group.push(s);
  }
  flush();
  return groups;
}

/** Render a bootstrap CI as "[62–81%]" in the leaderboard's percent idiom. */
export function formatCI(ci: BootstrapCI | null | undefined): string {
  if (ci == null) return "";
  return `[${(ci.lo * 100).toFixed(0)}–${(ci.hi * 100).toFixed(0)}%]`;
}

export function formatScore(score: number | null | undefined): string {
  if (score == null) return "—";
  return (score * 100).toFixed(0) + "%";
}

export function formatCost(cost: number | null | undefined): string {
  if (cost == null) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return "$" + cost.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  return "$" + cost.toFixed(cost < 1 ? 3 : 2);
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
