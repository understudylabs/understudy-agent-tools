import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseManifest } from "./helpers/campaign-admission-fixture.mjs";

describe("campaign admission", () => {
  it("admits generated provider-free standard-Verifiers 0.2.1 evidence", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, true, result.errors.join("\n"));
    assert.equal(result.admission_only, true);
    assert.equal(result.compile_authorized, false);
    assert.equal(result.cumulative_spend_usd, 19);
    assert.equal(result.tool_steps[0].raw_arguments_equal, false);
    assert.equal(result.tool_steps[0].semantic_arguments_equal, true);
    assert.equal(result.tool_steps[0].mutation, true);
  });

  it("whitespace changes alter raw arguments while preserving semantic equality", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    const response = JSON.parse(artifacts.response);
    response.choices[0].message.tool_calls[0].function.arguments = '{"id":"alpha","status":"ready"}';
    const changed = Buffer.from(`${JSON.stringify(response)}\n`);
    const changedArtifacts = { ...artifacts, response: changed };
    manifest.transport_fingerprints = mod.fingerprintTransport(changedArtifacts);
    manifest.tool_steps = mod.fingerprintToolSteps(changedArtifacts);
    const result = mod.validateCampaignAdmission(manifest, changedArtifacts);
    assert.equal(result.admitted, true, result.errors.join("\n"));
    assert.equal(result.tool_steps[0].raw_arguments_equal, true);
    assert.equal(result.tool_steps[0].semantic_arguments_equal, true);
  });

  it("rejects executed argument changes, missing/duplicate IDs, and non-string arguments", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const base = baseManifest(mod);
    for (const mutate of [
      (trace) => { trace.nodes[2].message.tool_calls[0].arguments = '{"id":"beta","status":"ready"}'; },
      (trace) => { trace.nodes[2].message.tool_calls.push({ ...trace.nodes[2].message.tool_calls[0] }); },
      (trace) => { trace.nodes[2].message.tool_calls[0].arguments = { id: "alpha", status: "ready" }; },
      (trace) => { trace.nodes.splice(3, 1); },
      (trace) => { trace.nodes[2].message.tool_calls[0].name = "world_toolset_other-record"; },
      (trace) => { trace.nodes[2].message.tool_calls[0].arguments = "not-json"; },
      (trace) => { trace.nodes[2].message.tool_calls[0].arguments = "[]"; },
    ]) {
      const trace = JSON.parse(base.artifacts.trace);
      mutate(trace);
      const artifacts = { ...base.artifacts, trace: Buffer.from(`${JSON.stringify(trace)}\n`) };
      const result = mod.validateCampaignAdmission(base.manifest, artifacts);
      assert.equal(result.admitted, false);
      assert.match(result.errors.join("\n"), /mismatch|duplicate|JSON string|missing executed|valid JSON|decode to an object/);
    }
  });

  it("enforces published schema and runtime lockstep", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    delete manifest.campaign_id;
    manifest.private_prompt = "must be rejected";
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /campaign_id/);
    assert.match(result.errors.join("\n"), /additional properties/);
    assert.deepEqual(mod.publishedSchemaErrors({ ...baseManifest(mod).manifest }), []);
  });

  it("quarantines unchanged candidates and invalid generated state bindings", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    manifest.mutation_smoke.mutated_candidate_sha256 = manifest.mutation_smoke.seed_candidate_sha256;
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /real mutation|candidate hashes/);
  });

  it("requires immutable transfers and rejects prior plus new spend beyond total", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    manifest.spend.transfers.push({ transfer_id: "move-1", from: "training", to: "endpoint", amount_usd: 10, authority_id: "approval-public-1", immutable_receipt_sha256: "9".repeat(64) });
    manifest.spend.charges.push({ charge_id: "endpoint-2", lane: "endpoint", amount_usd: 55, immutable_receipt_sha256: "a".repeat(64) });
    manifest.spend.prior_spend_usd = 95;
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /prior spend plus new charges/);
  });

  it("fails payload parity and max-token overflow downgrades closed", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    manifest.payload_parity.context_overflow_behavior = "truncate";
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /context_overflow/);
  });
});
