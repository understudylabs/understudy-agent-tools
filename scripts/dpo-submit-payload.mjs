#!/usr/bin/env node
/**
 * Emit the `understudy.executor-submit.v1` payload for a DPO candidate on the
 * offline fixture, and refuse to emit anything that does not validate against
 * the published schema in `schemas/understudy.executor-submit.v1.schema.json`.
 *
 * This arm is a candidate-method, not a controller: the payload is a pure
 * function of the validated pair artifact, the candidate policy, and the frozen
 * fixture identity. Everything crossing the boundary is a ref plus a sha256 —
 * no pairs, no prompts, no weights, no credentials.
 *
 * The holdout is structurally absent from the contract and stays that way:
 * sealed-holdout scoring happens after training, outside submit, and this
 * script fails if a holdout hash appears anywhere in the payload.
 *
 * Usage:
 *   node scripts/dpo-submit-payload.mjs \
 *     --experiment-id automationbench-v2-dpo-2026-08 \
 *     --candidate-id nemotron3-nano-dpo-r32 \
 *     --executor <modal|wafer|fireworks|spark|fixture> \
 *     --pairs-report outputs/dpo/pairs.validation.json \
 *     --policy outputs/dpo/policy.json \
 *     --attempt 0 --budget-usd 25 --max-rollouts 2000 --max-runtime-seconds 7200 \
 *     --out outputs/dpo/submit.json
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { v2FixtureSha256, v2SplitSha256 } from "../dist/automationbench-v2.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, "..", "schemas", "understudy.executor-submit.v1.schema.json");
const FIXTURE_ID = "automationbench-simple-api-offline-v2";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function argNumber(name, fallback = null) {
  const raw = argValue(name, null);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

/**
 * Minimal draft-2020-12 checker covering the constructs the published contract
 * uses. It exists so the emitter fails closed on a divergent payload rather
 * than shipping one and finding out at the executor boundary.
 */
export function validateAgainstSchema(schema, value, path = "$") {
  const errors = [];
  const type = schema.type;
  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return [`${path}: expected object`];
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, entry] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (!child) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed by the contract`);
        continue;
      }
      errors.push(...validateAgainstSchema(child, entry, `${path}.${key}`));
    }
    return errors;
  }
  if (type === "string") {
    if (typeof value !== "string") return [`${path}: expected string`];
    if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must be ${schema.const}`);
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(", ")}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    return errors;
  }
  if (type === "integer" || type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) return [`${path}: expected ${type}`];
    if (type === "integer" && !Number.isInteger(value)) errors.push(`${path}: expected an integer`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
    return errors;
  }
  return errors;
}

/** Canonical JSON so a policy hash is stable across key order. */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function buildSubmitPayload({
  experimentId,
  candidateId,
  executor,
  model,
  modelRevision,
  policy,
  policyRef,
  pairsReport,
  attempt,
  limits,
}) {
  const trainSha = v2SplitSha256("train");
  const devSha = v2SplitSha256("dev");
  if (pairsReport) {
    if (pairsReport.verdict !== "pass") throw new Error("refusing to submit: the pair gate did not pass");
    if (pairsReport.train_split_sha256 && pairsReport.train_split_sha256 !== trainSha) {
      throw new Error("refusing to submit: the gated pairs were cut against a different train split");
    }
  }
  const payload = {
    schema_version: "understudy.executor-submit.v1",
    experiment_id: experimentId,
    candidate: {
      candidate_id: candidateId,
      executor,
      model,
      ...(modelRevision ? { model_revision: modelRevision } : {}),
      policy_ref: policyRef,
      policy_sha256: createHash("sha256").update(canonicalize(policy)).digest("hex"),
    },
    attempt,
    workload: {
      id: FIXTURE_ID,
      dataset_manifest_ref: `fixture://${FIXTURE_ID}`,
      dataset_manifest_sha256: v2FixtureSha256(),
      verifier_environment: "automationbench-simple-api-offline",
      verifier_revision: `v2:${v2FixtureSha256().slice(0, 12)}`,
    },
    splits: {
      train_manifest_ref: `fixture://${FIXTURE_ID}/train#${trainSha}`,
      dev_manifest_ref: `fixture://${FIXTURE_ID}/dev#${devSha}`,
    },
    limits,
  };
  const holdoutSha = v2SplitSha256("holdout");
  if (JSON.stringify(payload).includes(holdoutSha)) {
    throw new Error("refusing to submit: a holdout hash reached the payload");
  }
  return payload;
}

function main() {
  const outPath = argValue("--out");
  const policyPath = argValue("--policy");
  const pairsReportPath = argValue("--pairs-report");
  const executor = argValue("--executor");
  if (!executor) {
    throw new Error(
      "--executor is required and must be one of the contract's values; this lane trains on Tinker, " +
        "which the published enum does not yet name, so the value has to be chosen deliberately rather than defaulted",
    );
  }
  const policy = policyPath ? JSON.parse(readFileSync(policyPath, "utf8")) : {};
  const payload = buildSubmitPayload({
    experimentId: argValue("--experiment-id"),
    candidateId: argValue("--candidate-id"),
    executor,
    model: argValue("--model", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"),
    modelRevision: argValue("--model-revision", null),
    policy,
    policyRef: policyPath ? `file://${policyPath}` : argValue("--policy-ref"),
    pairsReport: pairsReportPath ? JSON.parse(readFileSync(pairsReportPath, "utf8")) : null,
    attempt: argNumber("--attempt", 0),
    limits: {
      budget_usd: argNumber("--budget-usd", 25),
      max_concurrent_candidates: argNumber("--max-concurrent-candidates", 1),
      max_concurrent_requests_per_candidate: argNumber("--max-concurrent-requests", 8),
      max_rollouts: argNumber("--max-rollouts", 2000),
      max_runtime_seconds: argNumber("--max-runtime-seconds", 7200),
    },
  });
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const errors = validateAgainstSchema(schema, payload);
  if (errors.length > 0) {
    console.error(`payload does not satisfy ${schema.properties.schema_version.const}:`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text);
  }
  process.stdout.write(text);
}

if (process.argv[1] && process.argv[1].endsWith("dpo-submit-payload.mjs")) main();
