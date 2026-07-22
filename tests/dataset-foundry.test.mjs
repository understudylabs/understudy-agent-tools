import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assignGroupedSplits,
  compileDatasetFoundry,
  curateExamples,
  derivedSystemPrompt,
  loadDatasetTable,
  normalizeDatasetText,
  resolveDatasetFile,
} from "../dist/dataset-foundry.js";
import { deriveClassMetrics, isClassificationBenchmark, predictedLabelFrom } from "../dist/dataset-metrics.js";
import { inferTableMapping } from "../dist/capture-import.js";
import { scoreContract } from "../dist/trace-foundry.js";
import { classificationGoldLabel, majorityClassRunner, nullAgentRunner, oracleRunner } from "../dist/run-executor.js";
import { validateBenchmarkManifest } from "../dist/benchmark.js";

const readJsonl = (path) => readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

const CSV = [
  "text,label,merchant",
  '"coffee at blue bottle",food,"blue bottle"',
  '"latte at blue bottle",food,"blue bottle"',
  '"netflix subscription",entertainment,netflix',
  '"netflix 4k plan",entertainment,netflix',
  '"uber to airport",transport,uber',
  '"uber to airport",transport,uber', // exact duplicate
  '"lyft downtown",transport,lyft',
  '"aws bill",cloud,aws',
  '"aws bill",fraud,aws', // label conflict with the row above
  '"gcp invoice",cloud,gcp',
  '"digitalocean droplet",cloud,digitalocean',
  '"dinner at zuni",food,zuni',
  '"groceries at berkeley bowl",food,"berkeley bowl"',
  '"spotify family plan",entertainment,spotify',
  '"caltrain monthly pass",transport,caltrain',
  "",
].join("\n");

function writeCsvFixture(root) {
  const file = join(root, "spend.csv");
  writeFileSync(file, CSV);
  return file;
}

test("column inference: reuses capture-import heuristics for CSV and works on JSONL tables", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-ds-"));
  const csv = writeCsvFixture(root);
  const table = loadDatasetTable(csv);
  const mapping = inferTableMapping(table.headers, table.rows);
  assert.equal(mapping.label_column, "label");
  assert.ok(mapping.input_columns.includes("text"));
  assert.equal(mapping.confidence, "high");

  const jsonl = join(root, "rows.jsonl");
  writeFileSync(jsonl, [
    JSON.stringify({ review: "app crashed on login", category: "bug" }),
    JSON.stringify({ review: "love the dark mode", category: "praise" }),
    JSON.stringify({ review: "app crashed opening batch", category: "bug" }),
  ].join("\n") + "\n");
  const jsonlTable = loadDatasetTable(jsonl);
  assert.equal(jsonlTable.format, "jsonl");
  assert.deepEqual(jsonlTable.headers, ["review", "category"]);
  const jsonlMapping = inferTableMapping(jsonlTable.headers, jsonlTable.rows);
  assert.equal(jsonlMapping.label_column, "category");
  assert.deepEqual(jsonlMapping.input_columns, ["review"]);

  // Directory resolution: two data files are ambiguous, never silently picked.
  assert.throws(() => resolveDatasetFile(root), /Ambiguous dataset dir/);
  assert.equal(resolveDatasetFile(csv), csv);
});

test("curation: exact-dup removal + label-conflict quarantine, in the und-289 order", () => {
  const example = (row, text, label) => ({ row_number: row, text, label, normalized_text: normalizeDatasetText(text), group_key: normalizeDatasetText(text) });
  const result = curateExamples([
    example(1, "AWS Bill", "cloud"),
    example(2, "aws  bill", "fraud"), // conflict (normalized text equal, different label)
    example(3, "uber to airport", "transport"),
    example(4, "Uber to Airport", "transport"), // duplicate after normalization
    example(5, "", "transport"), // unusable: empty text
    example(6, "lyft", ""), // unusable: empty label
    example(7, "gcp invoice", "cloud"),
  ]);
  assert.equal(result.conflicts.length, 2); // BOTH members quarantined
  assert.deepEqual(result.conflicts.map((c) => c.row_number), [1, 2]);
  assert.deepEqual(result.conflicts[0].conflicting_labels, ["cloud", "fraud"]);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].kept_row_number, 3);
  assert.equal(result.unusable.length, 2);
  assert.deepEqual(result.kept.map((k) => k.row_number), [3, 7]);
});

