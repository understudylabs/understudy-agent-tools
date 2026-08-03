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
  assert.ok(result.diagnostics.some((d) => d.includes("minimum paired sample")));
});

test("emits hash/ref-only promotion-compatible parity", () => {
  const result = scoreServingParity([lane("tinker"), lane("vllm")]);
  assert.equal(result.passed, true);
  assert.equal(result.promotion_receipt_schema, "understudy.promotion_receipt.v1");
  assert.equal(result.evidence_status, "observed");
  assert.deepEqual(result.refs.map((r) => Object.keys(r).sort()), [["ref", "sha256"], ["ref", "sha256"]]);
  assert.equal(Object.hasOwn(result, "prompt"), false);
});
