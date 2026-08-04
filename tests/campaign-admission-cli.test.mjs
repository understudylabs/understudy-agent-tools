import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { baseManifest } from "./helpers/campaign-admission-fixture.mjs";

const fixture = resolve("tests/fixtures/campaign-admission");
for (const projectName of ["uv-project", "uv-project-generic"]) it(`campaigns admit reruns the exact locked ${projectName} generator and verifies its bytes`, async (t) => {
  if (spawnSync("uv", ["--version"]).status !== 0) return t.skip("uv is unavailable");
  const mod = await import("../dist/campaign-admission/index.js");
  const { manifest } = baseManifest(mod, projectName);
  const project = join(fixture, projectName);
  manifest.environment.uv_version = execFileSync("uv", ["--version"], { encoding: "utf8" }).trim().match(/^uv\s+(\S+)/)[1];
  const generated = join(project, "generated");
  const temp = mkdtempSync(join(tmpdir(), "campaign-admission-cli-"));
  try {
    const manifestPath = join(temp, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const args = [resolve("dist/bin.js"), "campaigns", "admit", "--manifest", manifestPath, "--project", project,
      "--request", join(fixture, "request.json"), "--response", join(fixture, "response.json"), "--tools", join(fixture, "tools.json"),
      "--trace", join(generated, "trace.json"), "--execution-receipt", join(generated, "execution-receipt.json"),
      "--before-state", join(generated, "before-state.json"), "--after-state", join(generated, "after-state.json"),
      "--overflow-receipt", join(generated, "overflow-receipt.json"),
      "--campaign-evidence", join(generated, "campaign-evidence.json"),
      "--applicable-lock", join(generated, "applicable-lock.json")];
    const run = spawnSync("node", args, { encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const output = JSON.parse(run.stdout);
    assert.equal(output.admitted, true);
    assert.equal(output.admission_only, true);
    assert.equal(output.compile_authorized, false);
    assert.equal(output.tool_steps[0].semantic_arguments_equal, true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

it("rejects a coherently rehashed fabrication because trusted agent-tools derivation disagrees", async (t) => {
  if (spawnSync("uv", ["--version"]).status !== 0) return t.skip("uv is unavailable");
  const mod = await import("../dist/campaign-admission/index.js");
  const { manifest, artifacts } = baseManifest(mod);
  const project = join(fixture, "uv-project");
  manifest.environment.uv_version = execFileSync("uv", ["--version"], { encoding: "utf8" }).trim().match(/^uv\s+(\S+)/)[1];
  const trace = JSON.parse(artifacts.trace);
  trace.metrics.assertion_fraction = 0.5;
  trace.rewards.assertion_fraction = 0.5;
  const fakeTrace = Buffer.from(`${JSON.stringify(trace)}\n`);
  const receipt = JSON.parse(artifacts.executionReceipt);
  receipt.assertion_fraction = 0.5;
  receipt.trace_sha256 = mod.sha256Bytes(fakeTrace);
  const fakeReceipt = Buffer.from(`${JSON.stringify(receipt)}\n`);
  const fakeArtifacts = { ...artifacts, trace: fakeTrace, executionReceipt: fakeReceipt };
  manifest.mutation_smoke.assertion_fraction = 0.5;
  manifest.mutation_smoke.trace_artifact_sha256 = mod.sha256Bytes(fakeTrace);
  manifest.mutation_smoke.execution_receipt_sha256 = mod.sha256Bytes(fakeReceipt);
  manifest.transport_fingerprints = mod.fingerprintTransport(fakeArtifacts);
  const temp = mkdtempSync(join(tmpdir(), "campaign-admission-fabrication-"));
  try {
    const manifestPath = join(temp, "manifest.json");
    const tracePath = join(temp, "trace.json");
    const receiptPath = join(temp, "execution-receipt.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(tracePath, fakeTrace);
    writeFileSync(receiptPath, fakeReceipt);
    const generated = join(project, "generated");
    const args = [resolve("dist/bin.js"), "campaigns", "admit", "--manifest", manifestPath, "--project", project,
      "--request", join(fixture, "request.json"), "--response", join(fixture, "response.json"), "--tools", join(fixture, "tools.json"),
      "--trace", tracePath, "--execution-receipt", receiptPath, "--before-state", join(generated, "before-state.json"),
      "--after-state", join(generated, "after-state.json"), "--overflow-receipt", join(generated, "overflow-receipt.json"),
      "--campaign-evidence", join(generated, "campaign-evidence.json"), "--applicable-lock", join(generated, "applicable-lock.json")];
    const run = spawnSync("node", args, { encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /trusted agent-tools derivation rejects supplied trace\.json/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
