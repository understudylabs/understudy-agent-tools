import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// The desktop app → benchmark spine bridge:
// 1. the CLI's additive `--plain-dir` experiment mode (lineage next to a
//    prepared dataset, before any benchmark exists) and the additive
//    `runs queue --experiment` cross-link;
// 2. the app-side pure logic in apps/homescreen/app/lib/experiment-bridge.mjs.
import {
  PROVIDER_TRAINING_SPEND_GATE,
  abandonedPatch,
  benchmarkLinkageState,
  classificationVerdict,
  concludedPatch,
  draftHypothesis,
  lineageSummary,
  providerSpendApproval,
  relevantRunRequest,
  remoteVerdict,
  sftVerdict,
  trainingExperimentInput,
} from "../apps/homescreen/app/lib/experiment-bridge.mjs";

const bin = path.resolve("dist/bin.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "app-benchmark-bridge-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cli = (...args) => {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const dataSelection = {
  selection_hash: "a".repeat(64),
  source: "support-tickets.csv",
  splits_sha256: "b".repeat(64),
};

const createInput = () =>
  trainingExperimentInput({
    method: "sft",
    baseModel: "answerdotai/ModernBERT-base",
    provider: "local",
    dataSelection,
    config: { task: "text_classification" },
  });

describe("CLI --plain-dir experiment lineage (dataset dir, no benchmark.json)", () => {
  const datasetDir = path.join(tmp, "dataset");
  fs.mkdirSync(datasetDir, { recursive: true });

  it("refuses a bare dir without --plain-dir (unchanged behavior)", () => {
    const result = cli("benchmarks", "experiment", "create", datasetDir, "--input", JSON.stringify(createInput()));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a benchmark dir/);
  });

  it("creates, updates (approvals append), and lists in a plain dir", () => {
    const created = cli(
      "benchmarks", "experiment", "create", datasetDir,
      "--plain-dir", "--input", JSON.stringify(createInput()),
    );
    assert.equal(created.status, 0, created.stderr);
    const experiment = JSON.parse(created.stdout);
    assert.equal(experiment.schema_version, "understudy.experiment.v1");
    assert.equal(experiment.status, "training");
    assert.equal(experiment.data_selection.selection_hash, dataSelection.selection_hash);
    assert.ok(fs.existsSync(path.join(datasetDir, "experiments.jsonl")));

    // The und-289 gate entry appends (never replaces) on update.
    const approval = providerSpendApproval("desktop-app:org:org_1", "2026-07-22T00:00:00Z");
    const updated = cli(
      "benchmarks", "experiment", "update", datasetDir, experiment.experiment_id,
      "--plain-dir", "--input", JSON.stringify({ training: { approvals: [approval] } }),
    );
    assert.equal(updated.status, 0, updated.stderr);
    const patched = JSON.parse(updated.stdout);
    assert.deepEqual(patched.training.approvals, [approval]);
    assert.equal(patched.training.base_model, "answerdotai/ModernBERT-base");

    // Conclude with the app's concludedPatch shape.
    const concluded = cli(
      "benchmarks", "experiment", "update", datasetDir, experiment.experiment_id,
      "--plain-dir", "--input", JSON.stringify(concludedPatch({ decision: "shadow", summary: "beats tf-idf" })),
    );
    assert.equal(concluded.status, 0, concluded.stderr);
    const final = JSON.parse(concluded.stdout);
    assert.equal(final.status, "concluded");
    assert.equal(final.verdict.decision, "shadow");
    // Approvals cleared earlier are never dropped by a later patch.
    assert.deepEqual(final.training.approvals, [approval]);

    const listed = cli("benchmarks", "experiment", "list", datasetDir);
    assert.equal(listed.status, 0, listed.stderr);
    const { experiments, total_lines } = JSON.parse(listed.stdout);
    assert.equal(experiments.length, 1);
    assert.equal(total_lines, 3);
    assert.equal(experiments[0].status, "concluded");
  });

  it("still validates records in plain-dir mode", () => {
    const result = cli(
      "benchmarks", "experiment", "create", datasetDir,
      "--plain-dir", "--input", JSON.stringify({ hypothesis: "" }),
    );
    assert.notEqual(result.status, 0);
  });
});

describe("runs queue --experiment cross-link", () => {
  const benchDir = path.join(tmp, "bench");
  fs.mkdirSync(benchDir, { recursive: true });
  fs.writeFileSync(
    path.join(benchDir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "bridge-bench",
      name: "Bridge bench",
      provenance: { origin: "authored" },
      taxonomy: [{ category_id: "cat-a" }],
      tasks: [{ task_id: "t1", category_id: "cat-a", genesis: "synthesized", split: "holdout" }],
      environment: { format: "verifiers.v1", package_ref: "pkg" },
      verifier: { kind: "reward-fns", strict_metric: "strict" },
    }),
  );

  it("rejects an experiment_id that is not in the benchmark's experiments.jsonl", () => {
    const result = cli(
      "runs", "queue", "--benchmark", benchDir,
      "--models", "glm-5.2", "--incumbent", "glm-5.2",
      "--experiment", "exp-missing",
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown experiment_id/);
  });

  it("queues the app's comparison shape once the experiment exists", () => {
    const created = cli(
      "benchmarks", "experiment", "create", benchDir,
      "--input", JSON.stringify({ ...createInput(), experiment_id: "exp-bridge-1" }),
    );
    assert.equal(created.status, 0, created.stderr);

    const armDir = path.join(tmp, "adapter");
    fs.mkdirSync(armDir, { recursive: true });
    const queued = cli(
      "runs", "queue", "--benchmark", benchDir,
      "--local-arm", `my-tuned-model=${armDir}`,
      "--models", "glm-5.2", "--incumbent", "glm-5.2",
      "--trivial-arms", "majority_class",
      "--experiment", "exp-bridge-1",
    );
    assert.equal(queued.status, 0, queued.stderr);
    const run = JSON.parse(queued.stdout);
    assert.equal(run.experiment_id, "exp-bridge-1");
    assert.equal(run.status, "queued");
    assert.ok(run.models.some((m) => typeof m === "object" && m.label === "my-tuned-model"));
    assert.deepEqual(run.incumbent_models, ["glm-5.2"]);
    assert.deepEqual(run.trivial_arms, ["majority_class"]);
    // The request landed in the file queue the executor watches.
    const queue = fs.readdirSync(path.join(benchDir, "runs", "queue"));
    assert.equal(queue.length, 1);
  });
});

