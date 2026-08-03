import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTrustGate, TRUST_GATE } from "../dist/verifier-trust/index.js";
const binding = { source_binding_sha256: "a".repeat(64), verifier_sha256: "b".repeat(64), fixture_sha256: "c".repeat(64) };
const arm = (probes) => ({ probes, false_positive_rate: 0, false_negative_rate: 0, mcc: 1, reward_hacked_probes: 0 });
test("requires both arms and binds the receipt", () => { const r = evaluateTrustGate(binding, arm(8), arm(24)); assert.equal(r.verdict, "trusted"); assert.equal(r.source_binding_sha256, binding.source_binding_sha256); assert.equal(r.schema_version, "understudy.verifier_trust.v1"); });
test("natural evidence is mandatory and adversarial failure is never trusted", () => { assert.equal(evaluateTrustGate(binding, arm(7), arm(24)).verdict, "insufficient-evidence"); assert.equal(evaluateTrustGate(binding, arm(8), { ...arm(24), reward_hacked_probes: 1 }).verdict, "untrusted"); });
test("provenance is required", () => { const r = evaluateTrustGate({ ...binding, verifier_sha256: "" }, arm(8), arm(24)); assert.equal(r.verdict, "untrusted"); assert.match(r.reasons.join(" "), /provenance/); });
assert.equal(TRUST_GATE.max_false_positive_rate, 0);
