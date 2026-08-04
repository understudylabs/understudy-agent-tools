import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const fixture = resolve("tests/fixtures/campaign-admission");
const bytes = (name) => readFileSync(join(fixture, name));
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function baseManifest(mod) {
  const generated = "uv-project/generated";
  const artifacts = { request: bytes("request.json"), response: bytes("response.json"), tools: bytes("tools.json"), trace: bytes(`${generated}/trace.json`), executionReceipt: bytes(`${generated}/execution-receipt.json`), beforeState: bytes(`${generated}/before-state.json`), afterState: bytes(`${generated}/after-state.json`), overflowReceipt: bytes(`${generated}/overflow-receipt.json`) };
  const trace = JSON.parse(artifacts.trace);
  const receipt = JSON.parse(artifacts.executionReceipt);
  const request = JSON.parse(artifacts.request);
  const semantic = (value) => mod.semanticJsonSha256(Buffer.from(JSON.stringify(value)), "fixture");
  const fixedMessages = request.messages.map((message) => ({ ...message, content: message.content.replace(/<candidate_policy>[\s\S]*?<\/candidate_policy>/g, "<candidate_policy></candidate_policy>") }));
  const lockHash = sha(bytes("uv-project/uv.lock"));
  const manifest = {
    schema_version: "understudy.campaign_admission.v1", campaign_id: "public-synthetic-campaign",
    environment: { pyproject_sha256: sha(bytes("uv-project/pyproject.toml")), uv_lock_sha256: lockHash, uv_lock_check_command: "uv lock --check", uv_lock_check_exit_code: 0, uv_version: "0.12.1", python_version: receipt.interpreter.version, python_executable_sha256: receipt.interpreter.executable_sha256, installed_distributions_sha256: receipt.installed_distributions_sha256, container_image_digest: `sha256:${"2".repeat(64)}`, resolved_packages: mod.parseUvLockPins(bytes("uv-project/uv.lock").toString("utf8")) },
    transport_fingerprints: mod.fingerprintTransport(artifacts), tool_steps: mod.fingerprintToolSteps(artifacts),
    payload_parity: { messages_sha256: semantic(request.messages), tools_sha256: semantic(JSON.parse(artifacts.tools)), sampling_sha256: semantic(request.sampling), context_overflow_behavior: "fail", overflow_probe_receipt_sha256: sha(artifacts.overflowReceipt) },
    workload_contract: { benchmark_prompt_sha256: semantic(fixedMessages), candidate_source: "outer_system_transcript", candidate_tag_sha256: receipt.mutated_candidate_sha256, policy_injection_count: 1, verifiers_version: "0.2.1", verifiers_git_revision: "ab65b6e8d34b03d162408d4bcb854430a86809e6", mcp_version: "1.29.0", tool_schema_sha256: semantic(JSON.parse(artifacts.tools)), package_inventory_sha256: lockHash },
    optimizer_input: { input_bundle_sha256: "3".repeat(64) },
    endpoint_bundle: { bundle_kind: "policy", schema_version: "understudy.policy.v1", executable_bundle_sha256: "4".repeat(64), environment_sha256: lockHash, health_receipt_sha256: "5".repeat(64), model_attestation_sha256: "6".repeat(64), frozen: true, seed: false },
    candidate_lineage: { parent_candidate_sha256: "7".repeat(64), candidate_sha256: "0".repeat(64), prompt_sha256: semantic(fixedMessages), model_attestation_sha256: "6".repeat(64), checkpoint_sha256: "8".repeat(64) },
    context_gates: { source_context_sha256: "9".repeat(64), reflection_context_sha256: "a".repeat(64), source_context_present: true, reflection_context_present: true },
    mutation_smoke: { runtime: trace.runtime, verifiers_version: trace.verifiers_version, task_count: 1, calls: trace.calls.length, nodes: trace.nodes.length, assertion_fraction: trace.metrics.assertion_fraction, seed_candidate_sha256: receipt.seed_candidate_sha256, mutated_candidate_sha256: receipt.mutated_candidate_sha256, eval_exit_code: 0, trace_artifact_sha256: sha(artifacts.trace), execution_receipt_sha256: sha(artifacts.executionReceipt), mutating_effects: [{ tool: "set-record", applied: true }] },
    spend: { campaign_total_usd: 100, prior_spend_usd: 10, allocations: { optimizer: { cap_usd: 20 }, endpoint: { cap_usd: 40 }, training: { cap_usd: 30 } }, transfers: [], charges: [{ charge_id: "optimizer-1", lane: "optimizer", amount_usd: 2, immutable_receipt_sha256: "b".repeat(64) }, { charge_id: "endpoint-1", lane: "endpoint", amount_usd: 3, immutable_receipt_sha256: "c".repeat(64) }, { charge_id: "training-1", lane: "training", amount_usd: 4, immutable_receipt_sha256: "d".repeat(64) }] },
  };
  manifest.candidate_lineage.candidate_sha256 = semantic({ parent_candidate_sha256: manifest.candidate_lineage.parent_candidate_sha256, prompt_sha256: manifest.candidate_lineage.prompt_sha256, model_attestation_sha256: manifest.candidate_lineage.model_attestation_sha256, checkpoint_sha256: manifest.candidate_lineage.checkpoint_sha256, executable_bundle_sha256: manifest.endpoint_bundle.executable_bundle_sha256 });
  return { artifacts, manifest };
}
