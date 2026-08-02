import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ARM_EVIDENCE_REQUIRED_FIELDS,
  ARM_EVIDENCE_SCHEMA_VERSION,
  assertArmEntryGate,
  buildArmEvidenceRow,
  runArmEntryGate,
  summarizeBands,
  validateArmEvidenceRow,
} from "../dist/arm-evidence/index.js";

const schema = JSON.parse(readFileSync("schemas/understudy.arm_evidence.v1.schema.json", "utf8"));
const HASH = "a".repeat(64);

function holdoutProbe({ acceptNoHash = false, acceptWrongHash = false } = {}) {
  return {
    expectedSha256: HASH,
    open(hash) {
      if (!hash && acceptNoHash) return [];
      if (hash !== HASH && !acceptWrongHash) throw new Error("hash required");
      return [];
    },
  };
}

async function gate(overrides = {}) {
  return runArmEntryGate({
    sanityTaskIds: ["sanity-a", "sanity-b"],
    oracle: async () => 1,
    sentinel: async () => 0,
    holdout: holdoutProbe(),
    ...overrides,
  });
}

function goodRow(gateResult) {
  return buildArmEvidenceRow({
    arm_id: "arm-a",
    run_id: "run-a",
    created_at: "2026-08-02T00:00:00.000Z",
    base_model_id: "model-a",
    renderer: "native",
    provider: "local",
    route: "offline",
    training: { lora_rank: null, steps: null },
    dataset: { seed: 7, sha256: HASH },
    holdout: { split: "holdout", sealed_sha256: HASH },
    cost: { usd: null, basis: "local-zero-marginal-cost" },
    entryGate: gateResult,
    evalRows: [
      { schema_version: "understudy.eval_result.v1", task_id: "a", score: 1 },
      { schema_version: "understudy.eval_result.v1", task_id: "b", score: 0.5 },
      { schema_version: "understudy.eval_result.v1", task_id: "c", score: null },
    ],
    bandOf: (row) => row.task_id === "a" ? "easy" : "hard",
  });
}

test("entry gate passes exact oracle/sentinel and holdout checks", async () => {
  const result = await gate();
  assert.equal(result.passed, true);
  assert.equal(result.oracle_mean, 1);
  assert.equal(result.sentinel_max, 0);
  assert.ok(result.checks.every((check) => check.status === "pass"));
});

test("entry gate fails when an oracle sanity task is below one", async () => {
  const result = await gate({ oracle: async (taskId) => taskId === "sanity-a" ? 0.99 : 1 });
  assert.equal(result.passed, false);
  assert.match(result.checks.find((check) => check.id === "oracle:sanity-a").detail, /exactly 1/);
});

test("entry gate fails when a sentinel sanity task is above zero", async () => {
  const result = await gate({ sentinel: async (taskId) => taskId === "sanity-b" ? 0.01 : 0 });
  assert.equal(result.passed, false);
  assert.match(result.checks.find((check) => check.id === "sentinel:sanity-b").detail, /exactly 0/);
});

test("entry gate fails open holdouts and accepts only the exact hash", async () => {
  const noHash = await gate({ holdout: holdoutProbe({ acceptNoHash: true }) });
  assert.equal(noHash.passed, false);
  assert.equal(noHash.checks.find((check) => check.id === "holdout:no-hash").status, "fail");

  const wrongHash = await gate({ holdout: holdoutProbe({ acceptWrongHash: true }) });
  assert.equal(wrongHash.passed, false);
  assert.equal(wrongHash.checks.find((check) => check.id === "holdout:wrong-hash").status, "fail");
});

test("empty sanity list fails and assert variant explains gate failures", async () => {
  const result = await gate({ sanityTaskIds: [] });
  assert.equal(result.passed, false);
  await assert.rejects(() => assertArmEntryGate({
    sanityTaskIds: [],
    oracle: async () => 1,
    sentinel: async () => 0,
    holdout: holdoutProbe(),
  }), /arm entry gate failed/);
});

test("buildArmEvidenceRow refuses a failed gate", () => {
  assert.throws(() => buildArmEvidenceRow({
    arm_id: "arm-a",
    run_id: "run-a",
    created_at: "2026-08-02T00:00:00.000Z",
    base_model_id: "model-a",
    renderer: "native",
    provider: "local",
    dataset: { seed: 7, sha256: HASH },
    holdout: { split: "holdout", sealed_sha256: HASH },
    entryGate: { passed: false, oracle_mean: 0, sentinel_max: 1, sanity_task_ids: [], checks: [] },
  }), /entry gate did not pass/);
});

test("summarizeBands counts rows and averages scored rows", () => {
  assert.deepEqual(summarizeBands([
    { task_id: "a", score: 1 },
    { task_id: "b", score: 0.5 },
    { task_id: "c", score: null },
  ], (row) => row.task_id === "a" ? "easy" : "hard"), {
    easy: { n: 1, mean_score: 1, unscored: 0 },
    hard: { n: 2, mean_score: 0.5, unscored: 1 },
  });
});

test("validator accepts a good row and rejects every required field", async () => {
  const row = goodRow(await gate());
  assert.deepEqual(validateArmEvidenceRow(row), []);
  for (const field of ARM_EVIDENCE_REQUIRED_FIELDS) {
    const missing = { ...row };
    delete missing[field];
    assert.ok(validateArmEvidenceRow(missing).some((issue) => issue.path === `$.${field}`), `missing ${field}`);
  }
});

test("validator required fields stay in parity with the JSON schema", () => {
  assert.deepEqual([...ARM_EVIDENCE_REQUIRED_FIELDS], schema.required);
});