test("grouped splits: zero group overlap property over randomized datasets", () => {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let trial = 0; trial < 20; trial += 1) {
    const groups = new Map();
    const groupCount = 3 + Math.floor(rand() * 200);
    for (let g = 0; g < groupCount; g += 1) groups.set(`group-${trial}-${g}`, 1 + Math.floor(rand() * 9));
    const ratios = { train: 0.8, dev: 0.1, holdout: 0.1 };
    const assignment = assignGroupedSplits(groups, ratios, `salt-${trial}`);
    // Every group assigned exactly once, to exactly one split.
    assert.equal(assignment.size, groups.size);
    const bySplit = { train: new Set(), dev: new Set(), holdout: new Set() };
    for (const [key, split] of assignment) bySplit[split].add(key);
    assert.equal(bySplit.train.size + bySplit.dev.size + bySplit.holdout.size, groups.size);
    for (const key of bySplit.train) { assert.ok(!bySplit.dev.has(key)); assert.ok(!bySplit.holdout.has(key)); }
    for (const key of bySplit.dev) assert.ok(!bySplit.holdout.has(key));
    // All three splits populated (seeded), and deterministic.
    assert.ok(bySplit.train.size > 0 && bySplit.dev.size > 0 && bySplit.holdout.size > 0);
    const again = assignGroupedSplits(groups, ratios, `salt-${trial}`);
    assert.deepEqual([...again.entries()], [...assignment.entries()]);
    // Row-weighted sizes track the ratios loosely on larger trials.
    if (groupCount > 100) {
      const rows = { train: 0, dev: 0, holdout: 0 };
      for (const [key, size] of groups) rows[assignment.get(key)] += size;
      const total = rows.train + rows.dev + rows.holdout;
      assert.ok(Math.abs(rows.train / total - 0.8) < 0.1, `train share ${rows.train / total}`);
    }
  }
});

test("compile: full benchmark dir with curation report, grouped splits, born-accepted-ready proposal, oracle pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-ds-"));
  const csv = writeCsvFixture(root);
  const output = join(root, "bench");
  const result = compileDatasetFoundry(csv, output, { name: "spend", now: new Date("2026-07-22T00:00:00Z") });

  // Counts: 15 rows − 1 duplicate − 2 conflict rows = 12 tasks.
  assert.equal(result.counts.source_rows, 15);
  assert.equal(result.curation.duplicates_removed, 1);
  assert.equal(result.curation.conflict_rows_quarantined, 2);
  assert.equal(result.curation.conflict_inputs, 1);
  assert.equal(result.counts.tasks, 12);
  assert.equal(result.splits.rows.train + result.splits.rows.dev + result.splits.rows.holdout, 12);
  assert.equal(result.splits.no_group_overlap, true);
  assert.equal(result.oracle_pass, true);
  assert.equal(result.sentinel_pass, true);
  assert.equal(result.self_check.failed, 0);

  // Quarantined/removed rows are LISTED, not just counted.
  const conflicts = readJsonl(join(output, "curation", "conflicts.jsonl"));
  assert.equal(conflicts.length, 2);
  assert.deepEqual(conflicts[0].conflicting_labels, ["cloud", "fraud"]);
  const duplicates = readJsonl(join(output, "curation", "duplicates.jsonl"));
  assert.equal(duplicates.length, 1);
  const report = readFileSync(join(output, "curation-report.md"), "utf8");
  assert.match(report, /Label conflicts quarantined \| 2/);
  assert.match(report, /Exact duplicates removed \| 1/);
  assert.match(report, /majority_class floor arm/);
  assert.match(report, /data_selection\.splits_sha256/);

  // The proposal manifest is spine-valid (as benchmark.v1) with the new origin.
  const benchmark = JSON.parse(readFileSync(join(output, "benchmark.json"), "utf8"));
  assert.equal(benchmark.schema_version, "understudy.benchmark_proposal.v1");
  assert.equal(benchmark.provenance.origin, "derived-from-dataset");
  assert.deepEqual(validateBenchmarkManifest({ ...benchmark, schema_version: "understudy.benchmark.v1" }), []);
  assert.equal(benchmark.tasks.every((task) => task.genesis === "imported"), true);
  assert.equal(result.splits.splits_sha256, benchmark.splits.splits_sha256);
  assert.equal(result.experiment_linkage.splits_sha256, benchmark.splits.splits_sha256);

  // Tasks are classification-shaped: the majority arm recognizes them, and
  // gold labels round-trip.
  const tasks = readJsonl(join(output, "tasks.jsonl"));
  assert.equal(isClassificationBenchmark(tasks), true);
  for (const task of tasks) assert.ok(classificationGoldLabel(task) !== null);

  // The recommended run auto-includes the majority_class floor.
  assert.deepEqual(result.recommended_run.trivial_arms, ["null_agent", "majority_class"]);

  // Oracle runner scores 1.0 on every task (gold present by construction);
  // the null agent scores 0.
  const oracle = oracleRunner();
  const nullAgent = nullAgentRunner();
  for (const task of tasks) {
    const oracleResult = await oracle({ benchmarkDir: output, task, journalPath: null, model: "oracle", selectedTaskIds: [] });
    assert.equal(oracleResult.score, 1, `oracle must pass ${task.task_id}`);
    const nullResult = await nullAgent({ benchmarkDir: output, task, journalPath: null, model: "null", selectedTaskIds: [] });
    assert.equal(nullResult.score, 0);
  }
  // Majority arm answers the train-majority label deterministically.
  const majority = majorityClassRunner();
  const anyTask = tasks[0];
  const majorityResult = await majority({ benchmarkDir: output, task: anyTask, journalPath: null, model: "majority", selectedTaskIds: [] });
  assert.equal(typeof majorityResult.final_response_excerpt, "string");
});

