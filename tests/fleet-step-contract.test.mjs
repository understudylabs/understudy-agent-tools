import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { canonicalJson, sha256Hex, artifactRef } from "../dist/fleet/artifacts.js";
import { buildDeploymentTags } from "../dist/fleet/tags.js";
import { fleetReapIdempotencyKey, runFleetReapStep } from "../dist/fleet/step.js";

const NOW = Date.parse("2026-01-02T00:00:00.000Z");
const HOUR = 3_600_000;
const iso = (offsetHours) => new Date(NOW + offsetHours * HOUR).toISOString();

function deployments() {
  return [
    {
      name: "accounts/demo/deployments/arm-a",
      baseModel: "accounts/demo/models/base-8b",
      createTime: iso(-6),
      acceleratorType: "NVIDIA_H100_80GB",
      acceleratorCount: 2,
      desiredReplicaCount: 1,
      annotations: buildDeploymentTags({ owner: "arm-a-runner", ttlHours: 4, arm: "arm-a", createdAt: iso(-6) }),
    },
    {
      name: "accounts/demo/deployments/orphan",
      baseModel: "accounts/demo/models/base-70b",
      createTime: iso(-40),
      acceleratorType: "NVIDIA_B200_180GB",
      acceleratorCount: 4,
      desiredReplicaCount: 2,
    },
  ];
}

/** Control plane that records calls; `missing` names raise a 404 like the real one. */
function fakeControlPlane({ missing = [] } = {}) {
  const calls = [];
  return {
    calls,
    async listDeployments() {
      return deployments();
    },
    async scaleToZero(name) {
      calls.push(["scale-to-zero", name]);
      if (missing.includes(name)) throw new Error("provider API error 404: deployment not found");
    },
    async deleteDeployment(name) {
      calls.push(["delete", name]);
      if (missing.includes(name)) throw new Error("provider API error 404: deployment not found");
    },
  };
}

const stepInput = (overrides = {}) => ({
  experimentId: "exp-1",
  candidateId: "arm-a",
  attempt: 0,
  account: "demo",
  scores: [{ arm: "arm-a", score: 0.82, split: "dev" }],
  now: NOW,
  ...overrides,
});

describe("fleet artifact contracts", () => {
  it("hashes canonically regardless of key order", () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
    assert.equal(sha256Hex(canonicalJson({ a: 1, b: 2 })), sha256Hex(canonicalJson({ b: 2, a: 1 })));
  });

  it("emits artifacts matching the published schemas and carrying no payload fields", async () => {
    const result = await runFleetReapStep({ ...stepInput({ candidateId: null }), controlPlane: fakeControlPlane() });
    for (const [artifact, schemaFile] of [
      [result.scoreboard, "understudy.fleet_scoreboard.v1.schema.json"],
      [result.plan, "understudy.fleet_reap_plan.v1.schema.json"],
    ]) {
      const schema = JSON.parse(readFileSync(resolve("schemas", schemaFile), "utf8"));
      assert.equal(artifact.schema_version, schema.properties.schema_version.const);
      for (const key of schema.required) assert.ok(key in artifact, `${schemaFile}: missing ${key}`);
      for (const key of Object.keys(artifact)) assert.ok(key in schema.properties, `${schemaFile}: unexpected ${key}`);
    }
    const body = canonicalJson(result.plan);
    assert.doesNotMatch(body, /Bearer|apiKey|api_key|prompt|trace/i);
    const ref = artifactRef(result.plan, "file:///runs/exp-1/reap-plan.json");
    assert.equal(ref.sha256, result.planSha256);
    assert.equal(ref.schema_version, "understudy.fleet_reap_plan.v1");
  });
});

describe("fleet reap step", () => {
  it("is dry-run by default and touches nothing", async () => {
    const controlPlane = fakeControlPlane();
    const result = await runFleetReapStep({ ...stepInput({ candidateId: null }), controlPlane });
    assert.equal(result.mode, "dry-run");
    assert.deepEqual(controlPlane.calls, []);
    assert.equal(result.plan.counts["scale-to-zero"], 1);
    assert.equal(result.plan.counts.review, 1);
    assert.deepEqual(result.plan.applied, []);
  });

  it("keys idempotently on experiment, candidate, and attempt", () => {
    assert.equal(fleetReapIdempotencyKey({ experimentId: "exp-1", candidateId: "arm-a", attempt: 2 }), "fleet-reap:exp-1:arm-a:2");
    assert.equal(fleetReapIdempotencyKey({ experimentId: "exp-1", attempt: 0 }), "fleet-reap:exp-1:all:0");
    assert.throws(() => fleetReapIdempotencyKey({ experimentId: "exp-1", attempt: -1 }), /attempt/);
  });

  it("scopes to one candidate and converges when replayed at the same attempt", async () => {
    const first = await runFleetReapStep({ ...stepInput(), apply: true, controlPlane: fakeControlPlane() });
    const replayPlane = fakeControlPlane({ missing: ["arm-a"] });
    const second = await runFleetReapStep({ ...stepInput(), apply: true, controlPlane: replayPlane });
    assert.equal(first.idempotencyKey, second.idempotencyKey);
    assert.equal(first.plan.decisions.length, 1, "candidate scoping drops the untagged orphan");
    assert.deepEqual(first.plan.applied, [{ name: "arm-a", action: "scale-to-zero", outcome: "applied" }]);
    assert.deepEqual(second.plan.applied, [{ name: "arm-a", action: "scale-to-zero", outcome: "already-absent" }]);
    assert.deepEqual(replayPlane.calls, [["scale-to-zero", "arm-a"]]);
  });

  it("emits small redacted events instead of streaming state", async () => {
    const emitted = [];
    const result = await runFleetReapStep({
      ...stepInput({ candidateId: null }),
      apply: true,
      controlPlane: fakeControlPlane(),
      emit: (event) => emitted.push(event),
    });
    assert.deepEqual(emitted, result.events);
    assert.deepEqual(
      result.events.map((event) => event.kind),
      ["usage", "scoreboard", "reap_plan", "reap_action"],
    );
    for (const event of result.events) {
      assert.equal(event.schema_version, "understudy.fleet_event.v1");
      assert.equal(event.experiment_id, "exp-1");
      assert.ok(canonicalJson(event).length < 512, "events stay small");
      for (const value of Object.values(event.fields)) assert.ok(["string", "number", "boolean"].includes(typeof value) || value === null);
    }
    assert.equal(result.events[0].fields.untagged_burn_usd_per_hr, 120);
  });

  it("surfaces a real control-plane failure instead of swallowing it", async () => {
    const controlPlane = fakeControlPlane();
    controlPlane.scaleToZero = async () => {
      throw new Error("provider API error 500: upstream unavailable");
    };
    await assert.rejects(
      runFleetReapStep({ ...stepInput({ candidateId: null }), apply: true, controlPlane }),
      /500/,
    );
  });
});
