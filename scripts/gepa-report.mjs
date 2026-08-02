#!/usr/bin/env node
/**
 * Compare synthetic AutomationBench arm reports and emit auditable eval rows.
 * This report consumes one sealed split at a time and never trains on it.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  finish,
  reset,
} from "../dist/automationbench-offline.js";
import {
  v2FixtureSha256,
  v2SplitSha256,
  v2TaskBands,
  v2TaskPool,
} from "../dist/automationbench-v2.js";

const SCHEMA_PATH = new URL("../schemas/understudy.eval_result.v1.schema.json", import.meta.url);
const EVAL_SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const BANDS = Object.values(v2TaskBands()).filter((band, index, values) => values.indexOf(band) === index).sort();

function argValues(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function argValue(argv, name, fallback = null) {
  return argValues(argv, name)[0] ?? fallback;
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

export function bootstrapCI(values, { resamples = 10_000, seed = 0x51f15e } = {}) {
  const scored = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (scored.length === 0) return { low: null, high: null, n: 0, resamples };
  const random = createRng(seed);
  const means = [];
  for (let sample = 0; sample < resamples; sample += 1) {
    let total = 0;
    for (let index = 0; index < scored.length; index += 1) {
      total += scored[Math.floor(random() * scored.length)];
    }
    means.push(total / scored.length);
  }
  means.sort((a, b) => a - b);
  return {
    low: means[Math.floor(resamples * 0.025)],
    high: means[Math.floor(resamples * 0.975)],
    n: scored.length,
    resamples,
  };
}

export function nullFloorRows(split, frozenHoldoutSha256 = undefined) {
  const tasks = v2TaskPool({ split, frozenHoldoutSha256 });
  return tasks.map((task) => {
    const { handle } = reset(task.taskId);
    const score = finish(handle).reward;
    return {
      task_id: task.taskId,
      family: task.taskId.replace(/^(?:simple|hard)-api-/, "").replace(/-\d{2}$/, ""),
      band: v2TaskBands()[task.taskId.replace(/^(?:simple|hard)-api-/, "").replace(/-\d{2}$/, "")],
      score,
      steps: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      forbidden_effects: 0,
      malformed: 0,
      tool_calls: 0,
      split,
    };
  });
}

function validateRow(row) {
  const errors = [];
  for (const required of EVAL_SCHEMA.required ?? []) {
    if (!(required in row)) errors.push(`missing required field ${required}`);
  }
  if (row.schema_version !== EVAL_SCHEMA.properties.schema_version.const) errors.push("invalid schema_version");
  if (typeof row.run_id !== "string" || row.run_id.length === 0) errors.push("invalid run_id");
  if (typeof row.task_id !== "string" || row.task_id.length === 0) errors.push("invalid task_id");
  if (!["ok", "error", "skipped", "unscored"].includes(row.status)) errors.push("invalid status");
  if (row.score !== null && (typeof row.score !== "number" || row.score < 0 || row.score > 1)) errors.push("invalid score");
  if (row.split !== "train" && row.split !== "dev" && row.split !== "holdout") errors.push("invalid report split");
  if (!row.provenance || row.provenance.harness_sha256 !== v2FixtureSha256()) errors.push("invalid harness provenance");
  if (!row.provenance || row.provenance.split_sha256 !== v2SplitSha256(row.split)) errors.push("invalid split provenance");
  if (errors.length > 0) throw new Error(`schema validation failed for ${row.task_id}: ${errors.join(", ")}`);
}

function rowFromReport(arm, report, sourceRow, split) {
  const score = typeof sourceRow.score === "number" ? sourceRow.score : null;
  const status = score === null ? (sourceRow.error ? "error" : "unscored") : "ok";
  const taskId = sourceRow.task_id;
  const band = sourceRow.band ?? v2TaskBands()[sourceRow.family];
  const row = {
    schema_version: "understudy.eval_result.v1",
    run_id: `${arm}-${split}`,
    task_id: taskId,
    split,
    score,
    status,
    model: report.model ?? null,
    route: report.base_url ?? "tinker-shim",
    tokens: {
      prompt: Number.isInteger(sourceRow.prompt_tokens) ? sourceRow.prompt_tokens : null,
      completion: Number.isInteger(sourceRow.completion_tokens) ? sourceRow.completion_tokens : null,
    },
    provenance: {
      harness_sha256: v2FixtureSha256(),
      split_sha256: v2SplitSha256(split),
      artifact_refs: [report.source_path ?? `${arm}-report.json`],
    },
    band,
    steps: sourceRow.steps ?? null,
    tool_calls: sourceRow.steps ?? null,
    malformed: sourceRow.malformed ?? null,
    forbidden_effects: sourceRow.forbidden_effects ?? null,
    feedback: sourceRow.feedback ?? null,
  };
  validateRow(row);
  return row;
}

function metricsForRows(rows, report, split) {
  const scored = rows.filter((row) => typeof row.score === "number");
  const total = rows.length;
  const byBand = Object.fromEntries(BANDS.map((band) => {
    const scores = scored.filter((row) => row.band === band).map((row) => row.score);
    return [band, mean(scores)];
  }));
  const wall = Number(report.wall_clock_s);
  return {
    mean_score: mean(scored.map((row) => row.score)),
    mean_by_band: byBand,
    exact_1_rate: mean(scored.map((row) => row.score === 1 ? 1 : 0)),
    zero_rate: mean(scored.map((row) => row.score === 0 ? 1 : 0)),
    forbidden_effect_rate: mean(rows.map((row) => row.forbidden_effects > 0 ? 1 : 0)),
    malformed_rate: mean(rows.map((row) => row.malformed > 0 ? 1 : 0)),
    mean_steps_per_rollout: mean(rows.map((row) => row.steps).filter((value) => typeof value === "number")),
    mean_tool_calls_per_rollout: mean(rows.map((row) => row.tool_calls).filter((value) => typeof value === "number")),
    tokens_per_rollout: {
      prompt: mean(rows.map((row) => row.tokens?.prompt).filter((value) => typeof value === "number")),
      completion: mean(rows.map((row) => row.tokens?.completion).filter((value) => typeof value === "number")),
    },
    wall_clock_per_rollout_s: total > 0 && Number.isFinite(wall) ? wall / total : null,
    scored: scored.length,
    total,
    ci95: bootstrapCI(scored.map((row) => row.score)),
    split,
  };
}

function markdownReport(comparison) {
  const metricRows = [
    ["mean score", (arm) => arm.metrics.mean_score],
    ["exact-1 rate", (arm) => arm.metrics.exact_1_rate],
    ["zero rate", (arm) => arm.metrics.zero_rate],
    ["forbidden-effect rate", (arm) => arm.metrics.forbidden_effect_rate],
    ["malformed rate", (arm) => arm.metrics.malformed_rate],
    ["mean steps/rollout", (arm) => arm.metrics.mean_steps_per_rollout],
    ["mean tool calls/rollout", (arm) => arm.metrics.mean_tool_calls_per_rollout],
    ["prompt tokens/rollout", (arm) => arm.metrics.tokens_per_rollout.prompt],
    ["completion tokens/rollout", (arm) => arm.metrics.tokens_per_rollout.completion],
    ["wall-clock s/rollout", (arm) => arm.metrics.wall_clock_per_rollout_s],
  ];
  const headers = ["metric", ...comparison.arms.map((arm) => arm.label), "delta vs first arm"];
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const [label, get] of metricRows) {
    const values = comparison.arms.map(get);
    const delta = values.length > 1 && values[0] !== null && values[1] !== null ? values[1] - values[0] : null;
    lines.push(`| ${label} | ${values.map((value) => value === null ? "—" : value.toFixed(4)).join(" | ")} | ${delta === null ? "—" : delta.toFixed(4)} |`);
  }
  lines.push("", "### Per-band mean");
  const bandHeaders = ["band", ...comparison.arms.map((arm) => arm.label), "delta vs first arm"];
  lines.push(`| ${bandHeaders.join(" | ")} |`, `| ${bandHeaders.map(() => "---").join(" | ")} |`);
  for (const band of BANDS) {
    const values = comparison.arms.map((arm) => {
      const value = arm.metrics.mean_by_band[band];
      return value === null ? "—" : value.toFixed(4);
    });
    const numeric = comparison.arms.slice(0, 2).map((arm) => arm.metrics.mean_by_band[band]);
    const delta = numeric.every((value) => typeof value === "number") ? (numeric[1] - numeric[0]).toFixed(4) : "—";
    lines.push(`| ${band} | ${values.join(" | ")} | ${delta} |`);
  }
  lines.push("", "### Bootstrap intervals");
  for (const arm of comparison.arms) {
    const ci = arm.metrics.ci95;
    lines.push(`- ${arm.label}: 95% CI [${ci.low?.toFixed(4) ?? "—"}, ${ci.high?.toFixed(4) ?? "—"}], n=${ci.n}`);
  }
  for (const comparisonEntry of comparison.paired_deltas) {
    const ci = comparisonEntry.ci95;
    lines.push(`- Paired delta ${comparisonEntry.label}: 95% CI [${ci.low?.toFixed(4) ?? "—"}, ${ci.high?.toFixed(4) ?? "—"}], n=${ci.n}`);
  }
  if (comparison.optimization_lead_not_win) lines.push("", "optimization lead, not a win: the arm confidence intervals overlap.");
  return `${lines.join("\n")}\n`;
}

export function buildReport({ arms, split, frozenHoldoutSha256 = undefined }) {
  const expectedTasks = new Set(v2TaskPool({ split, frozenHoldoutSha256 }).map((task) => task.taskId));
  const armResults = [];
  const allRows = [];
  for (const arm of arms) {
    const report = JSON.parse(readFileSync(arm.path, "utf8"));
    const rows = (report.rows ?? []).filter((row) => expectedTasks.has(row.task_id)).map((row) => rowFromReport(arm.label, { ...report, source_path: arm.path }, row, split));
    if (rows.length !== expectedTasks.size) throw new Error(`${arm.label} has ${rows.length} rows; expected ${expectedTasks.size}`);
    allRows.push(...rows.map((row) => ({ ...row, arm: arm.label })));
    armResults.push({ label: arm.label, source_path: arm.path, metrics: metricsForRows(rows, report, split), rows });
  }
  const nullRows = nullFloorRows(split, frozenHoldoutSha256).map((row) => ({
    schema_version: "understudy.eval_result.v1",
    run_id: `null-floor-${split}`,
    task_id: row.task_id,
    split,
    score: row.score,
    status: "ok",
    model: null,
    route: "in-process-null-floor",
    tokens: { prompt: 0, completion: 0 },
    provenance: { harness_sha256: v2FixtureSha256(), split_sha256: v2SplitSha256(split), artifact_refs: ["in-process-immediate-finish"] },
    band: row.band,
    steps: 0,
    tool_calls: 0,
    malformed: 0,
    forbidden_effects: 0,
  }));
  nullRows.forEach(validateRow);
  const nullArm = {
    label: "null-floor",
    source_path: null,
    metrics: metricsForRows(nullRows, { wall_clock_s: 0 }, split),
    rows: nullRows,
  };
  const baseline = armResults[0];
  const pairedDeltas = armResults.slice(1).map((arm) => {
    const baselineByTask = new Map(baseline.rows.map((row) => [row.task_id, row.score]));
    const deltas = arm.rows
      .filter((row) => typeof row.score === "number" && typeof baselineByTask.get(row.task_id) === "number")
      .map((row) => row.score - baselineByTask.get(row.task_id));
    return { label: `${arm.label} - ${baseline.label}`, ci95: bootstrapCI(deltas), mean_delta: mean(deltas) };
  });
  const overlap = armResults.slice(1).some((arm) => {
    const left = baseline.metrics.ci95;
    const right = arm.metrics.ci95;
    return left.low !== null && right.low !== null && left.low <= right.high && right.low <= left.high;
  });
  return {
    fixture: "automationbench-simple-api-offline-v2",
    split,
    bands: BANDS,
    arms: [...armResults, nullArm],
    paired_deltas: pairedDeltas,
    optimization_lead_not_win: overlap,
    rows: allRows.concat(nullRows.map((row) => ({ ...row, arm: "null-floor" }))),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const armArgs = argValues(argv, "--arm");
  if (armArgs.length < 2) throw new Error("at least two --arm label=path arguments are required");
  const arms = armArgs.map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Error(`invalid --arm ${value}; expected label=path`);
    return { label: value.slice(0, separator), path: value.slice(separator + 1) };
  });
  const split = argValue(argv, "--split", "dev");
  const frozenHoldoutSha256 = argValue(argv, "--frozen-holdout");
  if (split === "holdout" && frozenHoldoutSha256 !== "2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9") {
    throw new Error("holdout reports require the frozen holdout hash");
  }
  const outDir = argValue(argv, "--out-dir", "outputs/gepa-report");
  mkdirSync(outDir, { recursive: true });
  const report = buildReport({ arms, split, frozenHoldoutSha256 });
  const rowsPath = argValue(argv, "--rows-out", join(outDir, "eval-results.jsonl"));
  const jsonPath = argValue(argv, "--json-out", join(outDir, "comparison.json"));
  const markdownPath = argValue(argv, "--markdown-out", join(outDir, "comparison.md"));
  mkdirSync(dirname(rowsPath), { recursive: true });
  writeFileSync(rowsPath, `${report.rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(jsonPath, `${JSON.stringify({ ...report, rows: undefined }, null, 2).replace('  "rows": null,\n', "")}\n`);
  writeFileSync(markdownPath, markdownReport(report));
  console.log(JSON.stringify({ rows: rowsPath, comparison: jsonPath, markdown: markdownPath }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
