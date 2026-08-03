import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

import {
  ExecutorCancellationReceiptSchema,
  ExecutorJobRefSchema,
  ExecutorJobStatusSchema,
  ExecutorUsageReceiptSchema,
} from "../dist/spark-experiment-executor.js";
import { ExperimentSubmitRequestSchema } from "../dist/experiment-executor.js";

const root = process.cwd();

test("qwen verifier-RL dry run exercises protocol, masking, advantages, and reward wiring", (t) => {
  if (!existsSync("/usr/bin/python3") && !existsSync("/bin/python3")) {
    t.skip("python3 unavailable; skipping glue smoke");
    return;
  }
  const receipt = join(tmpdir(), `qwen-verifier-rl-${process.pid}.json`);
  try {
    execFileSync(
      "python3",
      [
        "experiments/qwen-serverless-verifier-rl/verifier_rl.py",
        "--phase",
        "grpo",
        "--dry-run",
        "--receipt",
        receipt,
      ],
      { cwd: root, stdio: "pipe" },
    );
    const result = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(result.status, "ok");
    assert.equal(result.reward, 1);
    assert.equal(result.teardown_asserted, true);
    assert.ok(result.rendered_tokens > 0);
    assert.ok(result.assistant_weighted_tokens > 0);
    assert.ok(result.assistant_weighted_tokens >= 5);
    assert.ok(result.prompt_weighted_tokens > result.assistant_weighted_tokens);
    assert.equal(result.datum_lengths_equal, true);
    assert.equal(result.zero_spread_datums, 0);
    assert.equal(result.budget_guard_tripped, true);
    assert.deepEqual(result.advantages, [-1, 1]);
    assert.equal(result.cost.usd, 0);
  } finally {
    rmSync(receipt, { force: true });
  }
});

test("serving contract is pinned to the shared protocol module", async () => {
  const contract = JSON.parse(readFileSync(
    join(root, "experiments/qwen-serverless-verifier-rl/serving-contract.qwen3p6-27b.json"),
    "utf8",
  ));
  const protocol = await import("../dist/automationbench-action-protocol.js");
  const actual = createHash("sha256").update(protocol.ACTION_PROTOCOL_SYSTEM_PROMPT).digest("hex");
  assert.equal(contract.protocol_sha256, actual);
  assert.equal(contract.parser_id, protocol.ACTION_PROTOCOL_ID);
  assert.equal(contract.max_model_turns, protocol.ACTION_PROTOCOL_MAX_MODEL_TURNS);
});

test("RL service exposes shared parsing without changing synthetic protocol", async () => {
  const { startEnvService } = await import("../dist/automationbench-rl-service.js");
  const automation = await startEnvService({ benchmark: "automationbench" });
  const synthetic = await startEnvService({ benchmark: "synthetic-workflow" });
  try {
    const automationBase = `http://127.0.0.1:${automation.port}`;
    const syntheticBase = `http://127.0.0.1:${synthetic.port}`;
    const automationProtocol = await (await fetch(`${automationBase}/protocol`)).json();
    const syntheticProtocol = await (await fetch(`${syntheticBase}/protocol`)).json();
    assert.equal(automationProtocol.max_model_turns, 14);
    assert.equal(syntheticProtocol.max_model_turns, 12);
    assert.match(syntheticProtocol.system_prompt, /workflow apps/);
    const parsed = await (await fetch(`${automationBase}/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: '<think>{"bad":true}</think>{"tool":"finish","arguments":{}}' }),
    })).json();
    assert.deepEqual(parsed, { finish: true });
    const capturedQwenReply = '<think>Need to inspect the contact first.</think>\\n{"tool":"finish","arguments":{}}<|im_end|>';
    const parsedCaptured = await (await fetch(`${automationBase}/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: capturedQwenReply }),
    })).json();
    assert.deepEqual(parsedCaptured, { finish: true });
  } finally {
    automation.server.close();
    synthetic.server.close();
  }
});

test("canonical executor submit payload has no holdout or extra fields", () => {
  const schema = JSON.parse(readFileSync(
    join(root, "schemas/understudy.executor-submit.v1.schema.json"),
    "utf8",
  ));
  const submitSchema = z.fromJSONSchema(schema);
  const payload = {
    schema_version: "understudy.executor-submit.v1",
    experiment_id: "exp-qwen-verifier",
    candidate: {
      candidate_id: "qwen3p6-base-sft-grpo",
      executor: "fireworks",
      model: "accounts/fireworks/models/qwen3p6-27b",
      policy_ref: "outputs/qwen-serverless-verifier-rl/policy.json",
      policy_sha256: "a".repeat(64),
    },
    attempt: 0,
    workload: {
      id: "automationbench-simple-api-offline-v2",
      dataset_manifest_ref: "outputs/qwen-serverless-verifier-rl/fixture-manifest.json",
      dataset_manifest_sha256: "b".repeat(64),
      verifier_environment: "automationbench-offline-v2",
      verifier_revision: "verifier-v2",
    },
    splits: {
      train_manifest_ref: "outputs/qwen-serverless-verifier-rl/train-manifest.json",
      train_manifest_sha256: "c".repeat(64),
      dev_manifest_ref: "outputs/qwen-serverless-verifier-rl/dev-manifest.json",
      dev_manifest_sha256: "d".repeat(64),
    },
    limits: {
      budget_usd: 45,
      max_concurrent_candidates: 1,
      max_concurrent_requests_per_candidate: 1,
      max_rollouts: 128,
      max_runtime_seconds: 604800,
    },
  };
  assert.equal(submitSchema.safeParse(payload).success, true);
  assert.equal(JSON.stringify(payload).toLowerCase().includes("holdout"), false);
  assert.equal(submitSchema.safeParse({ ...payload, idempotency_key: "extra" }).success, false);
  assert.equal(submitSchema.safeParse({
    ...payload,
    splits: { ...payload.splits, holdout_manifest_ref: "forbidden" },
  }).success, false);
});

