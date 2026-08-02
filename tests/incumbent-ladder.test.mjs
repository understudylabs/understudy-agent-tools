import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildEvidenceRow,
  buildPromotionDecision,
  buildSaturationCertificate,
  buildSubmitPayload,
  idempotencyKey,
  scoreTask,
} from "../dist/incumbent-ladder/index.js";

const HASH = "a".repeat(64);
const task = (calls) => ({ task_id: "t-1", band: "playbook", label: { calls } });
const call = (tool, argumentsValue = {}) => ({ tool, arguments: argumentsValue });

test("verifier handles native calls, rendered preambles, missing and extra calls", () => {
  const expected = task([call("run-subagent", { subagentPath: "ops/triage", documentId: "d1" })]);
  assert.equal(scoreTask(expected, { response: { tool_calls: [{ function: { name: "run-subagent", arguments: JSON.stringify({ subagentPath: "ops/triage", documentId: "d1" }) } }] } }).score, 1);
  assert.equal(scoreTask(expected, { response: "thinking...\n<tool_call>{\"tool\":\"run-subagent\",\"arguments\":{\"subagentPath\":\"ops/triage\",\"documentId\":\"d1\"}}</tool_call>" }).score, 1);
  assert.equal(scoreTask(expected, { response: "no call" }).malformed, 1);
  assert.equal(scoreTask(expected, { response: "<tool_call>{\"tool\":\"run-subagent\",\"arguments\":{}}</tool_call><tool_call>{\"tool\":\"run-subagent\",\"arguments\":{}}</tool_call>" }).calls_emitted, 2);
  assert.equal(scoreTask(task([call("a"), call("b")]), { response: "<tool_call>{\"tool\":\"b\"}</tool_call><tool_call>{\"tool\":\"a\"}</tool_call>" }).tool_set, 1);
  assert.equal(scoreTask(expected, { response: "<tool_call>{\"tool\":\"run-subagent\",\"arguments\":{\"subagentPath\":\"wrong\",\"documentId\":\"d1\"}}</tool_call>" }).arg_score, 0.5);
});

test("saturation gate distinguishes usable and saturated incumbents", () => {
  const base = { fixture_sha256: HASH, incumbent: { mean_score: 0.75, exact_match_rate: 0.75, by_band: {} } };
  assert.equal(buildSaturationCertificate(base).usable, true);
  assert.equal(buildSaturationCertificate({ ...base, incumbent: { ...base.incumbent, mean_score: 0.95 } }).usable, false);
});

function submitInput() {
  return {
    experiment_id: "exp-1",
    candidate: {
      candidate_id: "candidate-1",
      executor: "fixture",
      model: "model-1",
      policy_ref: "artifact://policy",
      policy_sha256: HASH,
    },
    attempt: 0,
    workload: { id: "workload-1", dataset_manifest_ref: "artifact://manifest", dataset_manifest_sha256: HASH, verifier_environment: "offline", verifier_revision: "v1" },
    splits: { train_manifest_ref: "artifact://train", train_manifest_sha256: HASH, dev_manifest_ref: "artifact://dev", dev_manifest_sha256: HASH },
    limits: { budget_usd: 10, max_concurrent_candidates: 1, max_concurrent_requests_per_candidate: 1, max_rollouts: 10, max_runtime_seconds: 60 },
  };
}

test("submit payload is schema-compatible, hash-only, and idempotent", () => {
  const payload = buildSubmitPayload(submitInput());
  const schema = JSON.parse(readFileSync("schemas/understudy.executor-submit.v1.schema.json", "utf8"));
  assert.equal(payload.schema_version, schema.properties.schema_version.const);
  assert.equal(idempotencyKey(submitInput()), idempotencyKey(submitInput()));
  assert.notEqual(idempotencyKey(submitInput()), idempotencyKey({ ...submitInput(), attempt: 1 }));
  assert.throws(() => buildSubmitPayload({ ...submitInput(), holdout: { ref: "artifact://holdout", sha256: HASH } }), /holdout/);
  assert.throws(() => buildSubmitPayload({ ...submitInput(), candidate: { ...submitInput().candidate, secret: "x" } }), /Unrecognized key|unknown/i);
  assert.throws(() => buildSubmitPayload({ ...submitInput(), workload: { ...submitInput().workload, prompt: "raw" } }), /raw material|prompt/i);
});

test("evidence and promotion decision preserve dev-only boundary", () => {
  const saturation = buildSaturationCertificate({ fixture_sha256: HASH, incumbent: { mean_score: 0.75, exact_match_rate: 0.75, by_band: {} } });
  const aggregate = { count: 1, mean_score: 0.5, exact_match_rate: 0, tool_set_f1: 0.5, ordered_tool_set_agreement: 1, arg_score: 0.5, no_action_agreement: 0, malformed_rate: 0, calls_emitted: 1, calls_emitted_distribution: { "1": 1 }, mean_latency_ms: 10, input_tokens: 5, output_tokens: 2, cost: { status: "unpriced", total_usd: null, per_1k_calls_usd: null } };
  const evidence = buildEvidenceRow({
    experiment_id: "exp-1",
    workload: { id: "workload-1", description: "synthetic event routing", fixture_sha256: HASH },
    incumbent: { provider: "frontier", model: "incumbent", serving_contract: "native-tools" },
    candidates: [{ arm_id: "base", base_model: "open-model", renderer: "renderer", rung: "baseline", lora_rank: null, steps: null, seed: 1, split_refs: { train: "train", dev: "dev", holdout: "sealed" }, split_hashes: { train: HASH, dev: HASH, holdout: HASH }, by_band: { all: aggregate }, aggregate, unpriced: true, artifact_refs: ["artifact://evidence"], failure_clusters: ["malformed protocol"] }],
    holdout: { status: "clean", sha256: HASH },
    saturation,
    evidence_scope: "dev-only",
    claim_boundary: "This is a dev-only optimization lead; holdout remains unexecuted.",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(evidence.schema_version, "understudy.ladder_evidence.v1");
  assert.equal(evidence.holdout.status, "clean");
  assert.equal(evidence.candidates[0].unpriced, true);
  assert.equal(buildPromotionDecision({ workload_id: "workload-1", evidence_ref: "artifact://evidence", evidence_sha256: HASH, incumbent_model: "incumbent", candidate_model: "candidate", candidate_score: 0.5, incumbent_score: 0.75, claim_boundary: evidence.claim_boundary }).schema_version, "understudy.route_decision_packet.v1");
});
