import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = resolve("scripts/wl-on-event-meeting-orchestrator/emit-candidate-payload.mjs");
const SCHEMA = JSON.parse(readFileSync(
  "src/workloads/on-event-meeting-orchestrator/experiment-executor-submit-request.json",
  "utf8",
));

function emit(dir, attempt = 0) {
  const pairs = join(dir, "normalized.jsonl");
  const receipt = join(dir, "train-receipt.json");
  const manifest = join(dir, "freeze.json");
  writeFileSync(pairs, '{"task_id":"synthetic","tier":"exact"}\n');
  writeFileSync(receipt, JSON.stringify({ run_id: "synthetic-train" }));
  writeFileSync(manifest, JSON.stringify({ fixture_id: "meeting-orchestrator-shapes-offline-v1" }));
  const out = join(dir, `payload-${attempt}.json`);
  const receiptOut = join(dir, `receipt-${attempt}.json`);
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--experiment-id", "wl-meeting-experiment",
    "--candidate-id", "nemotron-base-tuned",
    "--model-revision", "tinker://checkpoint/synthetic",
    "--normalized-pairs", pairs,
    "--train-receipt", receipt,
    "--dataset-manifest", manifest,
    "--attempt", String(attempt),
    "--out", out,
    "--receipt", receiptOut,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return {
    payload: JSON.parse(readFileSync(out, "utf8")),
    receipt: JSON.parse(readFileSync(receiptOut, "utf8")),
  };
}

describe("executor-submit candidate payload", () => {
  it("validates against the vendored schema and excludes holdout metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-meeting-payload-"));
    const { payload, receipt } = emit(dir);
    const validate = new Ajv2020({ strict: false }).compile(SCHEMA);
    assert.equal(validate(payload), true, JSON.stringify(validate.errors));
    assert.equal(payload.candidate.executor, "fixture");
    assert.equal(payload.workload.id, "on-event-meeting-orchestrator");
    assert.equal(payload.workload.verifier_environment, "meeting-orchestrator-shapes-offline-v1");
    assert.deepEqual(Object.keys(payload.splits).sort(), ["dev_manifest_ref", "train_manifest_ref"]);
    assert.doesNotMatch(JSON.stringify(payload).toLowerCase(), /holdout/);
    assert.match(receipt.idempotency_key, /^[a-f0-9]{64}$/);
  });

  it("derives stable idempotency and policy hashes without provider calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-meeting-payload-"));
    const first = emit(dir, 2);
    const second = emit(dir, 2);
    assert.equal(first.receipt.idempotency_key, second.receipt.idempotency_key);
    assert.equal(first.payload.candidate.policy_sha256, second.payload.candidate.policy_sha256);
    assert.equal(first.receipt.payload_sha256, second.receipt.payload_sha256);
    assert.doesNotMatch(readFileSync(SCRIPT, "utf8"), /\bfetch\s*\(/);
  });

  it("changes idempotency when the attempt changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-meeting-payload-"));
    assert.notEqual(emit(dir, 0).receipt.idempotency_key, emit(dir, 1).receipt.idempotency_key);
  });
});
