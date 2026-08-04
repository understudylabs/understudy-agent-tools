import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { baseManifest } from "./helpers/campaign-admission-fixture.mjs";

const fixture = resolve("tests/fixtures/campaign-admission");
it("campaigns admit reruns the exact locked generator and verifies its bytes", async (t) => {
  if (spawnSync("uv", ["--version"]).status !== 0) return t.skip("uv is unavailable");
  const mod = await import("../dist/campaign-admission/index.js");
  const { manifest } = baseManifest(mod);
  const project = join(fixture, "uv-project");
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
      "--smoke-generator", join(project, "generate_smoke.py")];
    const run = spawnSync("node", args, { encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const output = JSON.parse(run.stdout);
    assert.equal(output.admitted, true);
    assert.equal(output.admission_only, true);
    assert.equal(output.compile_authorized, false);
    assert.equal(output.tool_steps[0].semantic_arguments_equal, true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
