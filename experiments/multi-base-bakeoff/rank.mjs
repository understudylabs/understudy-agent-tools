#!/usr/bin/env node
/**
 * Rank the bake-off: read every evidence row produced by `run-eval.mjs` and
 * print the ladder per base plus the ranked table the arm exists to produce —
 * best owned base per band and per workload tier, with the serving cost and
 * latency measured in the same runs.
 *
 * Ranking prefers the sealed holdout and falls back to dev when the holdout has
 * not been executed. The basis is always stated in the report as
 * `ranking_basis`, and `holdout_executed` records whether the seal is still
 * intact, so a dev-ranked table can never be read as a holdout result.
 *
 * It refuses to mix contracts: every artifact must carry the same
 * `contract_sha256` and the same fixture hash, otherwise the comparison is not
 * a comparison and the script fails closed.
 *
 *   node experiments/multi-base-bakeoff/rank.mjs outputs/bakeoff/*.json --out outputs/bakeoff/ranked.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
const outPath = outIndex === -1 ? null : argv[outIndex + 1];
const mdIndex = argv.indexOf("--markdown");
const mdPath = mdIndex === -1 ? null : argv[mdIndex + 1];
const priceIndex = argv.indexOf("--price-card");
const priceCard = priceIndex === -1 ? null : JSON.parse(readFileSync(argv[priceIndex + 1], "utf8"));
const paths = argv.filter((value, index) => !value.startsWith("--") && argv[index - 1] !== "--out" && argv[index - 1] !== "--markdown" && argv[index - 1] !== "--price-card");
if (paths.length === 0) throw new Error("pass at least one evidence-row artifact");

const rows = paths.map((path) => {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed.schema_version !== "understudy.bakeoff.evidence_row.v1") throw new Error(`${path}: not a bake-off evidence row`);
  return { path, ...parsed };
}).filter((row) => row.rows?.length > 0 || row.scored > 0);

const contracts = new Set(rows.map((row) => row.contract_sha256));
if (contracts.size > 1) throw new Error(`refusing to rank across ${contracts.size} serving contracts: ${[...contracts].join(", ")}`);
const fixtures = new Set(rows.map((row) => row.fixture_sha256));
if (fixtures.size > 1) throw new Error(`refusing to rank across ${fixtures.size} fixtures`);

const round = (value, digits = 4) => (typeof value === "number" ? Number(value.toFixed(digits)) : null);

// The base a candidate belongs to is its served model, not its label: base-rung
// labels carry a renderer suffix and would otherwise each rank as their own base.
function baseOf(row) {
  return String(row.model).split("/").pop();
}

// Cost is derived from the token counts already in the evidence row, so a price
// card can be applied (or corrected) after the fact without re-running any
// paid evaluation. Rows that measured their own cost keep it.
function estimatedCostPer1kTasks(row) {
  if (typeof row.serving?.cost_usd_per_1k_tasks === "number") return { value: row.serving.cost_usd_per_1k_tasks, source: row.serving?.price_usd_per_mtok?.source ?? "measured" };
  const price = priceCard?.models?.[row.model];
  if (!price || !row.scored) return { value: null, source: null };
  const cost = (row.serving.prompt_tokens / 1e6) * price.input_usd_per_mtok + (row.serving.completion_tokens / 1e6) * price.output_usd_per_mtok;
  return { value: (cost / row.scored) * 1000, source: `estimated: ${priceCard.source}` };
}

function summarize(row) {
  const cost = estimatedCostPer1kTasks(row);
  return {
    label: row.label,
    base: baseOf(row),
    rung: row.rung,
    lane: row.lane,
    model: row.model,
    renderer: row.renderer,
    checkpoint: row.checkpoint,
    split: row.split,
    n: row.scored,
    mean_score: round(row.mean_score),
    exact_1_rate: round(row.exact_1_rate),
    zero_rate: round(row.zero_rate),
    hard_tier: round(row.mean_by_tier?.hard),
    v1_tier: round(row.mean_by_tier?.v1),
    mean_by_band: Object.fromEntries(Object.entries(row.mean_by_band ?? {}).map(([key, value]) => [key, round(value)])),
    over_acting_episodes: row.over_acting_episodes,
    forbidden_writes: row.forbidden_writes,
    malformed_rate: round(row.malformed_rate),
    p50_request_latency_s: row.serving?.request_latency_s?.p50 ?? null,
    p90_request_latency_s: row.serving?.request_latency_s?.p90 ?? null,
    mean_task_latency_s: row.serving?.task_latency_s?.mean ?? null,
    tokens_per_task: round(row.serving?.tokens_per_task, 0),
    requests_per_task: round(row.serving?.requests_per_task, 2),
    cost_usd_per_1k_tasks: round(cost.value, 3),
    price_source: cost.source,
    artifact: row.path,
  };
}

const summaries = rows.map(summarize);
const holdout = summaries.filter((row) => row.split === "holdout");
const dev = summaries.filter((row) => row.split === "dev");
const holdoutExecuted = holdout.length > 0;
// Dev is the selection split, so a dev-basis ranking is a selection, not a
// generalisation claim. The report says which one it is.
const basis = holdoutExecuted ? holdout : dev;

// Ties on score are broken by what the bake-off is actually deciding: serve the
// cheaper, faster candidate.
const byServingCost = (a, b) => (a.mean_task_latency_s ?? Infinity) - (b.mean_task_latency_s ?? Infinity) || (a.tokens_per_task ?? Infinity) - (b.tokens_per_task ?? Infinity);

// A base's bake-off standing is its best rung; the ladder below it shows
// whether SFT and GRPO actually bought anything.
const byBase = {};
for (const row of basis) {
  const current = byBase[row.base];
  if (!current || (row.mean_score ?? -1) > (current.mean_score ?? -1)) byBase[row.base] = row;
  else if ((row.mean_score ?? -1) === (current.mean_score ?? -1) && byServingCost(row, current) < 0) byBase[row.base] = row;
}
const ranked = Object.values(byBase).sort((a, b) => (b.mean_score ?? -1) - (a.mean_score ?? -1) || byServingCost(a, b));

const bands = [...new Set(basis.flatMap((row) => Object.keys(row.mean_by_band ?? {})))].sort();
const bestPerBand = Object.fromEntries(bands.map((band) => {
  const best = basis
    .filter((row) => typeof row.mean_by_band?.[band] === "number")
    .sort((a, b) => b.mean_by_band[band] - a.mean_by_band[band] || byServingCost(a, b))[0];
  return [band, best ? { label: best.label, score: best.mean_by_band[band], cost_usd_per_1k_tasks: best.cost_usd_per_1k_tasks, p50_request_latency_s: best.p50_request_latency_s } : null];
}));
const bestPerTier = Object.fromEntries(["v1", "hard"].map((tier) => {
  const key = tier === "hard" ? "hard_tier" : "v1_tier";
  const best = basis.filter((row) => typeof row[key] === "number").sort((a, b) => b[key] - a[key] || byServingCost(a, b))[0];
  return [tier, best ? { label: best.label, score: best[key], cost_usd_per_1k_tasks: best.cost_usd_per_1k_tasks, p50_request_latency_s: best.p50_request_latency_s } : null];
}));

const report = {
  schema_version: "understudy.bakeoff.ranked_table.v1",
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  contract_sha256: [...contracts][0],
  fixture_sha256: [...fixtures][0],
  artifacts: rows.length,
  price_card: priceCard ? { source: priceCard.source, retrieved_at: priceCard.retrieved_at, models: Object.keys(priceCard.models) } : null,
  holdout_executed: holdoutExecuted,
  ranking_basis: holdoutExecuted ? "holdout" : "dev",
  ladder_dev: dev.sort((a, b) => a.label.localeCompare(b.label)),
  ladder_holdout: holdout.sort((a, b) => a.label.localeCompare(b.label)),
  ranked: ranked,
  best_per_band: bestPerBand,
  best_per_tier: bestPerTier,
};

function markdown() {
  const lines = [];
  const fmt = (value, digits = 4) => (value === null || value === undefined ? "—" : typeof value === "number" ? value.toFixed(digits) : String(value));
  lines.push("| Rung | Split | n | Mean | v1 | hard | Over-action | Malformed | p50 req s | Task s | Tok/task |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of [...dev, ...holdout].sort((a, b) => a.label.localeCompare(b.label))) {
    lines.push(`| \`${row.label}\` | ${row.split} | ${row.n} | **${fmt(row.mean_score)}** | ${fmt(row.v1_tier)} | ${fmt(row.hard_tier)} | ${row.over_acting_episodes} | ${fmt(row.malformed_rate, 3)} | ${fmt(row.p50_request_latency_s, 2)} | ${fmt(row.mean_task_latency_s, 1)} | ${fmt(row.tokens_per_task, 0)} |`);
  }
  lines.push("");
  lines.push("");
  lines.push(`Ranking basis: **${holdoutExecuted ? "sealed holdout" : "dev (holdout not executed — seal intact)"}**`);
  lines.push("");
  lines.push(`| Rank | Base (best rung) | ${holdoutExecuted ? "Holdout" : "Dev"} | p50 req s | Task s | Tok/task | $/1k tasks |`);
  lines.push("| ---: | --- | ---: | ---: | ---: | ---: | ---: |");
  ranked.forEach((row, index) => {
    lines.push(`| ${index + 1} | \`${row.label}\` | **${fmt(row.mean_score)}** | ${fmt(row.p50_request_latency_s, 2)} | ${fmt(row.mean_task_latency_s, 1)} | ${fmt(row.tokens_per_task, 0)} | ${fmt(row.cost_usd_per_1k_tasks, 2)} |`);
  });
  lines.push("");
  lines.push("| Workload band | Best candidate | Score | p50 req s | $/1k tasks |");
  lines.push("| --- | --- | ---: | ---: | ---: |");
  for (const [band, best] of Object.entries(bestPerBand)) {
    if (!best) continue;
    lines.push(`| ${band} | \`${best.label}\` | ${fmt(best.score)} | ${fmt(best.p50_request_latency_s, 2)} | ${fmt(best.cost_usd_per_1k_tasks, 2)} |`);
  }
  for (const [tier, best] of Object.entries(bestPerTier)) {
    if (!best) continue;
    lines.push(`| tier:${tier} | \`${best.label}\` | ${fmt(best.score)} | ${fmt(best.p50_request_latency_s, 2)} | ${fmt(best.cost_usd_per_1k_tasks, 2)} |`);
  }
  return `${lines.join("\n")}\n`;
}

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
if (mdPath) {
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, markdown());
}
console.log(markdown());
