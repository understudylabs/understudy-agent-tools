import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BOOTSTRAP_SEED,
  deriveGeneralizationReport,
  renderGeneralizationReport,
} from "../dist/generalization.js";
import {
  automationbenchArmRows,
  automationbenchFrozenHoldoutSha256,
  automationbenchGroup,
  oraclePolicy,
  sentinelPolicy,
} from "../dist/generalization-automationbench.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "fixtures", "generalization", name), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));
const baseManifest = (arms = ["a", "b"]) => ({
  schema_version: "understudy.generalization_manifest.v1",
  frozen_split_sha256: "frozen-hash",
  groups: [
    { group_id: "A", label: "AutomationBench", match: { task_id_prefix: "a-" } },
    { group_id: "B", label: "Verifiers", match: { task_id_prefix: "b-" } },
    { group_id: "partner-synth", label: "Partner synthetic", status: "planned", match: { task_id_prefix: "partner-synth-" } },
  ],
  arms: arms.map((id) => ({
    arm_id: id,
    train_groups: [id === "a" ? "A" : "B"],
    baseline: { rows: `arm-${id}-baseline.jsonl`, model: "base" },
    candidate: { rows: `arm-${id}-candidate.jsonl`, model: "tuned", receipt: `receipts/${id}.json` },
  })),
});
const fixtureRows = {
  a: { baseline: fixture("arm-a-baseline.jsonl"), candidate: fixture("arm-a-candidate.jsonl") },
  b: { baseline: fixture("arm-b-baseline.jsonl"), candidate: fixture("arm-b-candidate.jsonl") },
};

