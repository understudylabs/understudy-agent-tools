#!/usr/bin/env node
/**
 * Freeze + gate the AutomationBench v2 offline fixture.
 *
 * Runs every protocol gate over the full v2 pool (v1 tasks plus the eight hard
 * families) and prints the frozen split contract. Nothing here calls a model,
 * a provider, or the network: it drives the in-process offline environment.
 *
 * Gates (all must pass before any model call is made against v2):
 *   oracle       every task's scripted oracle scores exactly 1.0
 *   sentinel     the activity-only reward-hacking policy scores exactly 0.0
 *   leakage      no observation exposes a grader key, assertion path, or allowed write
 *   reachability every literal the oracle writes is present in the prompt or a read-only listing
 *   integrity    unique ids, no task pre-satisfied at reset, guard contact never writable
 *
 * Usage:
 *   node scripts/automationbench-v2-freeze.mjs [--json] [--out <path>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  GUARD_CONTACT,
  assertionPath,
  assertionSatisfied,
  auditObservationLeakage,
  oraclePolicy,
  reset,
  rollout,
  sentinelPolicy,
  step,
} from "../dist/automationbench-offline.js";
import { HARD_TASKS, V2_TASKS, v2SplitCounts, v2SplitManifest, v2TaskBands, v2TaskPool, v2FixtureSha256, v2SplitSha256 } from "../dist/automationbench-v2.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const outIndex = args.indexOf("--out");
const outPath = outIndex === -1 ? null : args[outIndex + 1];

const READS = [
  { name: "api_search", arguments: { query: "crm contacts mail drafts messages support tickets" } },
  { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } },
  { name: "api_fetch", arguments: { method: "GET", url: "/mail/drafts" } },
  { name: "api_fetch", arguments: { method: "GET", url: "/mail/messages" } },
  { name: "api_fetch", arguments: { method: "GET", url: "/support/tickets" } },
];

/**
 * Everything a correct policy can read: the prompt, the read-only listings, and
 * the responses its own gold calls return (ids minted by a POST are only
 * knowable that way, and knowing them is not label leakage).
 */
function discoverableText(task) {
  const readOnly = reset(task.taskId);
  const listings = READS.reduce((text, call) => text + step(readOnly.handle, call).obs.messages.at(-1).content, JSON.stringify(readOnly.obs.messages));
  const replay = reset(task.taskId);
  // PATCH responses echo the value just written, so they are excluded: only the
  // ids a POST mints count as newly discovered.
  const transcript = task.oracle.reduce((text, call) => {
    const content = step(replay.handle, call).obs.messages.at(-1).content;
    return String(call.arguments.method ?? "").toUpperCase() === "PATCH" ? text : text + content;
  }, "");
  return listings + transcript;
}

/** Literals the gold action sequence must supply: record ids in the path plus every string in the body. */
function goldLiterals(task) {
  const literals = new Set();
  for (const call of task.oracle) {
    const args = call.arguments;
    if (typeof args.url === "string") {
      const segments = args.url.split("/").filter(Boolean);
      if (segments.length > 2) literals.add(segments[2]);
    }
    for (const value of Object.values(args.body ?? {})) if (typeof value === "string") literals.add(value);
  }
  return [...literals];
}

/**
 * A literal is reachable when the observation carries it verbatim, or when the
 * task asks for a value COMPOSED from observed pieces (the derived-subject
 * family) and every piece is itself observed.
 */
function reachable(literal, text) {
  if (text.includes(literal)) return true;
  const parts = literal.split(/\s+/).filter((part) => part.length > 1);
  return parts.length > 1 && parts.every((part) => text.includes(part));
}

const failures = [];
const oracleScores = [];
const sentinelScores = [];