test("contract scoring is fenced-JSON tolerant on dataset tasks", () => {
  const task = {
    outcome_contract: {
      required: [{ type: "response_obligation", kind: "contains_category", expected: "entertainment", provenance: "dataset_gold" }],
      forbidden: [],
    },
  };
  const fenced = 'Sure — here is my answer:\n```json\n{"label": "entertainment"}\n```\nHope that helps.';
  assert.equal(scoreContract(task, { calls: [], finalResponse: fenced }).strict, 1);
  assert.equal(scoreContract(task, { calls: [], finalResponse: '{"label": "entertainment"}' }).strict, 1);
  assert.equal(scoreContract(task, { calls: [], finalResponse: '{"label": "transport"}' }).strict, 0);
  assert.equal(scoreContract(task, { calls: [], finalResponse: "" }).strict, 0);
});

test("per-class metrics: accuracy, pass@k over rollouts, and confusion from response excerpts", () => {
  const mkTask = (id, label) => ({
    task_id: id,
    outcome_contract: { required: [{ type: "response_obligation", kind: "contains_category", expected: label }] },
  });
  const tasks = [mkTask("t1", "food"), mkTask("t2", "food"), mkTask("t3", "transport")];
  const manifestTasks = [
    { task_id: "t1", split: "train" },
    { task_id: "t2", split: "dev" },
    { task_id: "t3", split: "holdout" },
  ];
  const row = (taskId, score, rollout, excerpt, extra = {}) => ({
    task_id: taskId, model: "candidate", status: "ok", score, rollout,
    ...(excerpt === null ? {} : { final_response_excerpt: excerpt }), ...extra,
  });
  const rows = [
    row("t1", 1, 0, '{"label": "food"}'),
    row("t2", 0, 0, '```json\n{"label": "transport"}\n```'), // first rollout misses…
    row("t2", 1, 1, '{"label": "food"}'), // …second passes → pass@k > accuracy
    row("t3", 0, 0, "no idea"),
    // Anomalous rows are excluded like every other aggregate.
    row("t1", 0, 1, '{"label": "transport"}', { anomaly: { kind: "rollout_timeout", detail: "killed" } }),
  ];
  const metrics = deriveClassMetrics(rows, tasks, manifestTasks);
  assert.equal(metrics.classification_tasks, 3);
  assert.deepEqual(metrics.labels, ["food", "transport"]);
  const arm = metrics.arms.find((a) => a.arm === "candidate");
  const food = arm.labels.find((l) => l.label === "food");
  assert.deepEqual(food.support, { total: 2, train: 1, dev: 1, holdout: 0 });
  assert.equal(food.accuracy, 0.5); // first rollouts: t1 pass, t2 miss
  assert.equal(food.pass_at_k, 1); // any rollout: both pass
  const transport = arm.labels.find((l) => l.label === "transport");
  assert.equal(transport.accuracy, 0);
  // Confusion: newest excerpt per task; t3 unresolved ("no idea").
  assert.equal(arm.confusion.unresolved_rows, 1);
  const pairs = Object.fromEntries(arm.confusion.pairs.map((p) => [`${p.gold}→${p.predicted}`, p.count]));
  assert.equal(pairs["food→food"], 2); // t1 (rollout 0; anomalous rollout 1 excluded), t2 (newest = rollout 1)
});

