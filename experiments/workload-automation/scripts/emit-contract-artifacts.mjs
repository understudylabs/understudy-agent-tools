#!/usr/bin/env node
/**
 * Emit the WL-AU arm's two Workflow-facing artifacts and validate both against
 * the *sealed* platform schemas vendored in `../contracts`:
 *
 *   understudy.executor-submit.v1   — the candidate payload (refs + hashes)
 *   understudy.experiment-result.v1 — the arm's evidence record
 *
 * This arm is a verifier/contract plus a candidate-method. It runs no
 * controller, keeps no state, and this script performs no provider calls: it is
 * a pure function from on-disk artifacts to two JSON documents.
 *
 * Holdout is STRUCTURALLY ABSENT from the submit payload — the schema has no
 * field for it and this script refuses to emit one that mentions it. The
 * holdout hash appears only in the result record, where `holdout_executed` and
 * `holdout_clean` state plainly whether the seal was broken and whether it was
 * read exactly once, after dev had already settled.
 *
 * Usage:
 *   node experiments/workload-automation/scripts/emit-contract-artifacts.mjs \
 *     --arm-dir experiments/workload-automation --out-dir outputs/workload-automation/contracts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = join(here, "..", "contracts");

/**
 * Minimal validator for the JSON Schema subset the sealed contracts use
 * (const/enum/type/required/pattern/bounds/additionalProperties/anyOf/items).
 * Hand-rolled on purpose: the schemas are vendored bytes, so validation must
 * not depend on a package that could be absent or a different version.
 */
export function validate(schema, value, path = "$") {
  const errors = [];
  const push = (message) => errors.push(`${path}: ${message}`);

  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((option) => validate(option, value, path).length === 0)) push("matches none of anyOf");
    return errors;
  }
  if (schema.const !== undefined && value !== schema.const) push(`expected const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) push(`${JSON.stringify(value)} is not one of ${schema.enum.join("|")}`);

  const type = schema.type;
  if (type === "null" && value !== null) push("expected null");
  if (type === "boolean" && typeof value !== "boolean") push("expected boolean");
  if (type === "string" || type === "number" || type === "integer" || type === "object" || type === "array") {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const ok = type === "integer" ? Number.isInteger(value) : type === "object" ? actual === "object" : actual === type;
    if (!ok) {
      push(`expected ${type}, got ${actual}`);
      return errors;
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) push(`shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) push(`longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) push(`does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) push(`below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) push(`above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) push(`more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validate(schema.items, item, `${path}[${index}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) push(`missing required property ${key}`);
    for (const [key, entry] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property) {
        errors.push(...validate(property, entry, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        push(`unexpected property ${key}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validate(schema.additionalProperties, entry, `${path}.${key}`));
      }
      if (schema.propertyNames) errors.push(...validate(schema.propertyNames, key, `${path}.${key} (name)`));
    }
  }
  return errors;
}

export function loadContract(name) {
  return JSON.parse(readFileSync(join(CONTRACTS_DIR, `${name}.json`), "utf8"));
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha256 = (path) => sha256(readFileSync(path));

/** A submit payload that names the holdout in any form is a contract breach. */
export function assertHoldoutAbsent(payload) {
  const serialized = JSON.stringify(payload);
  if (/holdout/i.test(serialized)) throw new Error("submit payload mentions the holdout; it must be structurally absent");
}

export function buildSubmitPayload({ experimentId, candidate, attempt, workload, splits, limits }) {
  const payload = {
    schema_version: "understudy.executor-submit.v1",
    experiment_id: experimentId,
    candidate,
    attempt,
    workload,
    splits,
    limits,
  };
  assertHoldoutAbsent(payload);
  const errors = validate(loadContract("experiment-executor-submit-request"), payload);
  if (errors.length > 0) throw new Error(`submit payload violates understudy.executor-submit.v1:\n  ${errors.join("\n  ")}`);
  return payload;
}

export function buildResult(record) {
  const errors = validate(loadContract("experiment-result"), record);
  if (errors.length > 0) throw new Error(`result violates understudy.experiment-result.v1:\n  ${errors.join("\n  ")}`);
  return record;
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function main() {
  const armDir = argValue("--arm-dir", "experiments/workload-automation");
  const outDir = argValue("--out-dir", "outputs/workload-automation/contracts");
  const executor = argValue("--executor", null);
  const lift = JSON.parse(readFileSync(join(armDir, "dpo-lift.json"), "utf8"));
  const gate = JSON.parse(readFileSync(join(armDir, "gate-validation.json"), "utf8"));

  const policyPath = join(armDir, "candidate-policy.json");
  const trainManifestPath = join(armDir, "pairs.manifest.json");
  const devManifestPath = join(armDir, "dev.manifest.json");

  mkdirSync(outDir, { recursive: true });

  // `tinker` is not a member of the sealed executor enum, and this arm will not
  // mislabel its provider to squeeze past validation. Until the enum carries it,
  // the payload is emitted only when an executor id is supplied explicitly.
  if (executor) {
    const submit = buildSubmitPayload({
      experimentId: lift.experiment_id,
      attempt: 0,
      candidate: {
        candidate_id: lift.candidate_id,
        executor,
        model: lift.base_model,
        model_revision: lift.renderer,
        policy_ref: `file://${policyPath}`,
        policy_sha256: fileSha256(policyPath),
      },
      workload: {
        id: lift.workload_code,
        dataset_manifest_ref: `file://${join(armDir, "gate-validation.json")}`,
        dataset_manifest_sha256: fileSha256(join(armDir, "gate-validation.json")),
        verifier_environment: gate.fixture_id,
        verifier_revision: gate.fixture_sha256,
      },
      splits: {
        train_manifest_ref: `file://${trainManifestPath}`,
        train_manifest_sha256: fileSha256(trainManifestPath),
        dev_manifest_ref: `file://${devManifestPath}`,
        dev_manifest_sha256: fileSha256(devManifestPath),
      },
      limits: lift.limits,
    });
    writeFileSync(join(outDir, "executor-submit.json"), `${JSON.stringify(submit, null, 2)}\n`);
    console.log(`executor-submit.json written (executor=${executor})`);
  } else {
    console.log("no --executor supplied: submit payload not emitted (the sealed enum has no `tinker` member)");
  }

  const result = buildResult(lift.result);
  writeFileSync(join(outDir, "experiment-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log("experiment-result.json written");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