for (const task of V2_TASKS) {
  const oracle = rollout(task.taskId, oraclePolicy(task.taskId));
  oracleScores.push(oracle.reward);
  if (oracle.reward !== 1) failures.push(`oracle scored ${oracle.reward} on ${task.taskId} (forbidden: ${oracle.forbiddenEffects.join(",") || "none"})`);
  if (oracle.leakage.length > 0) failures.push(`leakage on ${task.taskId}: ${oracle.leakage.join("; ")}`);

  const sentinel = rollout(task.taskId, sentinelPolicy());
  sentinelScores.push(sentinel.reward);
  if (sentinel.reward !== 0) failures.push(`sentinel scored ${sentinel.reward} on ${task.taskId}`);

  if (task.assertions.every((assertion) => assertionSatisfied(task.initialState, assertion))) failures.push(`task pre-satisfied at reset: ${task.taskId}`);
  if (task.allowedWrites.some((write) => write.includes(`contacts.${GUARD_CONTACT.id}`))) failures.push(`task may write the guard contact: ${task.taskId}`);

  const text = discoverableText(task);
  for (const literal of goldLiterals(task)) {
    if (!reachable(literal, text)) failures.push(`unreachable literal on ${task.taskId}: ${literal}`);
  }
  for (const assertion of task.assertions) {
    if (task.prompt.includes(assertionPath(assertion))) failures.push(`prompt restates assertion path on ${task.taskId}`);
  }
}

// Email uniqueness: only the duplicate-merge family may seed two contacts on one address.
for (const task of HARD_TASKS) {
  if (task.taskId.includes("duplicate-merge")) continue;
  const emails = Object.values(task.initialState.crm.contacts).map((contact) => contact.email);
  if (new Set(emails).size !== emails.length) failures.push(`duplicate contact email in ${task.taskId}`);
}

const ids = new Set(V2_TASKS.map((task) => task.taskId));
if (ids.size !== V2_TASKS.length) failures.push("duplicate task ids in the v2 pool");

// Determinism: two resets of the same task must be byte-identical.
for (const task of HARD_TASKS.slice(0, 12)) {
  const a = JSON.stringify(reset(task.taskId).obs);
  const b = JSON.stringify(reset(task.taskId).obs);
  if (a !== b) failures.push(`non-deterministic reset: ${task.taskId}`);
}

// Frozen-holdout refusal must fail closed.
try {
  v2TaskPool({ split: "holdout" });
  failures.push("holdout pool readable without the frozen hash");
} catch {
  /* expected */
}

const bands = v2TaskBands();
const bandOf = (taskId) => bands[Object.keys(bands).find((slug) => taskId.includes(`-${slug}-`)) ?? ""] ?? "unknown";
const perBand = {};
for (const task of V2_TASKS) {
  const band = bandOf(task.taskId);
  perBand[band] = (perBand[band] ?? 0) + 1;
}

const holdout = v2TaskPool({ split: "holdout", frozenHoldoutSha256: v2SplitSha256("holdout") });
const report = {
  fixture: v2SplitManifest(),
  counts: v2SplitCounts(),
  totals: { tasks: V2_TASKS.length, hard_tasks: HARD_TASKS.length, holdout_tasks: holdout.length },
  per_band: perBand,
  gates: {
    oracle_mean: oracleScores.reduce((sum, value) => sum + value, 0) / oracleScores.length,
    sentinel_max: Math.max(...sentinelScores),
    failures,
  },
  fixture_sha256: v2FixtureSha256(),
};

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`v2 tasks: ${V2_TASKS.length} (train ${report.counts.train} / dev ${report.counts.dev} / holdout ${report.counts.holdout})`);
  console.log(`fixture_sha256 : ${report.fixture.fixture_sha256}`);
  console.log(`train_sha256   : ${report.fixture.train_sha256}`);
  console.log(`dev_sha256     : ${report.fixture.dev_sha256}`);
  console.log(`holdout_sha256 : ${report.fixture.holdout_sha256}`);
  console.log(`splits_sha256  : ${report.fixture.splits_sha256}`);
  console.log(`oracle mean    : ${report.gates.oracle_mean.toFixed(4)}   sentinel max: ${report.gates.sentinel_max}`);
  console.log(`per-band       : ${JSON.stringify(perBand)}`);
}

if (failures.length > 0) {
  console.error(`\nGATE FAILURES (${failures.length}):`);
  for (const failure of failures.slice(0, 40)) console.error(`  - ${failure}`);
  process.exit(1);
}
