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
    assert.equal(result.tool_steps[0].raw_arguments_equal, true);
    assert.equal(result.tool_steps[0].semantic_arguments_equal, true);
    assert.equal(result.tool_steps[0].mutation, true);
  });

  it("rejects whitespace-only raw argument drift even when semantics match", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    const response = JSON.parse(artifacts.response);
    response.choices[0].message.tool_calls[0].function.arguments = '{ "id": "alpha", "status": "ready" }';
    const changed = Buffer.from(`${JSON.stringify(response)}\n`);
    const changedArtifacts = { ...artifacts, response: changed };
    manifest.transport_fingerprints = mod.fingerprintTransport(changedArtifacts);
    const result = mod.validateCampaignAdmission(manifest, changedArtifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /raw argument mismatch/);
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

  it("reserves campaign total for prior spend plus effective lane allocations", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    manifest.spend.prior_spend_usd = 11;
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /prior spend plus effective lane allocations/);
  });

  it("fails payload parity and max-token overflow downgrades closed", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    manifest.payload_parity.context_overflow_behavior = "truncate";
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /context_overflow/);
  });

  it("requires an executed overflow receipt with zero samples and tools", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    const overflow = JSON.parse(artifacts.overflowReceipt);
    overflow.sample_calls = 1;
    const changed = { ...artifacts, overflowReceipt: Buffer.from(`${JSON.stringify(overflow)}\n`) };
    manifest.payload_parity.overflow_probe_receipt_sha256 = mod.sha256Bytes(changed.overflowReceipt);
    const result = mod.validateCampaignAdmission(manifest, changed);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /did not fail before sampling and tool execution/);
  });

  it("rejects external interpreters, no-project argv, and changed installed distributions", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    for (const mutate of [
      (receipt) => { receipt.argv.splice(2, 0, "--no-project"); },
      (receipt) => { receipt.interpreter.path = "/usr/bin/python3"; },
      (receipt) => { receipt.installed_distributions[0].version = "999"; receipt.installed_distributions_sha256 = mod.semanticJsonSha256(Buffer.from(JSON.stringify(receipt.installed_distributions)), "installed"); },
    ]) {
      const { manifest, artifacts } = baseManifest(mod);
      const receipt = JSON.parse(artifacts.executionReceipt);
      mutate(receipt);
      const changed = { ...artifacts, executionReceipt: Buffer.from(`${JSON.stringify(receipt)}\n`) };
      manifest.mutation_smoke.execution_receipt_sha256 = mod.sha256Bytes(changed.executionReceipt);
      const result = mod.validateCampaignAdmission(manifest, changed);
      assert.equal(result.admitted, false);
      assert.match(result.errors.join("\n"), /locked-project uv argv|cannot use --no-project|locked project Python|installed distributions/);
    }
  });

  it("requires exact workload Verifiers version and commit pins without a global 0.2.1 constant", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    manifest.workload_contract.verifiers_version = "0.2.2.dev77";
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /version\/commit|lock inventory|workload contract/);
    assert.deepEqual(mod.publishedSchemaErrors(manifest).filter((error) => error.includes("verifiers_version")), []);
  });

  it("admits a genuinely different locked Verifiers 0.2.2.dev77 fixture", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod, "uv-project-generic");
    assert.equal(manifest.workload_contract.verifiers_version, "0.2.2.dev77");
    assert.equal(manifest.workload_contract.verifiers_git_revision, "61e7394d45109d142deec768c3c459ab98111e91");
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, true, result.errors.join("\n"));
  });

  it("rejects unbound executable bundles, candidate lineage, and context gates", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    manifest.endpoint_bundle.environment_sha256 = "e".repeat(64);
    manifest.candidate_lineage.model_attestation_sha256 = "f".repeat(64);
    manifest.context_gates.reflection_context_sha256 = manifest.context_gates.source_context_sha256;
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /endpoint bundle environment|model attestation|context gates/);
  });

  it("rejects campaign and workload identity substitution across immutable evidence", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    for (const field of ["campaign_id", "workload_id"]) {
      const { manifest, artifacts } = baseManifest(mod);
      manifest[field] = `substituted-${field}`;
      const result = mod.validateCampaignAdmission(manifest, artifacts);
      assert.equal(result.admitted, false);
      assert.match(result.errors.join("\n"), new RegExp(`${field} does not match admitted identity`));
    }
  });

  it("rejects arbitrary bundle and context hashes not derived from supplied artifacts", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    manifest.optimizer_input.input_bundle_sha256 = "e".repeat(64);
    manifest.endpoint_bundle.health_receipt_sha256 = "f".repeat(64);
    manifest.context_gates.source_context_sha256 = "1".repeat(64);
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /not derived from supplied immutable evidence/);
  });

  it("rejects omitted installed packages and missing Verifiers after receipt rehash", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    for (const packageName of ["aiofiles", "verifiers"]) {
      const { manifest, artifacts } = baseManifest(mod);
      const receipt = JSON.parse(artifacts.executionReceipt);
      receipt.installed_distributions = receipt.installed_distributions.filter((item) => item.name !== packageName);
      receipt.installed_distributions_sha256 = mod.semanticJsonSha256(Buffer.from(JSON.stringify(receipt.installed_distributions)), "installed");
      manifest.environment.installed_distributions_sha256 = receipt.installed_distributions_sha256;
      const changed = { ...artifacts, executionReceipt: Buffer.from(`${JSON.stringify(receipt)}\n`) };
      manifest.mutation_smoke.execution_receipt_sha256 = mod.sha256Bytes(changed.executionReceipt);
      const result = mod.validateCampaignAdmission(manifest, changed);
      assert.equal(result.admitted, false);
      assert.match(result.errors.join("\n"), /exact applicable locked project inventory|installed Verifiers/);
    }
  });

  it("rejects mismatched runtime and fabricated assertion metrics after artifact rehash", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    {
      const { manifest, artifacts } = baseManifest(mod);
      const trace = JSON.parse(artifacts.trace);
      trace.verifiers_version = "9.9.9";
      const changed = { ...artifacts, trace: Buffer.from(`${JSON.stringify(trace)}\n`) };
      manifest.transport_fingerprints = mod.fingerprintTransport(changed);
      manifest.mutation_smoke.trace_artifact_sha256 = mod.sha256Bytes(changed.trace);
      const result = mod.validateCampaignAdmission(manifest, changed);
      assert.equal(result.admitted, false);
      assert.match(result.errors.join("\n"), /does not match the admitted standard-Verifiers version|does not bind the supplied trace/);
    }
    {
      const { manifest, artifacts } = baseManifest(mod);
      const trace = JSON.parse(artifacts.trace);
      trace.metrics.assertion_fraction = 0.5;
      trace.rewards.assertion_fraction = 0.5;
      const changed = { ...artifacts, trace: Buffer.from(`${JSON.stringify(trace)}\n`) };
      manifest.transport_fingerprints = mod.fingerprintTransport(changed);
      manifest.mutation_smoke.trace_artifact_sha256 = mod.sha256Bytes(changed.trace);
      manifest.mutation_smoke.assertion_fraction = 0.5;
      const result = mod.validateCampaignAdmission(manifest, changed);
      assert.equal(result.admitted, false);
      assert.match(result.errors.join("\n"), /standard-Verifiers Rubric receipt|does not bind the supplied trace/);
    }
  });
});