test("Python submit builder and executor outputs conform to the TypeScript contract without provider calls", (t) => {
  if (!existsSync("/usr/bin/python3") && !existsSync("/bin/python3")) {
    t.skip("python3 unavailable; skipping executor contract smoke");
    return;
  }
  const python = `
import importlib.util, json, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("verifier_rl", "experiments/qwen-serverless-verifier-rl/verifier_rl.py")
module = importlib.util.module_from_spec(spec)
sys.modules["verifier_rl"] = module
spec.loader.exec_module(module)
args = SimpleNamespace(
  policy_ref="outputs/qwen-serverless-verifier-rl/policy.json",
  policy_sha256="a" * 64,
  dataset_manifest_ref="outputs/qwen-serverless-verifier-rl/fixture-manifest.json",
  dataset_manifest_sha256="b" * 64,
  train_manifest_ref="outputs/qwen-serverless-verifier-rl/train-manifest.json",
  train_manifest_sha256="c" * 64,
  dev_manifest_ref="outputs/qwen-serverless-verifier-rl/dev-manifest.json",
  dev_manifest_sha256="d" * 64,
  verifier_environment="automationbench-offline-v2",
  verifier_revision="verifier-v2",
  candidate_id="candidate",
  base_model="accounts/fireworks/models/qwen3p6-27b",
  model_revision=None,
  experiment_id="contract-test",
  workload_id="automationbench-simple-api-offline-v2",
  attempt=0,
  max_usd=45,
  max_concurrent_candidates=1,
  max_concurrent_requests_per_candidate=1,
  max_rollouts=128,
  max_runtime_seconds=604800,
)
print(json.dumps(module.submit_request(args)))
`;
  const payload = JSON.parse(execFileSync("python3", ["-c", python], {
    cwd: root,
    encoding: "utf8",
  }));
  assert.deepEqual(ExperimentSubmitRequestSchema.parse(payload), payload);
  assert.equal(JSON.stringify(payload).toLowerCase().includes("holdout"), false);
  assert.throws(() => ExperimentSubmitRequestSchema.parse({ ...payload, idempotency_key: "extra" }));
});

test("executor cancellation and usage receipts are adapter-scoped without provider calls", (t) => {
  if (!existsSync("/usr/bin/python3") && !existsSync("/bin/python3")) {
    t.skip("python3 unavailable; skipping executor contract smoke");
    return;
  }
  const experimentId = "contract-test";
  const candidateId = "candidate";
  const attempt = "0";
  const key = createHash("sha256").update(`${experimentId}\0${candidateId}\0${attempt}`).digest("hex");
  const mappingDir = join(root, "experiments/qwen-serverless-verifier-rl/artifacts");
  const mappingPath = join(mappingDir, `job-ref-${key}.json`);
  mkdirSync(mappingDir, { recursive: true });
  writeFileSync(mappingPath, JSON.stringify({
    job: {
      executor: "fireworks",
      job_id: "run-contract",
      idempotency_key: key,
      submitted_at: "2026-01-01T00:00:00Z",
    },
    training_session_id: "ts-contract",
    job_status: { state: "queued", observed_at: "2026-01-01T00:00:00Z" },
  }));
  try {
    const persisted = JSON.parse(readFileSync(mappingPath, "utf8"));
    assert.deepEqual(ExecutorJobRefSchema.parse(persisted.job), persisted.job);
    const cancel = execFileSync("python3", [
      "experiments/qwen-serverless-verifier-rl/verifier_rl.py",
      "--operation", "cancel",
      "--experiment-id", experimentId,
      "--candidate-id", candidateId,
      "--attempt", attempt,
    ], { cwd: root, encoding: "utf8" });
    const cancelled = JSON.parse(cancel);
    assert.deepEqual(ExecutorCancellationReceiptSchema.parse(cancelled), cancelled);
    assert.equal(cancelled.disposition, "already_terminal");
    const cancellationMapping = JSON.parse(readFileSync(mappingPath, "utf8"));
    assert.equal(cancellationMapping.cancellation_adapter.adapter, "fireworks");
    assert.equal(cancellationMapping.cancellation_adapter.adapter_invoked, true);
    const inspected = execFileSync("python3", [
      "experiments/qwen-serverless-verifier-rl/verifier_rl.py",
      "--operation", "inspect",
      "--experiment-id", experimentId,
      "--candidate-id", candidateId,
      "--attempt", attempt,
    ], { cwd: root, encoding: "utf8" });
    const status = JSON.parse(inspected);
    assert.deepEqual(ExecutorJobStatusSchema.parse(status), status);
    const usage = execFileSync("python3", [
      "experiments/qwen-serverless-verifier-rl/verifier_rl.py",
      "--operation", "reconcileUsage",
      "--experiment-id", experimentId,
      "--candidate-id", candidateId,
      "--attempt", attempt,
    ], { cwd: root, encoding: "utf8" });
    const usageReceipt = JSON.parse(usage);
    assert.deepEqual(ExecutorUsageReceiptSchema.parse(usageReceipt), usageReceipt);
    assert.equal(usageReceipt.evidence_scope, "run_exclusive");
    assert.equal(usageReceipt.actual_usd, null);
    assert.equal(usageReceipt.estimated_usd, null);
    assert.equal(usageReceipt.upper_bound_usd, 0);
  } finally {
    rmSync(mappingPath, { force: true });
  }
});
