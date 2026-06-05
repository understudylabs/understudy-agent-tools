#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validatePublicText } from "./public-safety.mjs";

const allowedTopLevel = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
const mvpPublicSkillNames = [
  "understudy",
  "capture-evidence",
  "optimize-api-workflow",
  "optimize-workload",
  "use-understudy-gateway",
  "prepare-verifier-handoff",
];
const mvpRouterTargets = [
  "../capture-evidence/SKILL.md",
  "../optimize-api-workflow/SKILL.md",
  "../optimize-workload/SKILL.md",
  "../use-understudy-gateway/SKILL.md",
  "../prepare-verifier-handoff/SKILL.md",
];
const namePattern = /^[a-z0-9-]+$/;

function parseArgs(argv) {
  const args = { paths: [], docs: ["docs"], repo: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      args.repo = true;
    } else if (arg === "--docs") {
      args.docs = [];
      while (argv[index + 1] && !argv[index + 1].startsWith("--")) {
        args.docs.push(argv[index + 1]);
        index += 1;
      }
    } else {
      args.paths.push(arg);
    }
  }
  if (args.paths.length === 0) {
    args.paths.push("skills");
  }
  return args;
}

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) {
    return null;
  }
  const frontmatter = new Map();
  for (const line of match[1].split("\n")) {
    if (!line.trim() || /^\s/.test(line)) {
      continue;
    }
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!keyMatch) {
      continue;
    }
    const value = keyMatch[2].trim();
    frontmatter.set(keyMatch[1], value === "" || value === "|" || value === ">" ? "" : value.replace(/^["']|["']$/g, ""));
  }
  return { frontmatter, body: text.slice(match[0].length) };
}

function skillDirsForRoot(root) {
  if (existsSync(join(root, "SKILL.md"))) {
    return [root];
  }
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
    .map((entry) => join(root, entry.name));
}

function validateMvpSurface(skillsRoot) {
  return mvpPublicSkillNames
    .map((name) => join(skillsRoot, name, "SKILL.md"))
    .filter((path) => !existsSync(path))
    .map((path) => `${path}: missing MVP public skill`);
}

function hasMeasuredBaselineGate(lowerText) {
  const gateWords = ["measured", "gate", "before", "required", "require", "do not", "must"];
  for (const match of lowerText.matchAll(/\bbaseline\b/g)) {
    const window = lowerText.slice(Math.max(0, match.index - 160), match.index + 280);
    if (gateWords.some((word) => window.includes(word))) {
      return true;
    }
  }
  return false;
}

function requiresRegisterAuthBeforeLocalAnalysis(text) {
  for (const paragraph of text.toLowerCase().split(/\n\s*\n/)) {
    const hasOss = paragraph.includes("oss") || paragraph.includes("open-source");
    const hasLocal = paragraph.includes("local analysis") || paragraph.includes("local analyzer");
    const hasRegisterAuth = paragraph.includes("register") && paragraph.includes("auth");
    const hasBoundary = paragraph.includes("before") || paragraph.includes("required") || paragraph.includes("requires");
    const hasNegation = paragraph.includes("does not require") || paragraph.includes("do not require");
    if (hasOss && hasLocal && hasRegisterAuth && hasBoundary && !hasNegation) {
      return true;
    }
  }
  return false;
}

function hasSavingsClaimWithoutClaimPacket(text) {
  const lowerText = text.toLowerCase();
  if (lowerText.includes("claim packet") || lowerText.includes("claim.json")) {
    return false;
  }
  const patterns = [
    /\bclaim(?:s|ed|ing)?\s+(?:\w+\s+){0,4}savings\b/gi,
    /\bsavings\s+claim(?:s|ed|ing)?\b/gi,
    /\bguarantee(?:s|d|ing)?\s+(?:\w+\s+){0,4}savings\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const window = text.slice(Math.max(0, match.index - 80), match.index + match[0].length).toLowerCase();
      if (!["do not", "don't", "never", "must not", "cannot"].some((negation) => window.includes(negation))) {
        return true;
      }
    }
  }
  return false;
}

function hasUnsafeGepaHoldoutAccess(text) {
  const patterns = [
    /\bGEPA\b[^.\n]*(?:may|can|should|must|will|use|uses|using|run|runs|running|tune|tunes|tuning)[^.\n]*\bholdout\b/gi,
    /\bholdout\b[^.\n]*(?:for|with|in|during)[^.\n]*\bGEPA\b/gi,
    /\bGEPA\b[^.\n]*\b(touch|touches|touching|mutate|mutates|mutating|train|trains|training)[^.\n]*\bholdout\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const window = text.slice(Math.max(0, match.index - 80), match.index + match[0].length).toLowerCase();
      if (!["must not", "do not", "never", "cannot", "may not"].some((negation) => window.includes(negation))) {
        return true;
      }
    }
  }
  return false;
}

