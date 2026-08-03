import test from "node:test";
import assert from "node:assert/strict";
import { observedRenderFingerprint, preflightServingParity, scoreServingParity } from "../dist/serving-parity/index.js";

const rows = (n = 20, offset = 0) => Array.from({ length: n }, (_, i) => ({ schema_version: "understudy.eval_result.v1", task_id: `t${i}`, score: .5 + offset }));
const lane = (name, offset = 0) => ({ lane: name, artifact_ref: `local://${name}`, artifact_sha256: "a".repeat(64), contract_fingerprint: "c".repeat(64), rendered_prompt_fingerprint: observedRenderFingerprint("same rendered prompt"), protocol_id: "nemotron-text", sampling: { temperature: 0, top_p: null, max_tokens: 512, seed: null }, stop_sequences: [], rows: rows(20, offset), parse_ok: true });

test("requires observed render evidence and a meaningful paired sample", () => {
  const weak = { ...lane("vllm"), rendered_prompt_fingerprint: "" , rows: rows(3) };
  const result = preflightServingParity([lane("tinker"), weak]);
  assert.equal(result.passed, false);
  assert.ok(result.diagnostics.some((d) => d.includes("render fingerprint")));
  assert.ok(result.diagnostics.some((d) => d.includes("paired sample")));
  assert.equal(result.evidence_status, "failed");
});

test("requires matching contract, protocol, stops, and paired task ids", () => {
  const changed = { ...lane("vllm"), contract_fingerprint: "d".repeat(64), protocol_id: "other", stop_sequences: ["STOP"], rows: rows(20).map((row, i) => ({ ...row, task_id: `other-${i}` })) };
  const result = preflightServingParity([lane("tinker"), changed]);
  assert.equal(result.passed, false);
  assert.match(result.diagnostics.join(" "), /contract fingerprint deviation/);
  assert.match(result.diagnostics.join(" "), /protocol deviation/);
  assert.match(result.diagnostics.join(" "), /stop sequence deviation/);
  assert.match(result.diagnostics.join(" "), /paired sample 0/);
});

test("emits hash/ref-only promotion-compatible parity", () => {
  const result = scoreServingParity([lane("tinker"), lane("vllm")]);
  assert.equal(result.passed, true);
  assert.equal(result.promotion_receipt_schema, "understudy.promotion_receipt.v1");
  assert.equal(result.evidence_status, "observed");
  assert.deepEqual(result.refs.map((r) => Object.keys(r).sort()), [["ref", "sha256"], ["ref", "sha256"]]);
  assert.equal(Object.hasOwn(result, "prompt"), false);
});

test("rejects duplicate task ids and invalid thresholds", () => {
  const duplicate = { ...lane("vllm"), rows: [rows(20)[0], ...rows(20)] };
  assert.equal(preflightServingParity([lane("tinker"), duplicate]).passed, false);
  assert.throws(() => preflightServingParity([lane("tinker"), lane("vllm")], { minimumPairedSample: 1 }), /minimum paired sample/);
  assert.throws(() => scoreServingParity([lane("tinker"), lane("vllm")], { equivalenceBand: 2 }), /equivalence band/);
});
