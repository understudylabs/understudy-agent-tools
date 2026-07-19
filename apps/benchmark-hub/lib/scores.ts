import type { BenchmarkManifest, EvalRow, TaskSplit } from "./types";

export type ModelSummary = {
  model: string;
  /** Mean strict score over scored (status ok, score!=null) rows. */
  overall: number | null;
  perCategory: Record<string, number | null>;
  taskCount: number;
  scoredCount: number;
  unscoredCount: number;
  errorCount: number;
};

export type LeaderboardOptions = {
  excludeTaskIds?: Set<string>;
  split?: TaskSplit | "all";
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
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
      const split = row.split ?? splits.get(row.task_id) ?? "none";
      if (split !== splitFilter) continue;
    }
    const model = row.model ?? "(unknown model)";
    const list = byModel.get(model) ?? [];
    list.push(row);
    byModel.set(model, list);
  }

  const summaries: ModelSummary[] = [];
  for (const [model, modelRows] of byModel) {
    const scored = modelRows.filter((r) => r.status === "ok" && typeof r.score === "number");
    const perCategory: Record<string, number | null> = {};
    for (const cat of manifest.taxonomy) {
      perCategory[cat.category_id] = mean(
        scored
          .filter((r) => (r.category_id ?? categories.get(r.task_id)) === cat.category_id)
          .map((r) => r.score as number),
      );
    }
    summaries.push({
      model,
      overall: mean(scored.map((r) => r.score as number)),
      perCategory,
      taskCount: new Set(modelRows.map((r) => r.task_id)).size,
      scoredCount: scored.length,
      unscoredCount: modelRows.filter((r) => r.status === "unscored" || r.status === "skipped").length,
      errorCount: modelRows.filter((r) => r.status === "error").length,
    });
  }
  summaries.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
  return summaries;
}

/** Per-category mean strict score across all models (for the detail taxonomy). */
export function categoryScoreSummary(manifest: BenchmarkManifest, rows: EvalRow[]): Record<string, { score: number | null; n: number }> {
  const categories = taskCategoryMap(manifest);
  const out: Record<string, { score: number | null; n: number }> = {};
  for (const cat of manifest.taxonomy) {
    const scored = rows.filter(
      (r) => r.status === "ok" && typeof r.score === "number" && (r.category_id ?? categories.get(r.task_id)) === cat.category_id,
    );
    out[cat.category_id] = { score: mean(scored.map((r) => r.score as number)), n: scored.length };
  }
  return out;
}

export function formatScore(score: number | null | undefined): string {
  if (score == null) return "—";
  return (score * 100).toFixed(0) + "%";
}