test("predictedLabelFrom: JSON key, fenced JSON, unique token containment, honest null", () => {
  const labels = ["Customers tip too little or not at all", "I can't find items in the store"];
  assert.equal(predictedLabelFrom('{"label": "I can\'t find items in the store"}', labels), "I can't find items in the store");
  assert.equal(predictedLabelFrom('```json\n{"label": "customers tip too little or not at all"}\n```', labels), "Customers tip too little or not at all");
  assert.equal(predictedLabelFrom("The customer said: customers tip too little or not at all.", labels), "Customers tip too little or not at all");
  assert.equal(predictedLabelFrom("no label here", labels), null);
  assert.equal(predictedLabelFrom("", labels), null);
});

test("taxonomy: observed labels must be a subset; missing classes are reported not fatal", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-ds-"));
  const csv = writeCsvFixture(root);
  const taxonomy = join(root, "labels.json");
  writeFileSync(taxonomy, JSON.stringify(["food", "entertainment", "transport", "cloud", "pharmacy", "travel"]));
  const result = compileDatasetFoundry(csv, join(root, "bench-tax"), { taxonomyFile: taxonomy });
  assert.deepEqual(result.curation.taxonomy_labels_without_examples, ["pharmacy", "travel"]);
  assert.equal(result.curation.taxonomy_labels, 6);
  // The derived system prompt lists the FULL taxonomy (missing classes included).
  const prompt = derivedSystemPrompt("spend", ["food", "pharmacy"]);
  assert.match(prompt, /- pharmacy/);
  assert.match(prompt, /\{"label": "<label>"\}/);

  const badTaxonomy = join(root, "bad-labels.json");
  writeFileSync(badTaxonomy, JSON.stringify(["food", "entertainment"]));
  assert.throws(() => compileDatasetFoundry(csv, join(root, "bench-bad"), { taxonomyFile: badTaxonomy }), /not in the taxonomy/);
});

test("column overrides + group column drive the leakage grouping", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-ds-"));
  const csv = writeCsvFixture(root);
  const output = join(root, "bench-grouped");
  const result = compileDatasetFoundry(csv, output, {
    labelColumn: "label",
    inputColumns: ["text"],
    groupColumn: "merchant",
  });
  assert.deepEqual(result.mapping.input_columns, ["text"]);
  assert.equal(result.mapping.group_column, "merchant");
  // Rows sharing a merchant must share a split: blue bottle has two rows.
  const tasks = readJsonl(join(output, "tasks.jsonl"));
  const benchmark = JSON.parse(readFileSync(join(output, "benchmark.json"), "utf8"));
  const splitById = new Map(benchmark.tasks.map((task) => [task.task_id, task.split]));
  const blueBottle = tasks.filter((task) => task.title.includes("blue bottle"));
  assert.equal(blueBottle.length, 2);
  assert.equal(splitById.get(blueBottle[0].task_id), splitById.get(blueBottle[1].task_id));
  assert.ok(existsSync(join(output, "environment", "understudy_trace_env", "tasks.json")));
});
