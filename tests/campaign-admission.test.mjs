import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const fixture = resolve("tests/fixtures/campaign-admission");
const bytes = (name) => readFileSync(join(fixture, name));
const sha = (value) => createHash("sha256").update(value).digest("hex");

function baseManifest(mod) {
  const artifacts = { request: bytes("request.json"), response: bytes("response.json"), tools: bytes("tools.json"), trace: bytes("verifiers-0.2.1-one-task-trace.json") };
  const trace = JSON.parse(bytes("verifiers-0.2.1-one-task-trace.json"));
  return {
    artifacts,
    manifest: {
      schema_version: "understudy.campaign_admission.v1",
      campaign_id: "public-synthetic-campaign",
      environment: {
        pyproject_sha256: sha(bytes("uv-project/pyproject.toml")),
        uv_lock_sha256: sha(bytes("uv-project/uv.lock")),
        uv_lock_check_command: "uv lock --check",
        uv_lock_check_exit_code: 0,
        uv_version: "0.8.0",
        python_version: "3.12.11",
        python_executable_sha256: "1".repeat(64),
        container_image_digest: `sha256:${"2".repeat(64)}`,
        resolved_packages: mod.parseUvLockPins(bytes("uv-project/uv.lock").toString("utf8")),
      },
      transport_fingerprints: mod.fingerprintTransport(artifacts),
      mutation_smoke: {
        runtime: trace.runtime,
        verifiers_version: trace.verifiers_version,
        task_count: 1,
        calls: trace.calls.length,
        nodes: trace.nodes.length,
        assertion_fraction: trace.metrics.assertion_fraction,
        seed_candidate_sha256: "4".repeat(64),
        mutated_candidate_sha256: "5".repeat(64),
        eval_exit_code: 0,
        trace_artifact_sha256: sha(bytes("verifiers-0.2.1-one-task-trace.json")),
        mutating_effects: [{ tool: "set-record", applied: true }],
      },
      spend: {
        campaign_total_usd: 100,
        allocations: { optimizer: { cap_usd: 20 }, endpoint: { cap_usd: 50 }, training: { cap_usd: 30 } },
        transfers: [],
        charges: [
          { charge_id: "optimizer-1", lane: "optimizer", amount_usd: 2, immutable_receipt_sha256: "6".repeat(64) },
          { charge_id: "endpoint-1", lane: "endpoint", amount_usd: 3, immutable_receipt_sha256: "7".repeat(64) },
          { charge_id: "training-1", lane: "training", amount_usd: 4, immutable_receipt_sha256: "8".repeat(64) },
        ],
      },
    },
  };
}

describe("campaign admission", () => {
  it("admits complete provider-free standard-Verifiers 0.2.1 evidence", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, true, result.errors.join("\n"));
    assert.deepEqual(result.effective_spend_caps_usd, { optimizer: 20, endpoint: 50, training: 30 });
  });

  it("distinguishes raw-byte hashes from canonical semantic hashes", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const compact = Buffer.from('{"b":2,"a":1}');
    const formatted = Buffer.from('{\n  "a": 1,\n  "b": 2\n}');
    assert.notEqual(mod.sha256Bytes(compact), mod.sha256Bytes(formatted));
    assert.equal(mod.semanticJsonSha256(compact, "compact"), mod.semanticJsonSha256(formatted, "formatted"));
  });

  it("fails closed for no-op or non-Verifiers mutation evidence", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    manifest.mutation_smoke.runtime = "mock";
    manifest.mutation_smoke.calls = 0;
    manifest.mutation_smoke.nodes = 0;
    manifest.mutation_smoke.assertion_fraction = 0;
    manifest.mutation_smoke.mutated_candidate_sha256 = manifest.mutation_smoke.seed_candidate_sha256;
    manifest.mutation_smoke.mutating_effects = [];
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /standard-verifiers/);
    assert.match(result.errors.join("\n"), /real mutation/);
    assert.match(result.errors.join("\n"), /applied tool effect/);
  });

  it("requires explicit immutable transfer authority and enforces adjusted lane caps", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    manifest.spend.transfers.push({ transfer_id: "move-1", from: "training", to: "endpoint", amount_usd: 10, authority_id: "approval-public-1", immutable_receipt_sha256: "9".repeat(64) });
    manifest.spend.charges.push({ charge_id: "endpoint-2", lane: "endpoint", amount_usd: 55, immutable_receipt_sha256: "a".repeat(64) });
    let result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, true, result.errors.join("\n"));
    assert.deepEqual(result.effective_spend_caps_usd, { optimizer: 20, endpoint: 60, training: 20 });
    delete manifest.spend.transfers[0].authority_id;
    result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /authority_id/);
  });

  it("rejects campaign-total and lane overspend independently", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    manifest.spend.campaign_total_usd = 99;
    manifest.spend.charges.push({ charge_id: "optimizer-2", lane: "optimizer", amount_usd: 19, immutable_receipt_sha256: "b".repeat(64) });
    const result = mod.validateCampaignAdmission(manifest, artifacts);
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /sum of lane caps/);
    assert.match(result.errors.join("\n"), /optimizer charges/);
  });

  it("rejects transport evidence when supplied bytes change", async () => {
    const mod = await import("../dist/campaign-admission/index.js");
    const { manifest, artifacts } = baseManifest(mod);
    const result = mod.validateCampaignAdmission(manifest, { ...artifacts, request: Buffer.from(`${artifacts.request.toString()} `) });
    assert.equal(result.admitted, false);
    assert.match(result.errors.join("\n"), /raw_request_sha256/);
  });
});
