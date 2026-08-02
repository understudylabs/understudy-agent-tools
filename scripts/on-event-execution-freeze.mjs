#!/usr/bin/env node
/**
 * Freeze + gate the synthetic on-event-execution fixture.
 *
 * This is an in-process gate only: it drives the shared offline environment and
 * never calls a model, provider, or network resource.
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
import {
  OEE_TASKS,
  oeeFixtureSha256,
  oeeSplitCounts,
  oeeSplitManifest,
  oeeSplitSha256,
  oeeScenarioSha256,
  oeeTaskBands,
  oeeTaskPool,
} from "../dist/workload-on-event-execution.js";

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

function discoverableText(task) {
  const readOnly = reset(task.taskId);
  const listings = READS.reduce((text, call) => text + step(readOnly.handle, call).obs.messages.at(-1).content, JSON.stringify(readOnly.obs.messages));
  const replay = reset(task.taskId);
  const transcript = task.oracle.reduce((text, call) => {
    const content = step(replay.handle, call).obs.messages.at(-1).content;
    return String(call.arguments.method ?? "").toUpperCase() === "PATCH" ? text : text + content;
  }, "");
  return listings + transcript;
}

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

function reachable(literal, text) {
  if (text.includes(literal)) return true;
  const parts = literal.split(/\s+/).filter((part) => part.length > 1);
  return parts.length > 1 && parts.every((part) => text.includes(part));
}

const failures = [];
const oracleScores = [];
const sentinelScores = [];

function payloadFromPrompt(task) {
  const line = task.prompt.split("\n").find((entry) => entry.startsWith("payload="));
  return line ? JSON.parse(line.slice("payload=".length)) : {};
}

/**
 * Checks the selector collisions this fixture can express: exact contact
 * identity, ticket subject, and draft/ticket subject lists. It does not prove
 * arbitrary natural-language selectors; it ensures every structured selector
 * in the event envelope has exactly one matching record.
 */
function checkDeterminability(task) {
  const payload = payloadFromPrompt(task);
  const failures = [];
  const contacts = Object.values(task.initialState.crm.contacts);
  const tickets = Object.values(task.initialState.support?.tickets ?? {});
  const drafts = Object.values(task.initialState.mail.drafts);
  if (typeof payload.contact_email === "string") {
    let matches = contacts.filter((contact) => contact.email === payload.contact_email);
    if (typeof payload.contact_name === "string") matches = matches.filter((contact) => contact.name === payload.contact_name);
    if (matches.length !== 1) failures.push(`contact selector matches ${matches.length} records`);
  }
  if (typeof payload.ticket_subject === "string") {
    const matches = tickets.filter((ticket) => ticket.subject === payload.ticket_subject);
    if (matches.length !== 1) failures.push(`ticket_subject selector matches ${matches.length} records`);
  }
  for (const subject of payload.draft_subjects ?? []) {
    const matches = drafts.filter((draft) => draft.subject === subject);
    if (matches.length !== 1) failures.push(`draft subject selector ${subject} matches ${matches.length} records`);
  }
  for (const subject of payload.ticket_subjects ?? []) {
    const matches = tickets.filter((ticket) => ticket.subject === subject);
    if (matches.length !== 1) failures.push(`ticket subject selector ${subject} matches ${matches.length} records`);
  }
  return failures;
}

for (const task of OEE_TASKS) {
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
  const leakage = auditObservationLeakage(reset(task.taskId).obs, task);
  if (leakage.length > 0) failures.push(`observation leakage on ${task.taskId}: ${leakage.join("; ")}`);
  for (const failure of checkDeterminability(task)) failures.push(`underdetermined selector on ${task.taskId}: ${failure}`);
}

const ids = new Set(OEE_TASKS.map((task) => task.taskId));
if (ids.size !== OEE_TASKS.length) failures.push("duplicate task ids in the OEE pool");
if (OEE_TASKS.some((task) => !task.taskId.startsWith("oee-"))) failures.push("OEE task id without oee- prefix");

const scenarioSignatures = new Map();
for (const task of OEE_TASKS) {
  const signature = oeeScenarioSha256(task);
  const prior = scenarioSignatures.get(signature);
  if (prior) failures.push(`duplicate scenario signature: ${prior} and ${task.taskId}`);
  scenarioSignatures.set(signature, task.taskId);
}
for (const task of OEE_TASKS) {
  const sameSignature = oeeScenarioSha256(task);
  for (const other of OEE_TASKS) {
    if (task.split !== other.split && sameSignature === oeeScenarioSha256(other)) {
      failures.push(`cross-split contamination: ${task.taskId} (${task.split}) matches ${other.taskId} (${other.split})`);
    }
  }
}

for (const task of OEE_TASKS) {
  const first = JSON.stringify(reset(task.taskId).obs);
  const second = JSON.stringify(reset(task.taskId).obs);
  if (first !== second) failures.push(`non-deterministic reset: ${task.taskId}`);
}

try {
  oeeTaskPool({ split: "holdout" });
  failures.push("holdout pool readable without the frozen hash");
} catch {
  /* expected */
}

const bands = oeeTaskBands();
const perBand = {};
for (const task of OEE_TASKS) {
  const slug = Object.keys(bands).find((candidate) => task.taskId.includes(`-${candidate}-`));
  const band = slug ? bands[slug] : "unknown";
  perBand[band] = (perBand[band] ?? 0) + 1;
}

const holdout = oeeTaskPool({ split: "holdout", frozenHoldoutSha256: oeeSplitSha256("holdout") });
const report = {
  fixture: oeeSplitManifest(),
  counts: oeeSplitCounts(),
  totals: { tasks: OEE_TASKS.length, holdout_tasks: holdout.length },
  per_band: perBand,
  gates: {
    oracle_mean: oracleScores.reduce((sum, value) => sum + value, 0) / oracleScores.length,
    sentinel_max: Math.max(...sentinelScores),
    failures,
  },
  fixture_sha256: oeeFixtureSha256(),
};

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`OEE tasks: ${OEE_TASKS.length} (train ${report.counts.train} / dev ${report.counts.dev} / holdout ${report.counts.holdout})`);
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
