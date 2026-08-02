import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildResult,
  buildSubmitPayload,
  loadContract,
  validate,
} from "../experiments/workload-automation/scripts/emit-contract-artifacts.mjs";

const ARM = "experiments/workload-automation";

const submitFixture = () => ({
  experimentId: "wl-au-near-hit-dpo",
  attempt: 0,
  candidate: {
    candidate_id: "nemotron3-nano-near-hit-dpo",
    executor: "fixture",
    model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
    policy_ref: `file://${ARM}/candidate-policy.json`,
    policy_sha256: "a".repeat(64),
  },
  workload: {
    id: "WL-AU",
    dataset_manifest_ref: `file://${ARM}/gate-validation.json`,
    dataset_manifest_sha256: "b".repeat(64),
    verifier_environment: "automationbench-simple-api-offline-v2",
    verifier_revision: "918023a1c2f342ea33e99251ff1f2e5f489c9c4f24e5412a774d97ec2d36cd22",
  },
  splits: {
    train_manifest_ref: `file://${ARM}/pairs.manifest.json`,
    train_manifest_sha256: "c".repeat(64),
    dev_manifest_ref: `file://${ARM}/dev.manifest.json`,
    dev_manifest_sha256: "d".repeat(64),
  },
  limits: {
    budget_usd: 0,
    max_concurrent_candidates: 1,
    max_concurrent_requests_per_candidate: 64,
    max_rollouts: 2000,
    max_runtime_seconds: 43200,
  },
});

test("the vendored submit contract is the sealed orchestration schema, unmodified", () => {
  const bytes = readFileSync(`${ARM}/contracts/experiment-executor-submit-request.json`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "6ff8cfa383ff109d7dfe341e5ae2a4d330a8b298b0e8af51af0f1d3106f462c0",
    "vendored schema drifted from the pinned contract at c299ca4",
  );
  const schema = JSON.parse(bytes.toString());
  assert.equal(schema.properties.schema_version.const, "understudy.executor-submit.v1");
});

test("the submit contract has no field that could carry the holdout", () => {
  const schema = loadContract("experiment-executor-submit-request");
  assert.ok(!JSON.stringify(schema.properties.splits).includes("holdout"));
  assert.equal(schema.properties.splits.additionalProperties, false);
});

test("a well-formed candidate payload validates", () => {
  const payload = buildSubmitPayload(submitFixture());
  assert.equal(payload.schema_version, "understudy.executor-submit.v1");
  assert.equal(validate(loadContract("experiment-executor-submit-request"), payload).length, 0);
});

test("a payload that smuggles the holdout in is refused", () => {
  const input = submitFixture();
  input.splits.holdout_manifest_ref = `file://${ARM}/holdout.manifest.json`;
  assert.throws(() => buildSubmitPayload(input), /structurally absent/);
});

test("divergent fields and unknown executors are refused, not coerced", () => {
  const withExtra = submitFixture();
  withExtra.candidate.tinker_service_id = "svc_1";
  assert.throws(() => buildSubmitPayload(withExtra), /unexpected property tinker_service_id/);

  const withTinker = submitFixture();
  withTinker.candidate.executor = "tinker";
  assert.throws(() => buildSubmitPayload(withTinker), /is not one of modal\|wafer\|fireworks\|spark\|fixture/);
});

test("raw content in a ref position is refused by the length and pattern bounds", () => {
  const inlined = submitFixture();
  inlined.candidate.policy_sha256 = "not-a-hash";
  assert.throws(() => buildSubmitPayload(inlined), /does not match/);
});

test("the arm's result record validates and states its holdout posture", () => {
  const lift = JSON.parse(readFileSync(`${ARM}/dpo-lift.json`, "utf8"));
  const result = buildResult(lift.result);
  assert.equal(result.schema_version, "understudy.experiment-result.v1");
  assert.equal(result.state, "holdout_locked");
  assert.equal(result.holdout_executed, true);
  assert.equal(result.holdout_clean, false);
  assert.ok(result.claim_boundary.length > 0);
});

test("the result record does not claim a lift the interval does not support", () => {
  const lift = JSON.parse(readFileSync(`${ARM}/dpo-lift.json`, "utf8"));
  assert.equal(lift.dev_sampled.significant, false);
  const [low, high] = lift.dev_sampled.paired_delta_ci95;
  assert.ok(low < 0 && high > 0, "interval must straddle zero for the null verdict to be honest");
  assert.equal(lift.result.quality_evidence.status, "measured");
  assert.ok(lift.result.quality_evidence.required_calibration.length > 0);
});

test("the committed arm artifacts carry no private term or customer identifier", () => {
  const files = [
    "README.md",
    "repair-memo.md",
    "aggregates.json",
    "dpo-lift.json",
    "gate-validation.json",
    "candidate-policy.json",
    "workflow-contract.md",
  ];
  const privateTerm = new RegExp(String.fromCharCode(67, 101, 100, 97, 114), "i");
  const banned = [privateTerm, /\bproj_[0-9a-f]{10,}\b/, /\borg_[0-9A-Za-z]{10,}\b/, /\bsk-[0-9A-Za-z]{16,}\b/];
  for (const file of files) {
    const text = readFileSync(`${ARM}/${file}`, "utf8");
    for (const pattern of banned) assert.ok(!pattern.test(text), `${file} matches ${pattern}`);
  }
});
