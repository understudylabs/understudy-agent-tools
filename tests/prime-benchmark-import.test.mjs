import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { importPrimeBenchmark, inspectPrimeBenchmark } from "../dist/prime-benchmark-import.js";
import { appendPrimeBenchmarkReview, freezePrimeBenchmark } from "../dist/prime-benchmark-lifecycle.js";
import { comparePrimeModels } from "../dist/prime-benchmark-compare.js";
import { discoverPrimeScorecards, renderScorecardGallery } from "../dist/prime-scorecard-server.js";
import { planPrimeRun, runPrimeEvaluation, watchPrimeBenchmark } from "../dist/prime-benchmark-runner.js";

function syntheticTrace(model, score = 1) {
  return {
    id: `trace-${model}`,
    is_completed: true,
    stop_condition: "agent_completed",
    errors: [],
    verifiers: { version: "0.2.1" },
    run: { id: `run-${model}` },
    agent: { model, harness: { id: "synthetic-harness", version: "1.0.0" } },
    task: {
      data: {
        task_id: "task-synthetic-1",
        prompt: "Synthetic private prompt that must remain outside the aggregate package.",
        outcome_contract: {
          required: [
            { tool: "run-subagent", arguments_semantic: { subagentPath: "@subagents/synthetic-worker" } },
            { tool: "save-execution-summary" },
          ],
        },
      },
    },
    rewards: { final_state: score },
    metrics: { final_state_partial_credit: score },
    calls: [
      {
        time: { start: 100, end: 101.5 },
        usage: { prompt_tokens: 1000, cached_input_tokens: 500, completion_tokens: 100, reasoning_tokens: 25 },
      },
    ],
    nodes: [
      { message: { role: "system", content: "<role>Synthetic agent</role>" } },
      { message: { role: "user", content: "Run the synthetic workflow." } },
      {
        message: {
          role: "assistant",
          content: "Starting.",
          tool_calls: [{ name: "run-subagent", arguments: JSON.stringify({ subagentPath: "@subagents/synthetic-worker" }) }],
        },
      },
      { message: { role: "tool", content: "{\"success\":true}" } },
      {
        message: {
          role: "assistant",
          content: "Done.",
          tool_calls: [{ name: "save-execution-summary", arguments: "{}" }],
        },
      },
    ],
  };
}

test("imports Prime-native traces into an anonymized benchmark and renders the reusable scorecard", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-prime-benchmark-"));
  const source = join(root, "prime-runs");
  const modelDir = join(source, "synthetic-model");
  const aggregateOutput = join(root, "gallery", "synthetic-benchmark");
  const scorecardOutput = join(root, "private-scorecards", "synthetic-benchmark");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    join(modelDir, "traces.jsonl"),
    `${JSON.stringify(syntheticTrace("synthetic-model"))}\n${JSON.stringify(syntheticTrace("synthetic-candidate", 0.75))}\n`,
  );
  const config = {
    schema_version: "understudy.prime_benchmark_import.v1",
    benchmark_id: "synthetic-prime-benchmark-v1",
    name: "Synthetic Prime Benchmark",
    description: "Public-fixture benchmark with no customer data.",
    source_dir: source,
    output_dir: aggregateOutput,
    scorecard_output_dir: scorecardOutput,
    verifier_version: "0.2.1",
    incumbent_model: "synthetic-model",
    anonymized: true,
    environment: {
      package_ref: "synthetic:prime-environment",
      runtime: "subprocess",
      tool_surface: ["run-subagent", "save-execution-summary"],
    },
    tasks: {
      "task-synthetic-1": {
        label: "Synthetic orchestration",
        category_id: "orchestration",
        summary: ["Routes one synthetic subagent.", "Persists a synthetic execution summary.", "Measures deterministic final state."],
        split: "holdout",
      },
    },
    pricing: {
      "synthetic-model": { input: 1, cache_read: 0.1, output: 5, source: "synthetic reviewed fixture price" },
      "synthetic-candidate": { input: 0.5, cache_read: 0.05, output: 2.5, source: "synthetic reviewed fixture price" },
    },
  };
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const status = inspectPrimeBenchmark(configPath);
  assert.equal(status.ready_to_import, true);
  assert.equal(status.traces, 2);
  const imported = importPrimeBenchmark(configPath);
  assert.deepEqual(
    { models: imported.models, tasks: imported.tasks, rows: imported.rows },
    { models: 2, tasks: 1, rows: 2 },
  );
  const manifest = JSON.parse(readFileSync(join(aggregateOutput, "benchmark.json"), "utf8"));
  assert.equal(manifest.schema_version, "understudy.benchmark.v1");
  assert.equal(manifest.benchmark_id, "synthetic-prime-benchmark-v1");
  const aggregateText = readFileSync(join(aggregateOutput, "rows-prime.jsonl"), "utf8");
  assert.doesNotMatch(aggregateText, /Synthetic private prompt/);
  assert.match(aggregateText, /"usd":0\.001675/);
  const comparison = comparePrimeModels(aggregateOutput, "synthetic-model", "synthetic-candidate");
  assert.equal(comparison.comparable_task_count, 1);
  assert.equal(comparison.task_outcomes[0].outcome, "regressed");

  const renderer = resolve("runtime-assets/prime-scorecard/build-scorecard.mjs");
  const rendered = spawnSync(process.execPath, [renderer, configPath], { encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr);
  const viewer = readFileSync(join(scorecardOutput, "viewer", "index.html"), "utf8");
  assert.match(viewer, /Synthetic Prime Benchmark/);
  assert.match(viewer, /Synthetic orchestration/);
  assert.match(viewer, /Prime Verifiers 0\.2\.1/);
  assert.match(viewer, /MODEL LEADERBOARD/i);
  assert.match(viewer, /Conversation history/);
  const entries = discoverPrimeScorecards(join(root, "private-scorecards"));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].benchmark_id, "synthetic-prime-benchmark-v1");
  assert.equal(entries[0].rollouts, 2);
  const gallery = renderScorecardGallery(entries);
  assert.match(gallery, /Synthetic Prime Benchmark/);
  assert.match(gallery, /\/b\/synthetic-prime-benchmark\//);
  assert.throws(() => freezePrimeBenchmark(aggregateOutput, "too early"), /latest benchmark-scope review approves/);
  const review = appendPrimeBenchmarkReview(aggregateOutput, {
    decision: "approve",
    reviewer: "synthetic-reviewer",
    note: "Incumbent passes and the synthetic task contract is representative.",
  });
  assert.equal(review.decision, "approve");
  const frozen = freezePrimeBenchmark(aggregateOutput, "Synthetic golden fixture.");
  assert.equal(frozen.status, "frozen");
  assert.match(frozen.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.match(frozen.rows_sha256, /^[a-f0-9]{64}$/);
});

