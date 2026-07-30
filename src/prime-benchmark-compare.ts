import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Row = {
  task_id: string;
  model: string;
  score: number;
  subscores?: { final_state_partial_credit?: number };
  cost?: { usd?: number | null };
  latency_ms?: number | null;
  tokens?: { prompt?: number; cached_input?: number; completion?: number; reasoning?: number };
};

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function summarize(rows: Row[]): Record<string, number | null> {
  const tokenTotals = rows.map((row) => Object.values(row.tokens ?? {}).reduce((sum, value) => sum + (value ?? 0), 0));
  return {
    tasks: rows.length,
    score: mean(rows.map((row) => row.score)),
    pass_rate: mean(rows.map((row) => row.score === 1 ? 1 : 0)),
    partial_credit: mean(rows.map((row) => row.subscores?.final_state_partial_credit ?? row.score)),
    cost_per_task_usd: mean(rows.flatMap((row) => typeof row.cost?.usd === "number" ? [row.cost.usd] : [])),
    latency_per_task_ms: mean(rows.flatMap((row) => typeof row.latency_ms === "number" ? [row.latency_ms] : [])),
    tokens_per_task: mean(tokenTotals),
  };
}

function delta(candidate: number | null, baseline: number | null): { absolute: number | null; percent: number | null } {
  if (candidate === null || baseline === null) return { absolute: null, percent: null };
  return { absolute: candidate - baseline, percent: baseline === 0 ? null : ((candidate - baseline) / baseline) * 100 };
}

export function comparePrimeModels(dir: string, baselineModel: string, candidateModel: string): Record<string, unknown> {
  const rows = readFileSync(join(resolve(dir), "rows-prime.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
  const baselineRows = rows.filter((row) => row.model === baselineModel);
  const candidateRows = rows.filter((row) => row.model === candidateModel);
  if (!baselineRows.length) throw new Error(`no rows for baseline model ${baselineModel}`);
  if (!candidateRows.length) throw new Error(`no rows for candidate model ${candidateModel}`);
  const baselineTasks = new Set(baselineRows.map((row) => row.task_id));
  const candidateTasks = new Set(candidateRows.map((row) => row.task_id));
  const missingFromCandidate = [...baselineTasks].filter((task) => !candidateTasks.has(task));
  const extraCandidateTasks = [...candidateTasks].filter((task) => !baselineTasks.has(task));
  if (missingFromCandidate.length || extraCandidateTasks.length) {
    throw new Error(`models are not comparable: missing candidate tasks [${missingFromCandidate.join(", ")}], extra candidate tasks [${extraCandidateTasks.join(", ")}]`);
  }
  const baseline = summarize(baselineRows);
  const candidate = summarize(candidateRows);
  const metricKeys = ["score", "pass_rate", "partial_credit", "cost_per_task_usd", "latency_per_task_ms", "tokens_per_task"] as const;
  return {
    schema_version: "understudy.prime_benchmark_comparison.v1",
    baseline_model: baselineModel,
    candidate_model: candidateModel,
    comparable_task_count: baselineRows.length,
    baseline,
    candidate,
    deltas: Object.fromEntries(metricKeys.map((key) => [key, delta(candidate[key] as number | null, baseline[key] as number | null)])),
    task_outcomes: baselineRows
      .map((baselineRow) => {
        const candidateRow = candidateRows.find((row) => row.task_id === baselineRow.task_id)!;
        return {
          task_id: baselineRow.task_id,
          baseline_score: baselineRow.score,
          candidate_score: candidateRow.score,
          outcome: candidateRow.score > baselineRow.score ? "fixed" : candidateRow.score < baselineRow.score ? "regressed" : "unchanged",
        };
      })
      .sort((left, right) => left.task_id.localeCompare(right.task_id)),
  };
}
