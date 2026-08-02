import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCHEMA = JSON.parse(
  readFileSync(new URL("../schemas/understudy.executor-submit.v1.schema.json", import.meta.url), "utf8"),
);

/**
 * Draft-2020-12 subset validator covering exactly the keywords this contract
 * uses. It is deliberately strict: an unknown keyword throws rather than being
 * ignored, so the test cannot silently stop checking when the schema grows.
 */
function validate(schema, value, path = "$") {
  const errors = [];
  const known = new Set([
    "$schema", "$id", "type", "const", "enum", "properties", "required",
    "additionalProperties", "pattern", "minLength", "maxLength", "minimum", "maximum",
  ]);
  for (const keyword of Object.keys(schema)) {
    if (!known.has(keyword)) throw new Error(`${path}: unhandled schema keyword ${keyword}`);
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [`${path}: expected object`];
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) errors.push(`${path}.${key}: additional property`);
      }
    }
    for (const [key, subschema] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validate(subschema, value[key], `${path}.${key}`));
    }
    return errors;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return [`${path}: expected string`];
    if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected ${schema.const}`);
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not in enum`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long`);
    return errors;
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number") return [`${path}: expected number`];
    if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`${path}: expected integer`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
    return errors;
  }
  throw new Error(`${path}: unhandled schema type ${schema.type}`);
}

const RECEIPT = {
  base_model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
  renderer: "nemotron3",
  checkpoint: "tinker://00000000-0000-0000-0000-000000000000:train:0/sampler_weights/final",
  pairs_sha256: "a".repeat(64),
  hyperparameters: { lora_rank: 32, dpo_beta: 0.1, epochs: 3 },
};

function emit(extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), "aop-submit-"));
  const receiptPath = join(dir, "receipt.json");
  const outPath = join(dir, "submit.json");
  writeFileSync(receiptPath, JSON.stringify(RECEIPT));
  execFileSync(
    process.execPath,
    ["scripts/aop-selection-submit-payload.mjs", "--receipt", receiptPath, "--out", outPath, ...extraArgs],
    { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe" },
  );
  return { payload: JSON.parse(readFileSync(outPath, "utf8")), raw: readFileSync(outPath, "utf8") };
}

test("submit payload validates against understudy.executor-submit.v1", () => {
  const { payload } = emit();
  assert.deepEqual(validate(SCHEMA, payload), []);
});

test("submit payload carries refs and hashes, never holdout or raw material", () => {
  const { payload, raw } = emit();
  assert.equal(payload.workload.dataset_manifest_sha256.length, 64);
  assert.match(payload.candidate.policy_ref, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(payload.splits).sort(), [
    "dev_manifest_ref",
    "dev_manifest_sha256",
    "train_manifest_ref",
    "train_manifest_sha256",
  ]);
  assert.doesNotMatch(raw, /holdout/i);
  assert.doesNotMatch(raw, /prompt|completion|message|api[_-]?key|token/i);
});

test("resubmitting the same attempt reproduces byte-identical payload bytes", () => {
  assert.equal(emit().raw, emit().raw);
  assert.notEqual(emit().raw, emit(["--attempt", "1"]).raw);
});
