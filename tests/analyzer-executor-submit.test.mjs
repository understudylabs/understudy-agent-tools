import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const root = resolve(".");
const script = resolve(root, "scripts/analyzer-executor-submit.mjs");
const schema = JSON.parse(readFileSync(resolve(root, "tests/fixtures/analyzer/experiment-executor-submit-request.json"), "utf8"));

function emit(extra = []) {
  const pairArgs = extra.includes("--pairs-ref") ? [] : ["--pairs-ref", "analyzer/pairs.jsonl"];
  const result = spawnSync(process.execPath, [script, "--verifier-revision", "verifier-revision", ...pairArgs, "--pairs-sha256", "a".repeat(64), ...extra], {
    cwd: root,
    encoding: "utf8",
  });
  return result;
}

function schemaErrors(value, definition, path = "$") {
  const errors = [];
  if (definition.const !== undefined && value !== definition.const) errors.push(`${path}: const mismatch`);
  if (definition.enum && !definition.enum.includes(value)) errors.push(`${path}: enum mismatch`);
  if (definition.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object`];
    for (const required of definition.required ?? []) {
      if (!(required in value)) errors.push(`${path}.${required}: missing required property`);
    }
    if (definition.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in definition.properties)) errors.push(`${path}.${key}: additional property`);
      }
    }
    for (const [key, child] of Object.entries(definition.properties ?? {})) {
      if (key in value) errors.push(...schemaErrors(value[key], child, `${path}.${key}`));
    }
  } else if (definition.type === "string") {
    if (typeof value !== "string") errors.push(`${path}: expected string`);
    else {
      if (definition.minLength !== undefined && value.length < definition.minLength) errors.push(`${path}: too short`);
      if (definition.maxLength !== undefined && value.length > definition.maxLength) errors.push(`${path}: too long`);
      if (definition.pattern && !new RegExp(definition.pattern).test(value)) errors.push(`${path}: pattern mismatch`);
    }
  } else if (definition.type === "integer") {
    if (!Number.isInteger(value)) errors.push(`${path}: expected integer`);
    else {
      if (definition.minimum !== undefined && value < definition.minimum) errors.push(`${path}: below minimum`);
      if (definition.maximum !== undefined && value > definition.maximum) errors.push(`${path}: above maximum`);
    }
  } else if (definition.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path}: expected number`);
    else {
      if (definition.minimum !== undefined && value < definition.minimum) errors.push(`${path}: below minimum`);
      if (definition.maximum !== undefined && value > definition.maximum) errors.push(`${path}: above maximum`);
    }
  }
  return errors;
}

function payload() {
  const result = emit();
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("analyzer executor submit payload", () => {
  it("emits a payload valid against the pinned upstream schema", () => {
    const value = payload();
    assert.deepEqual(schemaErrors(value, schema), []);
    assert.ok(schema.properties.candidate.properties.executor.enum.includes(value.candidate.executor));
  });

  it("enforces additionalProperties false at every object level", () => {
    const value = payload();
    for (const [path, target] of [
      ["top-level", value],
      ["candidate", value.candidate],
      ["workload", value.workload],
      ["splits", value.splits],
      ["limits", value.limits],
    ]) {
      const mutated = structuredClone(value);
      const targetPath = path === "top-level" ? mutated : mutated[path];
      targetPath.unexpected = true;
      assert.ok(schemaErrors(mutated, schema).some((error) => error.includes("additional property")), path);
    }
  });

  it("refuses payloads carrying holdout-related material", () => {
    const result = emit(["--pairs-ref", "analyzer/holdout-pairs.jsonl"]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /sealed holdout/);
  });

  it("is deterministic for fixed inputs", () => {
    assert.deepEqual(payload(), payload());
  });
});