test("fails closed when durable task metadata is not explicitly anonymized", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-prime-private-"));
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({
    schema_version: "understudy.prime_benchmark_import.v1",
    benchmark_id: "private",
    name: "Private",
    source_dir: root,
    output_dir: join(root, "out"),
    verifier_version: "0.2.1",
    incumbent_model: "synthetic-model",
    anonymized: false,
    environment: { package_ref: "synthetic" },
    tasks: {},
    pricing: {},
  }));
  assert.throws(() => importPrimeBenchmark(configPath), /anonymized must be true/);
});

test("plans native Prime runs, gates provider transfer, and watches an already-ready corpus", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-prime-runner-"));
  const evalConfig = join(root, "model.toml");
  writeFileSync(evalConfig, 'model = "synthetic-model"\n');
  const plan = planPrimeRun(evalConfig);
  assert.deepEqual(plan.argv, ["eval", "--plain", "run", evalConfig]);
  assert.equal(plan.provider_data_transfer_required, true);
  assert.throws(
    () => runPrimeEvaluation(evalConfig, { allowProviderDataTransfer: false, dryRun: true }),
    /allow-provider-data-transfer/,
  );
  const dryRun = runPrimeEvaluation(evalConfig, { allowProviderDataTransfer: true, dryRun: true });
  assert.equal(dryRun.executed, false);
  assert.throws(() => planPrimeRun(join(root, "model.json")), /not found|must be a .toml/);

  const source = join(root, "source", "model");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "traces.jsonl"), `${JSON.stringify(syntheticTrace("synthetic-model"))}\n`);
  const importConfig = join(root, "import.json");
  writeFileSync(importConfig, JSON.stringify({
    schema_version: "understudy.prime_benchmark_import.v1",
    benchmark_id: "synthetic-watch-v1",
    name: "Synthetic watch",
    source_dir: join(root, "source"),
    output_dir: join(root, "aggregate"),
    verifier_version: "0.2.1",
    incumbent_model: "synthetic-model",
    anonymized: true,
    environment: { package_ref: "synthetic:environment" },
    tasks: { "task-synthetic-1": { label: "Task", category_id: "category" } },
    pricing: { "synthetic-model": { input: 1, cache_read: 0, output: 1, source: "synthetic" } },
  }));
  const snapshots = [];
  const ready = await watchPrimeBenchmark(importConfig, { intervalMs: 100, timeoutMs: 500, onSnapshot: (value) => snapshots.push(value) });
  assert.equal(ready.ready_to_import, true);
  assert.equal(snapshots.length, 1);
});