describe("experiment-bridge app logic", () => {
  it("drafts a falsifiable hypothesis from the training config", () => {
    const local = draftHypothesis({ method: "sft", baseModel: "m", provider: "local", source: "ds" });
    assert.match(local, /on this Mac/);
    assert.match(local, /dataset ds/);
    assert.match(
      draftHypothesis({ method: "sft", baseModel: "m", provider: "managed", source: "ds" }),
      /on managed/,
    );
  });

  it("builds a create input and refuses a missing selection hash", () => {
    const input = createInput();
    assert.equal(input.status, "training");
    assert.deepEqual(input.training.approvals, []);
    assert.throws(() =>
      trainingExperimentInput({ method: "sft", baseModel: "m", provider: "local", dataSelection: {} }),
    );
  });

  it("providerSpendApproval demands an identity", () => {
    assert.equal(providerSpendApproval("me", "t").gate, PROVIDER_TRAINING_SPEND_GATE);
    assert.throws(() => providerSpendApproval(""));
    assert.throws(() => providerSpendApproval("   "));
  });

  it("maps outcomes conservatively (never auto-promote)", () => {
    assert.equal(classificationVerdict({ verdict: { status: "promising", reason: "r" } }).decision, "shadow");
    assert.equal(classificationVerdict({ verdict: { status: "improved_not_ready" } }).decision, "collect");
    assert.equal(classificationVerdict({ verdict: { status: "not_better" } }).decision, "stop");
    assert.equal(sftVerdict({ promotion: { status: "promoted" }, improvement: { improved: true } }).decision, "shadow");
    assert.equal(sftVerdict({ promotion: { status: "needs_work" }, improvement: { improved: true } }).decision, "collect");
    assert.equal(sftVerdict({ promotion: { status: "needs_work" }, improvement: { improved: false } }).decision, "stop");
    assert.equal(remoteVerdict({ outcome: "promoted", spend_usd: 3 }).decision, "shadow");
    assert.equal(remoteVerdict({ outcome: "needs_work", spend_usd: 3 }).decision, "collect");
    assert.equal(remoteVerdict({ outcome: "failed", spend_usd: 0 }).decision, "stop");
    assert.equal(abandonedPatch("why").verdict.decision, "stop");
  });

  it("summarizes a record compactly for the lineage card", () => {
    const summary = lineageSummary({
      experiment_id: "exp-1",
      status: "concluded",
      data_selection: { selection_hash: "c".repeat(64) },
      training: { provider: "local", approvals: [{ gate: "provider_training_spend" }] },
      verdict: { decision: "shadow", summary: "s" },
    });
    assert.equal(summary.dataHash, `${"c".repeat(12)}…`);
    assert.deepEqual(summary.approvals, ["provider_training_spend"]);
    assert.match(summary.verdict, /^shadow — /);
    assert.equal(lineageSummary(null), null);
  });

  it("derives the four honest benchmark linkage states", () => {
    const bridge = (exists, verb) => ({
      benchmark_dir: "/x/benchmark",
      benchmark_exists: exists,
      from_dataset_available: verb,
    });
    assert.equal(benchmarkLinkageState(bridge(true, false), { ref: "/a" }).kind, "ready");
    assert.equal(benchmarkLinkageState(bridge(true, true), null).kind, "no_artifact");
    assert.equal(benchmarkLinkageState(bridge(false, true), { ref: "/a" }).kind, "buildable");
    assert.equal(benchmarkLinkageState(bridge(false, false), { ref: "/a" }).kind, "landing");
    assert.equal(benchmarkLinkageState(null, null).kind, "landing");
  });

  it("picks the newest run request for the experiment", () => {
    const rows = [
      { run_id: "r1", created_at: "2026-01-01", experiment_id: "e1" },
      { run_id: "r2", created_at: "2026-01-03", experiment_id: "e2" },
      { run_id: "r3", created_at: "2026-01-02", experiment_id: "e1" },
    ];
    assert.equal(relevantRunRequest(rows, "e1").run_id, "r3");
    assert.equal(relevantRunRequest(rows, "missing").run_id, "r2");
    assert.equal(relevantRunRequest([], "e1"), null);
    assert.equal(relevantRunRequest(undefined, null), null);
  });
});
