// Normalize vf-eval (verifiers==0.2.0) flat results.jsonl into TraceNode
// records, then project branches to understudy.eval_result.v1 rows using the
// repo's own dist/benchmark.js.
//
// verifiers 0.2.0 --save-results output is FLAT (one row per rollout, no
// message DAG and no task_id), so each rollout becomes a single-node linear
// trace, and task_id is recovered by matching the rollout's user message back
// to tasks-subset.jsonl questions. Both are v0/v1-seam workarounds — see
// DOGFOOD.md.
//
// Usage: node normalize-and-project.mjs <results.jsonl> <model> <run_id>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const { normalizeTraceRecord, extractBranches, projectBranchesToEvalRows } =
  await import(path.join(repoRoot, "dist", "benchmark.js"));

const [resultsPath, model, runId] = process.argv.slice(2);
if (!resultsPath || !model || !runId) {
  console.error("usage: node normalize-and-project.mjs <results.jsonl> <model> <run_id>");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(here, "benchmark.json"), "utf8"));

// question -> task_id (results rows carry no task_id; recover it by content)
const questionToTask = new Map();
for (const line of readFileSync(path.join(here, "tasks-subset.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const t = JSON.parse(line);
  questionToTask.set(t.question, t.task_id);
}

const rollouts = readFileSync(resultsPath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

// One single-node linear trace per rollout (flat v0 output — no DAG).
const rawTraceRecords = rollouts.map((r, i) => {
  const userMsg = (r.prompt ?? []).find((m) => m.role === "user");
  const taskId = questionToTask.get(userMsg?.content) ?? null;
  return {
    id: `${runId}-rollout-${i}`,
    parents: [],
    task_id: taskId,
    reward: r.reward,
    metrics: r.metrics ?? {},
  };
});

mkdirSync(path.join(here, "traces"), { recursive: true });
mkdirSync(path.join(here, "rows"), { recursive: true });
writeFileSync(
  path.join(here, "traces", `traces-${model}.jsonl`),
  rawTraceRecords.map((r) => JSON.stringify(r)).join("\n") + "\n"
);

const nodes = rawTraceRecords.map(normalizeTraceRecord).filter(Boolean);
const branches = extractBranches(nodes);
const rows = projectBranchesToEvalRows(manifest, branches, {
  runId,
  model,
  route: "understudy-gateway",
});
writeFileSync(
  path.join(here, "rows", `rows-${model}.jsonl`),
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
);

const scores = rows.map((r) => r.score).filter((s) => s !== null);
const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
console.log(
  `${model}: ${nodes.length} trace nodes -> ${branches.length} branches -> ${rows.length} rows; ` +
    `strict (${manifest.verifier.strict_metric}) mean = ${mean.toFixed(3)}; ` +
    `unmatched task_id: ${rawTraceRecords.filter((r) => !r.task_id).length}`
);
