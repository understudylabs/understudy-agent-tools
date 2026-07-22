#!/usr/bin/env node
// wave-ownership.mjs — check a branch's changed files against a wave.json
// ownership manifest. Formalizes per-wave file-ownership contracts so two
// agents don't silently extend the same file in one wave.
//
// wave.json shape:
//   {
//     "agents": [
//       { "branch": "anthro/foo", "owns": ["src/foo/**"], "forbidden": ["src/run-executor.ts"] }
//     ]
//   }
//
// Usage:
//   node scripts/wave-ownership.mjs --wave wave.json --branch anthro/foo --pr 123
//   node scripts/wave-ownership.mjs --wave wave.json --branch anthro/foo --base origin/main
//   git diff --name-only origin/main | node scripts/wave-ownership.mjs --wave wave.json --branch anthro/foo --stdin
//
// Changed files come from `gh pr diff <pr> --name-only`, `git diff --name-only <base>...HEAD`,
// or stdin. Violations:
//   - a changed file matches the agent's `forbidden` globs
//   - a changed file matches another agent's `owns` globs (unless this agent also owns it)
// Exits nonzero on any violation. No dependencies.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function usageExit(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    "usage: wave-ownership.mjs --wave <wave.json> --branch <branch> (--pr <n> | --base <ref> | --stdin)"
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--stdin") opts.stdin = true;
  else if (a === "--wave" || a === "--branch" || a === "--pr" || a === "--base") {
    opts[a.slice(2)] = args[++i] ?? usageExit(`missing value for ${a}`);
  } else usageExit(`unknown arg ${a}`);
}
if (!opts.wave || !opts.branch) usageExit("--wave and --branch are required");

// Minimal glob matcher: supports **, *, ?. Anchored to the whole path.
function globToRegExp(glob) {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?"; // zero or more directories
      i += 3;
    } else if (glob.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else if (glob[i] === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += glob[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}
const matches = (file, globs = []) => globs.some((g) => globToRegExp(g).test(file));

let manifest;
try {
  manifest = JSON.parse(readFileSync(opts.wave, "utf8"));
} catch (e) {
  usageExit(`cannot read manifest ${opts.wave}: ${e.message}`);
}
if (!Array.isArray(manifest.agents)) usageExit("wave.json must have an `agents` array");

const me = manifest.agents.find((a) => a.branch === opts.branch);
if (!me) usageExit(`branch ${opts.branch} not found in ${opts.wave}`);
const others = manifest.agents.filter((a) => a !== me);

let files;
if (opts.stdin) {
  files = readFileSync(0, "utf8").split("\n");
} else if (opts.pr) {
  files = execFileSync("gh", ["pr", "diff", opts.pr, "--name-only"], { encoding: "utf8" }).split("\n");
} else if (opts.base) {
  files = execFileSync("git", ["diff", "--name-only", `${opts.base}...HEAD`], { encoding: "utf8" }).split("\n");
} else {
  usageExit("provide one of --pr, --base, or --stdin");
}
files = files.map((f) => f.trim()).filter(Boolean);

const violations = [];
for (const file of files) {
  if (matches(file, me.forbidden)) {
    violations.push(`${file}: FORBIDDEN for ${me.branch}`);
    continue;
  }
  if (matches(file, me.owns)) continue; // explicitly owned — fine
  for (const other of others) {
    if (matches(file, other.owns)) {
      violations.push(`${file}: owned by ${other.branch}, changed by ${me.branch}`);
    }
  }
}

console.log(`wave-ownership: branch=${me.branch} files=${files.length}`);
if (violations.length === 0) {
  console.log("OK — no ownership violations.");
  process.exit(0);
}
console.error(`\n${violations.length} violation(s):`);
for (const v of violations) console.error(`  - ${v}`);
process.exit(1);
