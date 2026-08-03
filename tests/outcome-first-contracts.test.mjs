import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const NOW = "2026-08-03T00:00:00.000Z";

function loadSchema(name) {
  return JSON.parse(fs.readFileSync(path.resolve("schemas", name), "utf8"));
}

// Repository tests intentionally avoid a validator dependency. This focused
// draft-2020-12 subset covers every keyword used by these four contracts,
// including conditional promotion/calibration gates.
function makeValidator(root) {
  function resolve(schema) {
    if (!schema || typeof schema !== "object" || typeof schema.$ref !== "string") return schema;
    let node = root;
    for (const part of schema.$ref.replace(/^#\//, "").split("/")) node = node?.[part];
    return node ?? {};
  }

  function errors(schemaIn, value, at = "$") {
    const schema = resolve(schemaIn);
    const out = [];
    if (!schema || typeof schema !== "object") return out;

    if (schema.allOf) for (const branch of schema.allOf) out.push(...errors(branch, value, at));
    if (schema.anyOf && !schema.anyOf.some((branch) => errors(branch, value, at).length === 0)) out.push(`${at}: no anyOf branch matched`);
    if (schema.if && errors(schema.if, value, at).length === 0 && schema.then) out.push(...errors(schema.then, value, at));
    if (Object.hasOwn(schema, "const") && value !== schema.const) out.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: not in enum`);

    const types = schema.type == null ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types && value !== undefined) {
      const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
      if (!types.some((type) => type === actual || (type === "number" && actual === "integer"))) out.push(`${at}: expected ${types.join("|")}, got ${actual}`);
    }
    if (typeof value === "string") {
      if (schema.minLength != null && value.length < schema.minLength) out.push(`${at}: shorter than ${schema.minLength}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${at}: pattern mismatch`);
    }
    if (typeof value === "number") {
      if (schema.minimum != null && value < schema.minimum) out.push(`${at}: below minimum`);
      if (schema.maximum != null && value > schema.maximum) out.push(`${at}: above maximum`);
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) out.push(`${at}.${key}: required`);
      for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) out.push(...errors(child, value[key], `${at}.${key}`));
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties ?? {}, key)) out.push(`${at}.${key}: additional property`);
      }
    }
    if (Array.isArray(value)) {
      if (schema.minItems != null && value.length < schema.minItems) out.push(`${at}: fewer than ${schema.minItems} items`);
      if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) out.push(`${at}: duplicate items`);
      if (schema.items) value.forEach((item, index) => out.push(...errors(schema.items, item, `${at}[${index}]`)));
    }
    return out;
  }
  return (value) => errors(root, value);
}

const sourceValidate = makeValidator(loadSchema("understudy.source_binding.v1.schema.json"));
const verifierValidate = makeValidator(loadSchema("understudy.verifier_calibration.v1.schema.json"));
const vizValidate = makeValidator(loadSchema("understudy.gepa_viz_manifest.v1.schema.json"));
const promotionValidate = makeValidator(loadSchema("understudy.promotion_receipt.v1.schema.json"));

function unknownSource() {
  return { schema_version: "understudy.source_binding.v1", binding_id: "bind-1", workload_id: "wl", state: "unknown", source_id: null, source_sha256: null, fixture_sha256: null, artifact_refs: [], created_at: NOW };
}

function unknownCalibration() {
  return {
    schema_version: "understudy.verifier_calibration.v1", calibration_id: "cal-1", workload_id: "wl", status: "unknown",
    source_binding_sha256: null, fixture_sha256: null, verifier_sha256: null,
    oracle: { score: null, passed: null }, sentinel: { score: null, passed: null },
    replay: { executed: null, passed: null, trajectory_count: null },
    malformed_semantics: { malformed_total_distinct_from_consecutive: null, passed: null }, artifact_refs: [], created_at: NOW,
  };
}

function viz(state = "pending") {
  return {
    schema_version: "understudy.gepa_viz_manifest.v1", run_id: "run-1", workload_id: "wl", state,
    source_binding_sha256: null, verifier_calibration_sha256: null,
    splits: { train_sha256: null, dev_sha256: null, holdout_sha256: null },
    progress: { wave: null, candidates_started: 0, candidates_completed: 0, candidates_failed: 0, rollouts_completed: 0, rollouts_total: null },
    incumbent: { candidate_id: null, candidate_sha256: null, dev_quality: null },
    cost: { actual_usd: null, budget_usd: null, basis: null },
    latency: { elapsed_ms: null, p50_ms: null, p95_ms: null, basis: null }, artifact_refs: [], updated_at: NOW,
  };
}

function receipt(decision = "insufficient_evidence") {
  return {
    schema_version: "understudy.promotion_receipt.v1", receipt_id: "receipt-1", run_id: "run-1", workload_id: "wl", decision,
    evidence_scope: "unknown", source_binding_sha256: null, verifier_calibration_sha256: null,
    splits: { train_sha256: null, dev_sha256: null, holdout_sha256: null },
    holdout: { status: "unknown", sha256: null, executed_at: null, receipt_ref: null },
    baseline: { run_id: null, quality: null, passed: null, artifact_ref: null },
    optimized: { run_id: null, quality: null, passed: null, artifact_ref: null },
    serving_parity: { passed: null, receipt_ref: null },
    cost: { actual_usd: null, budget_usd: null, basis: null },
    latency: { p50_ms: null, p95_ms: null, basis: null },
    compiled_policy_ref: null, claim_boundary: "Dev-only; no promotion evidence.", demotion_trigger: null,
    artifact_refs: [], created_at: NOW,
  };
}

describe("understudy.source_binding.v1", () => {
  it("represents unknown provenance explicitly and requires hashes before bound", () => {
    assert.deepEqual(sourceValidate(unknownSource()), []);
    const bound = { ...unknownSource(), state: "bound", source_id: "r2://capture/7", source_sha256: SHA_A, fixture_sha256: SHA_B, artifact_refs: ["artifacts/source-binding.json"] };
    assert.deepEqual(sourceValidate(bound), []);
    assert.ok(sourceValidate({ ...bound, fixture_sha256: null }).some((error) => error.includes("fixture_sha256")));
  });
});

describe("understudy.verifier_calibration.v1", () => {
  it("allows unknown probes but passes only exact oracle/sentinel/replay semantics", () => {
    assert.deepEqual(verifierValidate(unknownCalibration()), []);
    const passed = {
      ...unknownCalibration(), status: "passed", source_binding_sha256: SHA_A, fixture_sha256: SHA_B, verifier_sha256: SHA_C,
      oracle: { score: 1, passed: true }, sentinel: { score: 0, passed: true },
      replay: { executed: true, passed: true, trajectory_count: 23 },
      malformed_semantics: { malformed_total_distinct_from_consecutive: true, passed: true }, artifact_refs: ["receipts/calibration.json"],
    };
    assert.deepEqual(verifierValidate(passed), []);
    assert.ok(verifierValidate({ ...passed, sentinel: { score: 0.1, passed: true } }).some((error) => error.includes("sentinel.score")));
    assert.ok(verifierValidate({ ...passed, replay: { executed: false, passed: true, trajectory_count: 23 } }).some((error) => error.includes("replay.executed")));
  });
});

describe("understudy.gepa_viz_manifest.v1", () => {
  it("keeps pending unknowns nullable but requires provenance and train/dev hashes while live", () => {
    assert.deepEqual(vizValidate(viz()), []);
    const running = viz("running");
    assert.ok(vizValidate(running).some((error) => error.includes("source_binding_sha256")));
    Object.assign(running, { source_binding_sha256: SHA_A, verifier_calibration_sha256: SHA_B, artifact_refs: ["viz/run-1.json"] });
    running.splits = { train_sha256: SHA_A, dev_sha256: SHA_B, holdout_sha256: null };
    assert.deepEqual(vizValidate(running), []);
  });
});

describe("understudy.promotion_receipt.v1", () => {
  it("records dev-only and historical evidence without allowing promotion", () => {
    const devOnly = receipt();
    devOnly.evidence_scope = "dev_only";
    devOnly.holdout.status = "not_executed";
    assert.deepEqual(promotionValidate(devOnly), []);

    const invalid = { ...devOnly, decision: "promoted" };
    assert.ok(promotionValidate(invalid).some((error) => error.includes("evidence_scope")));

    const historical = receipt("promoted");
    historical.evidence_scope = "historical_holdout";
    historical.holdout = { status: "historical_observed", sha256: SHA_C, executed_at: NOW, receipt_ref: "receipts/old.json" };
    assert.ok(promotionValidate(historical).some((error) => error.includes("evidence_scope")));
  });

  it("accepts promotion only with fresh hash-bound holdout, parity, policy, and receipts", () => {
    const promoted = receipt("promoted");
    Object.assign(promoted, {
      evidence_scope: "fresh_holdout", source_binding_sha256: SHA_A, verifier_calibration_sha256: SHA_B,
      splits: { train_sha256: SHA_A, dev_sha256: SHA_B, holdout_sha256: SHA_C },
      holdout: { status: "executed_fresh", sha256: SHA_C, executed_at: NOW, receipt_ref: "receipts/holdout.json" },
      baseline: { run_id: "base", quality: 0.85, passed: true, artifact_ref: "receipts/base.json" },
      optimized: { run_id: "opt", quality: 1, passed: true, artifact_ref: "receipts/opt.json" },
      serving_parity: { passed: true, receipt_ref: "receipts/parity.json" },
      cost: { actual_usd: 12.34, budget_usd: 100, basis: "gateway-metered" },
      latency: { p50_ms: 120, p95_ms: 350, basis: "canonical-serving-receipt" },
      compiled_policy_ref: "policies/winner.json", claim_boundary: "Fresh holdout for workload wl only.",
      demotion_trigger: "Demote on verifier or serving-parity regression.", artifact_refs: ["receipts/promotion.json"],
    });
    assert.deepEqual(promotionValidate(promoted), []);
    assert.ok(promotionValidate({ ...promoted, serving_parity: { passed: null, receipt_ref: null } }).some((error) => error.includes("serving_parity")));
  });

  it("rejects inline prompt/private payload fields in every contract", () => {
    for (const [validate, row] of [[sourceValidate, unknownSource()], [verifierValidate, unknownCalibration()], [vizValidate, viz()], [promotionValidate, receipt()]]) {
      assert.ok(validate({ ...row, prompt: "private" }).some((error) => error.includes("prompt: additional property")));
    }
  });
});
