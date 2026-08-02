import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  FixtureExperimentExecutor,
  buildTerminalResult,
  cellToSubmitPayload,
  eventBase,
  findUnsupportedSchemaKeywords,
  loadWorkflowSchema,
  validateWorkflowContract,
} = await import("../dist/workflow-executor.js");

const contractDir = new URL("../schemas/vendor/understudy-experiment-v1/", import.meta.url);
const files = [
  "experiment-event.json",
  "experiment-executor-cancellation-receipt.json",
  "experiment-executor-job-ref.json",
  "experiment-executor-job-status.json",
  "experiment-executor-submit-request.json",
  "experiment-executor-usage-receipt.json",
  "experiment-result.json",
  "experiment-spec.json",
];

const cell = {
  experimentId: "nemotron-transfer",
  candidateId: "sft-epoch4",
  attempt: 0,
  model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
  modelRevision: "model-revision-1",
  checkpointRef: "tinker://example/checkpoint",
  promptSha256: "a".repeat(64),
  renderer: "nemotron3_disable_thinking",
  workloadId: "synthetic-workflow-shapes",
  datasetManifestRef: "fixture://synthetic-workflow-shapes",
  datasetManifestSha256: "b".repeat(64),
  verifierEnvironment: "synthetic-workflow-shapes-offline",
  verifierRevision: "c".repeat(64),
  trainManifestRef: "fixture://synthetic-workflow-shapes/train",
  trainManifestSha256: "d".repeat(64),
  devManifestRef: "fixture://synthetic-workflow-shapes/dev",
  devManifestSha256: "e".repeat(64),
  budgetUsd: 1,
  maxRollouts: 60,
  maxRuntimeSeconds: 3600,
};

test("vendored schemas match their provenance hashes", async () => {
  const provenance = JSON.parse(await readFile(new URL("PROVENANCE.json", contractDir), "utf8"));
  assert.equal(provenance.source_commit, "c299ca4");
  for (const file of files) {
    const bytes = await readFile(new URL(file, contractDir));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.files[file]);
  }
});

test("vendored schemas use only validator-supported keywords", async () => {
  for (const file of files) {
    const schema = JSON.parse(await readFile(new URL(file, contractDir), "utf8"));
    assert.deepEqual(findUnsupportedSchemaKeywords(schema), [], file);
  }
});

test("cell payload validates against the canonical submit schema and omits holdout", () => {
  const payload = cellToSubmitPayload(cell);
  assert.equal(validateWorkflowContract(payload, loadWorkflowSchema("submit")).valid, true);
  assert.equal("holdout" in payload.splits, false);
  assert.equal(payload.candidate.executor, "fixture");
  assert.notEqual(payload.candidate.executor, "tinker");
  assert.equal(payload.candidate.model_revision, cell.modelRevision);
  assert.notEqual(payload.candidate.policy_sha256, cell.promptSha256);
  assert.notEqual(
    payload.candidate.policy_sha256,
    cellToSubmitPayload({ ...cell, checkpointRef: "tinker://example/other" }).candidate.policy_sha256,
  );
});

test("holdout-bearing cells are rejected before submission", () => {
  assert.throws(() => cellToSubmitPayload({ ...cell, holdoutManifestRef: "fixture://holdout" }), /holdout/);
});

test("submit is idempotent and binds split, prompt, and checkpoint identity", () => {
  const executor = new FixtureExperimentExecutor(() => 0);
  const first = executor.submit(cell);
  const retry = executor.submit(cell);
  assert.deepEqual(retry, first);
  assert.equal(first.submitted_at, new Date(0).toISOString());
  assert.notEqual(executor.submit({ ...cell, attempt: 1 }).job_id, first.job_id);
  assert.notEqual(executor.submit({ ...cell, promptSha256: "f".repeat(64) }).job_id, first.job_id);
  assert.notEqual(executor.submit({ ...cell, checkpointRef: "tinker://example/other" }).job_id, first.job_id);
});

