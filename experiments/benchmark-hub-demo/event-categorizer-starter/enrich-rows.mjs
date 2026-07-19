// Enrich rows/rows-<model>.jsonl with cost + latency_ms from the raw vf-eval
// results.jsonl (which carries per-rollout timing + token_usage; the
// eval_result.v1 projection dropped them). Rows are matched back to raw
// rollouts by the trace_ref.branch_leaf "<run_id>-rollout-<i>" index.
//
// latency_ms = timing.total * 1000 (wall clock for the rollout).
// cost       = token_usage x published per-MTok pricing for the route.
//
// Usage: node enrich-rows.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// $ per 1M tokens (input, output). Sonnet 4.6 is Anthropic list price;
// gemma-4-31b-it is the Understudy gateway open-weight rate assumed for this
// demo (documented in apps/benchmark-hub/README.md).
const PRICING = {
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "gemma-4-31b-it": { in: 0.1, out: 0.4 },
};

const ARMS = [
  { model: "claude-sonnet-4-6", raw: "raw/evals/event-categorizer--claude-sonnet-4-6/541ee699/results.jsonl" },
  { model: "gemma-4-31b-it", raw: "raw/evals/event-categorizer--gemma-4-31b-it/f18dbd97/results.jsonl" },
];

for (const arm of ARMS) {
  const rollouts = readFileSync(path.join(here, arm.raw), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const rowsPath = path.join(here, "rows", `rows-${arm.model}.jsonl`);
  const price = PRICING[arm.model];
  const rows = readFileSync(rowsPath, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  let total = 0;
  for (const row of rows) {
    const m = /-rollout-(\d+)$/.exec(row.trace_ref?.branch_leaf ?? "");
    if (!m) continue;
    const r = rollouts[Number(m[1])];
    if (!r) continue;
    row.latency_ms = Math.round((r.timing?.total ?? 0) * 1000);
    const inTok = r.token_usage?.input_tokens ?? 0;
    const outTok = r.token_usage?.output_tokens ?? 0;
    row.cost = (inTok * price.in + outTok * price.out) / 1e6;
    total += row.cost;
  }
  writeFileSync(rowsPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`${arm.model}: ${rows.length} rows enriched; total cost $${total.toFixed(6)}`);
}
