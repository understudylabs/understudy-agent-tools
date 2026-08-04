import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

const fixture = resolve("tests/fixtures/campaign-admission");
const sha = (value) => createHash("sha256").update(value).digest("hex");

it("campaigns admit verifies the locked project and public synthetic evidence", async (t) => {
  if (spawnSync("uv", ["--version"]).status !== 0) return t.skip("uv is unavailable");
  const mod = await import("../dist/campaign-admission/index.js");
  const project = join(fixture, "uv-project");
  const request = join(fixture, "request.json");
  const response = join(fixture, "response.json");
  const tools = join(fixture, "tools.json");
  const trace = join(fixture, "verifiers-0.2.1-one-task-trace.json");
  const python = execFileSync("uv", ["python", "find", "3.12"], { encoding: "utf8" }).trim();
  const pythonVersion = execFileSync(python, ["-c", "import platform; print(platform.python_version())"], { encoding: "utf8" }).trim();
  const artifacts = { request: readFileSync(request), response: readFileSync(response), tools: readFileSync(tools), trace: readFileSync(trace) };
  const lock = readFileSync(join(project, "uv.lock"));
  const manifest = {
    schema_version: "understudy.campaign_admission.v1",
    campaign_id: "public-synthetic-cli",
    environment: {
      pyproject_sha256: sha(readFileSync(join(project, "pyproject.toml"))), uv_lock_sha256: sha(lock),
      uv_lock_check_command: "uv lock --check", uv_lock_check_exit_code: 0,
      uv_version: execFileSync("uv", ["--version"], { encoding: "utf8" }).trim().match(/^uv\s+(\S+)/)[1],
      python_version: pythonVersion, python_executable_sha256: sha(readFileSync(python)),
      container_image_digest: `sha256:${"c".repeat(64)}`,
      resolved_packages: mod.parseUvLockPins(lock.toString("utf8")),
    },
    transport_fingerprints: mod.fingerprintTransport(artifacts),
    mutation_smoke: {
      runtime: "standard-verifiers", verifiers_version: "0.2.1", task_count: 1, calls: 1, nodes: 4, assertion_fraction: 1,
      seed_candidate_sha256: "d".repeat(64), mutated_candidate_sha256: "e".repeat(64), eval_exit_code: 0,
      trace_artifact_sha256: sha(artifacts.trace), mutating_effects: [{ tool: "set-record", applied: true }],
    },
    spend: { campaign_total_usd: 3, allocations: { optimizer: { cap_usd: 1 }, endpoint: { cap_usd: 1 }, training: { cap_usd: 1 } }, transfers: [], charges: [] },
  };
  const temp = mkdtempSync(join(tmpdir(), "campaign-admission-cli-"));
  try {
    const manifestPath = join(temp, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const run = spawnSync("node", [resolve("dist/bin.js"), "campaigns", "admit", "--manifest", manifestPath, "--project", project, "--request", request, "--response", response, "--tools", tools, "--trace", trace], { encoding: "utf8" });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.equal(JSON.parse(run.stdout).admitted, true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