test("cancel and usage reconciliation return canonical receipts", () => {
  const executor = new FixtureExperimentExecutor(() => 0);
  const job = executor.submit(cell);
  const cancellation = executor.cancel(job);
  assert.equal(validateWorkflowContract(cancellation, loadWorkflowSchema("cancellation")).valid, true);
  const usage = {
    evidence_scope: "run_exclusive",
    requests: 3,
    input_tokens: 100,
    output_tokens: 20,
    actual_usd: 0.01,
    estimated_usd: null,
    upper_bound_usd: null,
    observed_at: new Date(0).toISOString(),
  };
  assert.deepEqual(executor.reconcileUsage(job, usage), usage);
  assert.equal(executor.reconcileUsage(job, { ...usage, evidence_scope: "unknown" }).evidence_scope, "unknown");
});

test("redacted lifecycle events validate and reject sensitive content", () => {
  const executor = new FixtureExperimentExecutor(() => 0);
  const base = eventBase("nemotron-transfer", 0, "experiment.accepted");
  executor.emitEvent({ ...base, budget_usd: 1, holdout_sealed: true });
  executor.emitEvent({ ...eventBase("nemotron-transfer", 1, "experiment.phase_changed"), phase: "evaluating" });
  executor.emitEvent({
    ...eventBase("nemotron-transfer", 2, "rollout.state_changed"),
    candidate_id: "sft-epoch4",
    task_id: "workflow-route-01",
    state: "succeeded",
  });
  executor.emitEvent({
    ...eventBase("nemotron-transfer", 4, "candidate.state_changed"),
    candidate_id: "sft-epoch4",
    state: "running",
    job: {
      executor: "fixture",
      job_id: "tinker://example/sampler_weights/000020",
      idempotency_key: "prompt_sha256-aaaaaaaa",
      submitted_at: new Date(0).toISOString(),
    },
  });
  executor.emitEvent({
    ...eventBase("nemotron-transfer", 3, "score.snapshot"),
    candidate_id: "sft-epoch4",
    metrics: { mean: 0.5 },
    frontier: false,
  });
  assert.equal(executor.events().length, 5);
  assert.throws(
    () => executor.emitEvent({ ...base, budget_usd: 1, holdout_sealed: true, transcript: "redact" }),
    /unapproved fields/,
  );
});

test("terminal result preserves holdout and usage evidence semantics", () => {
  const result = buildTerminalResult({
    experimentId: "nemotron-transfer",
    verifierEnvironment: "synthetic-workflow-shapes-offline",
    verifierRevision: "c".repeat(64),
    trainManifestRef: "fixture://synthetic/train",
    trainManifestSha256: "d".repeat(64),
    devManifestRef: "fixture://synthetic/dev",
    devManifestSha256: "e".repeat(64),
    holdoutManifestRef: "fixture://synthetic/holdout",
    holdoutManifestSha256: "f".repeat(64),
    holdoutExecuted: false,
    holdoutClean: true,
    budgetUsd: 1,
    usage: {
      evidence_scope: "account_window",
      requests: null,
      input_tokens: 10,
      output_tokens: 2,
      actual_usd: null,
      estimated_usd: 0.01,
      upper_bound_usd: 0.02,
      observed_at: new Date(0).toISOString(),
    },
    baselineMetrics: { mean: 0.1 },
    optimizedMetrics: null,
    qualityStatus: "measured",
    qualityReason: null,
    requiredCalibration: null,
    calibrationArtifactRefs: [],
    failureClusters: [{ cluster: "step_limit", count: 1 }],
    cancellationReceipts: [],
    artifactRefs: ["artifact://summary"],
    claimBoundary: "train+dev only; holdout sealed",
    requestIsolationProven: false,
  });
  assert.equal(result.state, "holdout_locked");
  assert.equal(result.holdout_executed, false);
  assert.equal(result.request_isolation_proven, false);
  assert.equal(result.usage.evidence_scope, "account_window");
});