test("derives a multi-arm transfer matrix and deterministic markdown", () => {
  const report = deriveGeneralizationReport(baseManifest(), fixtureRows, { now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(report.schema_version, "understudy.generalization_report.v1");
  assert.equal(report.matrix.length, 2);
  assert.deepEqual(report.matrix[0].cells.map((cell) => cell.status), ["scored", "scored", "planned"]);
  assert.equal(report.matrix[0].cells[0].in_domain, true);
  assert.equal(report.matrix[0].cells[1].in_domain, false);
  assert.equal(report.matrix[0].cells[0].delta, 0.19999999999999996);
  assert.equal(report.matrix[0].cells[1].delta, 0.09999999999999998);
  assert.equal(report.matrix[1].cells[2].status, "planned");
  assert.deepEqual(report.coverage.groups.map((group) => group.status), ["scored", "scored", "planned"]);
  assert.match(renderGeneralizationReport(report), /\| Arm \| AutomationBench \| Verifiers \| Partner synthetic \|/);
  assert.ok(report.arms[0].task_deltas.some((task) => task.outcome === "fixed"));
});

test("keeps absent present groups as no_rows instead of zero scores", () => {
  const manifest = baseManifest(["a"]);
  manifest.groups.push({ group_id: "D", label: "Absent", status: "present", match: { task_id_prefix: "d-" } });
  const report = deriveGeneralizationReport(manifest, { a: fixtureRows.a });
  assert.equal(report.matrix[0].cells.find((cell) => cell.group_id === "D").status, "no_rows");
  assert.equal(report.coverage.groups.find((group) => group.group_id === "D").status, "no_rows");
});

test("reports unassigned task ids after resolving all arms", () => {
  const rows = structuredClone(fixtureRows);
  for (const side of ["baseline", "candidate"]) {
    rows.a[side].push({
      run_id: `a-${side}`,
      task_id: "orphan",
      split: "holdout",
      score: 0.5,
      status: "ok",
      provenance: { split_sha256: "frozen-hash" },
    });
  }
  const report = deriveGeneralizationReport(baseManifest(["a"]), rows);
  assert.deepEqual(report.coverage.unassigned_task_ids, ["c-1", "orphan"]);
  assert.ok(report.warnings.some((warning) => warning.includes("orphan")));
});

test("computes forgetting from scored group cells, not the worst task", () => {
  const manifest = {
    schema_version: "understudy.generalization_manifest.v1",
    frozen_split_sha256: "frozen-hash",
    groups: [
      { group_id: "A", match: { task_id_prefix: "a-" } },
      { group_id: "B", match: { task_id_prefix: "b-" } },
    ],
    arms: [{ arm_id: "a", train_groups: ["A"], baseline: { rows: "base" }, candidate: { rows: "candidate" } }],
  };
  const row = (run_id, task_id, score) => ({
    run_id, task_id, split: "holdout", score, status: "ok",
    provenance: { split_sha256: "frozen-hash", task_content_hashes: { env_sha256: task_id, verifier_sha256: task_id } },
  });
  const report = deriveGeneralizationReport(manifest, {
    a: {
      baseline: [row("base", "a-1", 0.5), row("base", "b-1", 1), row("base", "b-2", 0)],
      candidate: [row("candidate", "a-1", 0.6), row("candidate", "b-1", 0), row("candidate", "b-2", 0.2)],
    },
  });
  assert.equal(report.matrix[0].cells[1].delta, -0.4);
  assert.equal(report.score.forgetting, -0.4);
});

test("requires the frozen split hash on every holdout row", () => {
  const rows = structuredClone(fixtureRows);
  delete rows.a.baseline[0].provenance.split_sha256;
  assert.throws(
    () => deriveGeneralizationReport(baseManifest(["a"]), rows),
    /holdout row a-base\/a-1 has split_sha256 <missing>/,
  );
  rows.a.baseline[0].provenance.split_sha256 = "other";
  assert.throws(() => deriveGeneralizationReport(baseManifest(["a"]), rows), /expected frozen hash frozen-hash/);
});

test("rejects baseline/candidate content drift and coverage asymmetry", () => {
  const content = structuredClone(fixtureRows);
  content.a.candidate[0].provenance.task_content_hashes.env_sha256 = "different";
  assert.throws(() => deriveGeneralizationReport(baseManifest(["a"]), content), /task a-1.*content hashes disagree/);
  const coverage = structuredClone(fixtureRows);
  coverage.a.candidate = coverage.a.candidate.filter((row) => row.task_id !== "b-1");
  assert.throws(() => deriveGeneralizationReport(baseManifest(["a"]), coverage), /group B coverage mismatch/);
});

test("excludes skipped and unscored rows while exposing errors", () => {
  const rows = structuredClone(fixtureRows);
  rows.a.baseline.push({ run_id: "a-base", task_id: "a-1", split: "holdout", score: null, status: "skipped", provenance: { split_sha256: "frozen-hash", task_content_hashes: { env_sha256: "env-a1", verifier_sha256: "ver-a1" } } });
  rows.a.candidate.push({ run_id: "a-candidate", task_id: "a-1", split: "holdout", score: null, status: "error", provenance: { split_sha256: "frozen-hash", task_content_hashes: { env_sha256: "env-a1", verifier_sha256: "ver-a1" } } });
  const report = deriveGeneralizationReport(baseManifest(["a"]), rows);
  assert.equal(report.matrix[0].cells[0].n_tasks, 1);
  assert.equal(report.matrix[0].cells[0].error_rate, 0.5);
});

test("aggregates multiple rollouts per task and keeps bootstrap deterministic", () => {
  const rows = structuredClone(fixtureRows);
  rows.a.baseline.push({ run_id: "a-base-2", task_id: "a-1", split: "holdout", score: 0.7, status: "ok", provenance: { split_sha256: "frozen-hash", task_content_hashes: { env_sha256: "env-a1", verifier_sha256: "ver-a1" } } });
  rows.a.candidate.push({ run_id: "a-candidate-2", task_id: "a-1", split: "holdout", score: 0.9, status: "ok", provenance: { split_sha256: "frozen-hash", task_content_hashes: { env_sha256: "env-a1", verifier_sha256: "ver-a1" } } });
  const first = deriveGeneralizationReport(baseManifest(["a"]), rows, { bootstrap_seed: DEFAULT_BOOTSTRAP_SEED });
  const second = deriveGeneralizationReport(baseManifest(["a"]), rows, { bootstrap_seed: DEFAULT_BOOTSTRAP_SEED });
  assert.equal(first.arms[0].task_deltas.find((task) => task.task_id === "a-1").baseline_n_rollouts, 2);
  assert.deepEqual(first.matrix[0].cells[0].paired_ci, second.matrix[0].cells[0].paired_ci);
});

test("makes transfer ratio null without positive in-domain gain", () => {
  const rows = structuredClone(fixtureRows);
  for (const row of rows.a.candidate) row.score = row.task_id === "a-1" ? 0.4 : row.score;
  const report = deriveGeneralizationReport(baseManifest(["a"]), rows);
  assert.ok(Math.abs(report.score.in_domain_gain + 0.1) < 1e-12);
  assert.equal(report.score.transfer_ratio, null);
  assert.equal(report.score.generalization_score, null);
});

test("binds the real offline AutomationBench evaluator as group A", () => {
  const frozenHoldoutSha256 = automationbenchFrozenHoldoutSha256();
  const baseline = automationbenchArmRows({
    runId: "automationbench-baseline",
    splits: ["train", "holdout"],
    policy: sentinelPolicy(),
    model: "sentinel",
    frozenHoldoutSha256,
  });
  const candidate = automationbenchArmRows({
    runId: "automationbench-candidate",
    splits: ["train", "holdout"],
    policy: oraclePolicy,
    model: "oracle",
    frozenHoldoutSha256,
  });
  const group = automationbenchGroup();
  const report = deriveGeneralizationReport({
    schema_version: "understudy.generalization_manifest.v1",
    frozen_split_sha256: frozenHoldoutSha256,
    eval_splits: ["train", "holdout"],
    groups: [group],
    arms: [{
      arm_id: "automationbench",
      train_groups: [group.group_id],
      baseline: { rows: "offline-baseline", model: "sentinel" },
      candidate: { rows: "offline-candidate", model: "oracle" },
    }],
  }, {
    automationbench: { baseline, candidate },
  });
  const cell = report.matrix[0].cells[0];
  assert.equal(cell.status, "scored");
  assert.equal(cell.in_domain, true);
  assert.ok(cell.delta >= 0);
});

test("real offline AutomationBench holdout rows reject a wrong manifest hash", () => {
  const rows = automationbenchArmRows({
    runId: "automationbench-holdout",
    splits: ["holdout"],
    policy: sentinelPolicy(),
    frozenHoldoutSha256: automationbenchFrozenHoldoutSha256(),
  });
  const group = automationbenchGroup();
  assert.throws(() => deriveGeneralizationReport({
    schema_version: "understudy.generalization_manifest.v1",
    frozen_split_sha256: "wrong-frozen-hash",
    groups: [group],
    arms: [{
      arm_id: "automationbench",
      train_groups: [group.group_id],
      baseline: { rows: "offline-baseline" },
      candidate: { rows: "offline-candidate" },
    }],
  }, {
    automationbench: { baseline: rows, candidate: rows },
  }), /expected frozen hash wrong-frozen-hash/);
});
