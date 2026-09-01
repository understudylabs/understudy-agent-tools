#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  configuredPrivateTermPolicy,
  privateTermsEnvironmentVariable,
  redactPrivateTerms,
  validatePublicPath,
  validatePublicText,
} from "./public-safety.mjs";

const forbiddenMemberParts = [
  ".understudy/",
  ".env",
  ".pytest_cache/",
  ".tmp/",
  ".venv/",
  "__pycache__/",
  "appendix/",
  "docs/capture-import.md",
  "docs/provider-integration-cookbook.md",
  "docs/skill-comparison-audit.md",
  "docs/skill-externalization-plan.md",
  "docs/tool-migration-map.md",
  "examples/",
  ".opencode/skills",
  "pyproject.toml",
  "uv.lock",
  "src/understudy_agent_tools/",
  ".py",
];

const requiredPackageMembers = [
  "dist/bin.js",
  ".agents/plugins/marketplace.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".opencode/adapter.json",
  ".opencode/commands/understudy-onboard.md",
  ".hermes/adapter.json",
  "skills/install-agent-adapter/SKILL.md",
  "skills/install-agent-adapter/reference.md",
  "skills/local-distillation-lab/SKILL.md",
  "skills/local-distillation-lab/references/pedagogical-arm.md",
  "skills/recursive-language-model/SKILL.md",
  "skills/recursive-language-model/references/pedagogical-training.md",
];

function npmPackFiles() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || "npm pack failed");
  }
  const payload = JSON.parse(result.stdout);
  if (!Array.isArray(payload) || payload.length === 0 || !Array.isArray(payload[0].files)) {
    throw new Error("npm pack returned no files");
  }
  return payload[0].files;
}

function main() {
  const release = process.argv.slice(2).includes("--release");
  const privateTermPolicy = configuredPrivateTermPolicy();
  if (release && privateTermPolicy.length === 0) {
    console.error(`error: --release requires ${privateTermsEnvironmentVariable} to contain at least one private term`);
    process.exitCode = 1;
    return;
  }

  const errors = [];
  const packageFiles = npmPackFiles();
  const packagePaths = new Set(packageFiles.map((entry) => entry.path));
  for (const required of requiredPackageMembers) {
    if (!packagePaths.has(required)) {
      errors.push(`package/${required}: required package file missing`);
    }
  }
  const cliEntry = packageFiles.find((entry) => entry.path === "dist/bin.js");
  if (cliEntry && (!Number.isInteger(cliEntry.mode) || (cliEntry.mode & 0o111) === 0)) {
    errors.push("package/dist/bin.js: CLI entry must be executable on Unix");
  }
  for (const entry of packageFiles) {
    const path = entry.path;
    const packageName = `package/${path}`;
    for (const forbidden of forbiddenMemberParts) {
      if (path.includes(forbidden) || path.endsWith(forbidden)) {
        errors.push(`${packageName}: forbidden packaged path ${JSON.stringify(forbidden)}`);
      }
    }
    errors.push(...validatePublicPath(path, {
      displayPath: packageName,
      privateLabel: "private release term",
      privateTermPolicy,
    }));
    errors.push(...validatePublicText(path, {
      displayPath: packageName,
      privateLabel: "private release term",
      privateTermPolicy,
    }));
  }

  for (const error of errors) {
    console.log(redactPrivateTerms(error, privateTermPolicy));
  }
  if (privateTermPolicy.length === 0) {
    console.log("note: private release terms are not configured; private-term checks were skipped");
  }
  if (errors.length === 0) {
    console.log("ok npm package dry-run");
  }
  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();