function validateSkill(path) {
  const skillMd = join(path, "SKILL.md");
  if (!existsSync(skillMd)) {
    return [`${path}: missing SKILL.md`];
  }
  const text = readFileSync(skillMd, "utf8");
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    return [`${skillMd}: missing YAML frontmatter`];
  }
  const { frontmatter, body } = parsed;
  const errors = [];
  const extra = [...frontmatter.keys()].filter((key) => !allowedTopLevel.has(key)).sort();
  if (extra.length > 0) {
    errors.push(`${skillMd}: unsupported frontmatter keys: ${JSON.stringify(extra)}`);
  }
  const name = frontmatter.get("name") ?? "";
  const dirName = path.split("/").at(-1);
  if (!name || !namePattern.test(name)) {
    errors.push(`${skillMd}: name must be lowercase hyphen-case`);
  } else if (name !== dirName) {
    errors.push(`${skillMd}: name must match directory name`);
  }
  const description = frontmatter.get("description") ?? "";
  if (!description) {
    errors.push(`${skillMd}: missing description`);
  }
  if (description.length > 512) {
    errors.push(`${skillMd}: description should be activation-only; exceeds 512 chars`);
  }
  if (!body.includes("## Safety Gates")) {
    errors.push(`${skillMd}: missing ## Safety Gates`);
  }
  if (!body.includes("## Resolve CLI") && !text.includes("cli_required: false")) {
    errors.push(`${skillMd}: missing ## Resolve CLI`);
  }
  if (text.split("\n").length > 150 && name !== "understudy") {
    if (!existsSync(join(path, "reference.md")) && !existsSync(join(path, "references"))) {
      errors.push(`${skillMd}: >150 lines without reference.md or references/`);
    }
  }
  if (name === "understudy") {
    for (const target of mvpRouterTargets) {
      if (!text.includes(target)) {
        errors.push(`${skillMd}: MVP router must link to ${target}`);
      }
    }
  }
  if ((name.endsWith("optimize") || name === "optimize-workload") && !hasMeasuredBaselineGate(text.toLowerCase())) {
    errors.push(`${skillMd}: optimizer skill must require a measured baseline gate`);
  }
  if (name === "capture-evidence" && requiresRegisterAuthBeforeLocalAnalysis(text)) {
    errors.push(`${skillMd}: must not require register/auth before OSS local analysis`);
  }
  if (mvpPublicSkillNames.includes(name) && hasSavingsClaimWithoutClaimPacket(text)) {
    errors.push(`${skillMd}: savings claims must require a claim packet`);
  }
  if (hasUnsafeGepaHoldoutAccess(text)) {
    errors.push(`${skillMd}: GEPA must not touch holdout data`);
  }
  errors.push(...validatePublicText(skillMd));
  return errors;
}

function gitTrackedFiles() {
  const result = spawnSync("git", ["ls-files"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || "git ls-files failed");
  }
  return result.stdout.split("\n").filter(Boolean);
}

function isGitIgnored(path) {
  const result = spawnSync("git", ["check-ignore", "--quiet", path]);
  return result.status === 0;
}

function scanMarkdown(root) {
  if (!existsSync(root) || isGitIgnored(root)) {
    return [];
  }
  const errors = [];
  const entries = readdirSync(root, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const path = join(entry.parentPath ?? root, entry.name);
    if (!isGitIgnored(path)) {
      errors.push(...validatePublicText(path));
    }
  }
  return errors;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const skillDirs = args.paths.flatMap(skillDirsForRoot);
  const errors = [];
  for (const root of args.paths) {
    if (root === "skills" && existsSync(root)) {
      errors.push(...validateMvpSurface(root));
    }
  }
  for (const skillDir of skillDirs) {
    errors.push(...validateSkill(skillDir));
  }
  for (const docRoot of args.docs) {
    errors.push(...scanMarkdown(docRoot));
  }
  if (args.repo) {
    const exclude = new Set(["scripts/package-smoke.mjs", "scripts/public-safety.mjs", "scripts/validate-public-skills.mjs"]);
    for (const path of gitTrackedFiles()) {
      if (exclude.has(path) || isGitIgnored(path)) {
        continue;
      }
      errors.push(...validatePublicText(path));
    }
  }
  for (const error of errors) {
    console.log(error);
  }
  if (errors.length === 0) {
    console.log(`ok ${skillDirs.length} public skill(s)`);
  }
  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();
