import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";

import { parseUvLockPins, readTransportArtifacts, validateCampaignAdmission } from "../campaign-admission/index.js";

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function registerCampaignsCommand(program: Command): void {
  const campaigns = program.command("campaigns").description("Validate provider-free campaign admission evidence");
  campaigns.command("admit")
    .description("Fail closed unless environment, transport, mutation-smoke, and spend evidence is complete")
    .requiredOption("--manifest <path>", "Campaign admission manifest")
    .requiredOption("--project <path>", "Locked uv project directory")
    .requiredOption("--request <path>", "Raw JSON request artifact")
    .requiredOption("--response <path>", "Raw JSON response artifact")
    .requiredOption("--tools <path>", "Raw JSON tool catalog artifact")
    .requiredOption("--trace <path>", "Exactly-one-task standard-Verifiers trace artifact")
    .action((options: { manifest: string; project: string; request: string; response: string; tools: string; trace: string }) => {
      try {
        const project = resolve(options.project);
        const manifest = JSON.parse(readFileSync(resolve(options.manifest), "utf8")) as Record<string, unknown>;
        const environment = manifest.environment as Record<string, unknown>;
        const pyproject = join(project, "pyproject.toml");
        const lock = join(project, "uv.lock");
        if (environment.pyproject_sha256 !== fileSha256(pyproject)) throw new Error("pyproject.toml hash does not match manifest");
        if (environment.uv_lock_sha256 !== fileSha256(lock)) throw new Error("uv.lock hash does not match manifest");
        const uvVersion = execFileSync("uv", ["--version"], { encoding: "utf8" }).trim().match(/^uv\s+(\S+)/)?.[1];
        if (!uvVersion) throw new Error("could not parse uv version");
        if (environment.uv_version !== uvVersion) throw new Error(`uv version mismatch: expected ${String(environment.uv_version)}, got ${uvVersion}`);
        execFileSync("uv", ["lock", "--check", "--project", project], { stdio: "pipe" });
        const declaredPins = JSON.stringify(environment.resolved_packages);
        const lockedPins = JSON.stringify(parseUvLockPins(readFileSync(lock, "utf8")));
        if (declaredPins !== lockedPins) throw new Error("resolved package pins do not exactly match uv.lock");
        const python = execFileSync("uv", ["python", "find", String(environment.python_version)], { encoding: "utf8" }).trim();
        const pythonVersion = execFileSync(python, ["-c", "import platform; print(platform.python_version())"], { encoding: "utf8" }).trim();
        if (pythonVersion !== environment.python_version) throw new Error(`python version mismatch: expected ${String(environment.python_version)}, got ${pythonVersion}`);
        if (fileSha256(python) !== environment.python_executable_sha256) throw new Error("python executable hash does not match manifest");
        const result = validateCampaignAdmission(manifest, readTransportArtifacts({ request: resolve(options.request), response: resolve(options.response), tools: resolve(options.tools), trace: resolve(options.trace) }));
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.admitted) process.exitCode = 1;
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ admitted: false, errors: [error instanceof Error ? error.message : String(error)] })}\n`);
        process.exitCode = 1;
      }
    });
}
