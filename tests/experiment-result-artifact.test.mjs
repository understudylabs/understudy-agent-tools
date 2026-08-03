import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const schema = JSON.parse(readFileSync("schemas/understudy.experiment-result.v1.schema.json", "utf8"));
const artifact = JSON.parse(readFileSync("outputs/gepa-run/experiment-result.json", "utf8"));

function assertObjectShape(value, definition, path) {
  assert.equal(typeof value, "object", `${path} must be an object`);
  assert.notEqual(value, null, `${path} must not be null`);
  for (const key of definition.required ?? []) {
    assert.notEqual(value[key], undefined, `${path}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    assert.ok(Object.hasOwn(definition.properties ?? {}, key), `${path}.${key} is not allowed`);
  }
}

describe("experiment result artifact", () => {
  it("matches the vendored terminal-result contract", () => {
    assertObjectShape(artifact, schema, "artifact");
    assert.equal(artifact.schema_version, "understudy.experiment-result.v1");
    assert.equal(artifact.state, "succeeded");
    assert.equal(artifact.holdout_executed, true);
    assert.equal(artifact.holdout_clean, true);
    assert.equal(artifact.request_isolation_proven, false);
    assert.equal(artifact.usage.evidence_scope, "unknown");
    assert.equal(artifact.usage.actual_usd, null);
    assertObjectShape(artifact.split_manifest_refs, schema.properties.split_manifest_refs, "split_manifest_refs");
    assertObjectShape(artifact.split_manifest_sha256, schema.properties.split_manifest_sha256, "split_manifest_sha256");
    assertObjectShape(artifact.usage, schema.properties.usage, "usage");
    assertObjectShape(artifact.quality_evidence, schema.properties.quality_evidence, "quality_evidence");
    assert.ok(Array.isArray(artifact.failure_clusters));
    assert.ok(Array.isArray(artifact.cancellation_receipts));
    assert.equal(artifact.cancellation_receipts.length, 0);
    assert.ok(artifact.artifact_refs.length > 0);
    assert.match(artifact.claim_boundary, /synthetic-fixture/i);
  });
});
