// Project an AutomationBench --export-json run (raw/ab-<model>.json) into
// understudy.eval_result.v1 rows via the repo's own dist/benchmark.js.
//
// AutomationBench's exporter emits one entry per task with real per-task
// score (partial_credit), passed (task_completed_correctly), token usage,
// model wall time, and cost. Each task becomes a single-node linear trace
// (the harness output is flat — no message DAG), then rows are enriched with
// cost / latency / tokens from the same export.
//
// Cost: sonnet rows keep the harness's list-price estimate ($3/$15 per Mtok).
// gemma rows were computed by the harness from --input-cost/--output-cost
// overrides ($0.10/$0.40 per Mtok demo assumption — see NOTES.md).
//
// Usage: node project-rows.mjs <export.json> <model> <run_id>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const { normalizeTraceRecord, extractBranches, projectBranchesToEvalRows } =
  await import(path.join(repoRoot, "dist", "benchmark.js"));

const [exportPath, model, runId, route = "understudy-gateway"] = process.argv.slice(2);
if (!exportPath || !model || !runId) {
  console.error("usage: node project-rows.mjs <export.json> <model> <run_id> [route]");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(here, "benchmark.json"), "utf8"));
const exp = JSON.parse(readFileSync(exportPath, "utf8"));
const runCreatedAt = exp.meta?.timestamp ?? new Date().toISOString();

const perTask = new Map();
const rawTraceRecords = exp.tasks.map((t, i) => {
  perTask.set(t.name, t);
  return {
    id: `${runId}-task-${i}`,
    parents: [],
    task_id: t.name,
    reward: t.score,
    metrics: {
      partial_credit: t.score,
      task_completed_correctly: t.passed ? 1 : 0,
    },
  };
});

const nodes = rawTraceRecords.map(normalizeTraceRecord).filter(Boolean);
const branches = extractBranches(nodes);
const rows = projectBranchesToEvalRows(manifest, branches, {
  runId,
  model,
  route,
}).map((row) => {
  const t = perTask.get(row.task_id);
  if (!t) return row;
  return {
    ...row,
    cost: t.cost ?? null,
    latency_ms: t.model_time_s != null ? Math.round(t.model_time_s * 1000) : null,
    tokens: {
      input: t.input_tokens ?? null,
      output: t.output_tokens ?? null,
      cached_input: t.cached_input_tokens ?? null,
    },
    created_at: runCreatedAt,
  };
});

mkdirSync(path.join(here, "rows"), { recursive: true });
writeFileSync(
  path.join(here, "rows", `rows-${model}.jsonl`),
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
);

const strict = rows.map((r) => r.score ?? 0);
const dense = rows.map((r) => r.subscores?.partial_credit ?? 0);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
console.log(
  `${model}: ${rows.length} rows; strict mean=${mean(strict).toFixed(3)}; ` +
    `partial_credit mean=${mean(dense).toFixed(3)}; ` +
    `total cost=$${rows.reduce((a, r) => a + (r.cost ?? 0), 0).toFixed(3)}`
);
