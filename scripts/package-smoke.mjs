#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  allowedProductionUrls,
  privateTerms,
  productionUrlPatterns,
  rawPayloadPatterns,
  secretPatterns,
  textExtensions,
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

function textErrors(name, path) {
  const extension = extname(path).toLowerCase();
  if (!existsSync(path) || (!textExtensions.has(extension) && extension !== ".map")) {
    return [];
  }
  const text = readFileSync(path, "utf8");
  const errors = [];
  for (const term of privateTerms) {
    if (text.includes(term)) {
      errors.push(`${name}: contains private release term ${JSON.stringify(term)}`);
    }
  }
  for (const pattern of [...secretPatterns, ...rawPayloadPatterns]) {
    if (pattern.test(text)) {
      errors.push(`${name}: contains unsafe text matching ${pattern.source}`);
    }
  }
  for (const pattern of productionUrlPatterns) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
      const url = match[0].replace(/\/+$/, "");
      if (!allowedProductionUrls.has(url)) {
        errors.push(`${name}: contains unsafe text matching ${pattern.source}`);
      }
    }
  }
  return errors;
}

const errors = [];
const packageFiles = npmPackFiles();
const packagePaths = new Set(packageFiles.map((entry) => entry.path));
for (const required of requiredPackageMembers) {
  if (!packagePaths.has(required)) {
    errors.push(`package/${required}: required package file missing`);
  }
}
for (const entry of packageFiles) {
  const path = entry.path;
  const packageName = `package/${path}`;
  for (const forbidden of forbiddenMemberParts) {
    if (path.includes(forbidden) || path.endsWith(forbidden)) {
      errors.push(`${packageName}: forbidden packaged path ${JSON.stringify(forbidden)}`);
    }
  }
  errors.push(...textErrors(packageName, path));
}

for (const error of errors) {
  console.log(error);
}
if (errors.length === 0) {
  console.log("ok npm package dry-run");
}
process.exitCode = errors.length > 0 ? 1 : 0;
