import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compileTraceFoundry,
  importTraceReviews,
  promoteTraceBenchmark,
  regenerateEnvironment,
  stampTaskVersion,
  stampTaskVersions,
  maxBump,
} from "../dist/trace-foundry.js";
import { authorTasks } from "../dist/trace-author.js";
import { compileDatasetFoundry } from "../dist/dataset-foundry.js";

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA = /^[a-f0-9]{64}$/;

const capture = (id, ts, messages, response) => ({
  schema_version: 4, request_id: id, ts, workload_name: "synthetic-automation",
  customer_request_body: JSON.stringify({ system: "Operate a synthetic project board.", messages, tools: [{ name: "update-record", input_schema: { type: "object" } }] }),
  response_body: JSON.stringify(response), status_code: 200,
});

function buildBenchmark(root) {
  const source = join(root, "captures"), output = join(root, "bench");
  mkdirSync(source, { recursive: true });
  const rows = [
    capture("round-1", "2026-07-20T12:00:00Z", [{ role: "user", content: "Set synthetic record 7 active" }], { content: [{ type: "tool_use", id: "call-1", name: "update-record", input: { id: 7, status: "active" } }], stop_reason: "tool_use" }),
    capture("round-2", "2026-07-20T12:00:01Z", [{ role: "user", content: "Set synthetic record 7 active" }, { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "update-record", input: { id: 7, status: "active" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "{\"ok\":true}" }] }], { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" }),
  ];
  writeFileSync(join(source, "captures.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const result = compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  return { source, output, result };
}

const readTasks = (output) => readFileSync(join(output, "tasks.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

test("fresh build: every generated task is born-versioned at 1.0.0 with content hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-versioning-fresh-"));
  const { output, result } = buildBenchmark(root);
  const tasks = readTasks(output);
  assert.ok(tasks.length > 0);
  for (const task of tasks) {
    assert.equal(task.version, "1.0.0");
    assert.match(task.content_hashes.env_sha256, SHA);
    assert.match(task.content_hashes.verifier_sha256, SHA);
    assert.match(task.content_hashes.meta_sha256, SHA);
    assert.deepEqual(task.version_history, []);
    assert.equal(typeof task.environment_ref, "string");
  }
  // No bumps on a fresh build; manifest reports the (empty) bump set honestly.
  assert.deepEqual(result.versioning, { bumps: [] });
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.versioning, { bumps: [] });
  // Benchmark proposal is born-versioned too and carries per-task versions.
  const benchmark = JSON.parse(readFileSync(join(output, "benchmark.json"), "utf8"));
  assert.equal(benchmark.version, "1.0.0");
  for (const row of benchmark.tasks) {
    assert.equal(row.version, "1.0.0");
    assert.match(row.content_hashes.env_sha256, SHA);
  }
});

test("regenerate-env with a changed environment is a MAJOR bump; unchanged regenerate is none", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-versioning-regen-"));
  const { output } = buildBenchmark(root);
  // Identity regenerate: same package content => no bump, version stays.
  const same = regenerateEnvironment(output);
  assert.deepEqual(same.version_bumps, []);
  assert.ok(readTasks(output).every((task) => task.version === "1.0.0"));
  // Changed environment (guidance override lands in the served package).
  const guidance = join(root, "guidance.json");
  writeFileSync(guidance, JSON.stringify({ schema_version: "understudy.rejection_guidance.v1", tools: { "update-record": { "missing_required:id": "Provide the record id." } } }));
  const regen = regenerateEnvironment(output, { guidancePath: guidance });
  assert.ok(regen.version_bumps.length > 0);
  for (const bump of regen.version_bumps) assert.equal(bump.bump, "major");
  const tasks = readTasks(output);
  for (const task of tasks) {
    assert.equal(task.version, "2.0.0");
    assert.equal(task.version_history.length, 1);
    assert.equal(task.version_history[0].bump, "major");
    assert.equal(task.version_history[0].from, "1.0.0");
    assert.equal(task.version_history[0].to, "2.0.0");
  }
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.versioning.bumps.length, tasks.length);
});

test("meta-only change (title) is a PATCH; verifier change is MINOR; bookkeeping churn is none", () => {
  const base = { task_id: "task-x", title: "Old title", split: "construction", tool_surface: ["update-record"], outcome_contract: { required: [] }, status: "machine_proposed" };
  const born = { ...base };
  assert.equal(stampTaskVersion(born, null, new Date("2026-07-21T00:00:00Z")), null);
  assert.equal(born.version, "1.0.0");
  // Title-only re-author => patch.
  const retitled = { ...born, title: "New title" };
  const patch = stampTaskVersion(retitled, born, new Date("2026-07-21T00:00:01Z"));
  assert.equal(patch.bump, "patch");
  assert.equal(retitled.version, "1.0.1");
  assert.equal(retitled.version_history.at(-1).reason, "content change in meta");
  // Contract change => minor.
  const regraded = { ...retitled, outcome_contract: { required: [{ type: "state_effect", tool: "update-record" }] } };
  const minor = stampTaskVersion(regraded, retitled, new Date("2026-07-21T00:00:02Z"));
  assert.equal(minor.bump, "minor");
  assert.equal(regraded.version, "1.1.0");
  // Bookkeeping (status/self_check/task_hash) never bumps.
  const churned = { ...regraded, status: "needs_review", self_check: { ok: false }, task_hash: "deadbeef" };
  assert.equal(stampTaskVersion(churned, regraded, new Date()), null);
  assert.equal(churned.version, "1.1.0");
  assert.equal(maxBump([patch, minor]), "minor");
});

test("author-tasks over an existing benchmark bumps re-authored tasks (authored provenance => patch)", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-versioning-author-"));
  const { output } = buildBenchmark(root);
  const before = readTasks(output);
  assert.ok(before.every((task) => task.version === "1.0.0"));
  const client = async () => ({ content: JSON.stringify({}), usage: { prompt_tokens: 1, completion_tokens: 1 } });
  const run = await authorTasks(output, { model: "stub-model", client, now: new Date("2026-07-22T00:00:00Z") });
  assert.ok(Array.isArray(run.versioning.bumps));
  assert.ok(run.versioning.bumps.length > 0);
  const after = readTasks(output);
  for (const task of after.filter((t) => t.authored)) {
    assert.notEqual(task.version, "1.0.0");
    assert.match(task.version, SEMVER);
    assert.ok(task.version_history.length >= 1);
    // Authored provenance alone is meta => patch (contract merges would be minor).
    const last = task.version_history.at(-1);
    assert.ok(["patch", "minor"].includes(last.bump));
  }
});

test("dataset foundry tasks are born-versioned; promote stamps an initial versions.jsonl entry", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-versioning-dataset-"));
  const csv = join(root, "labels.csv");
  const rows = ["text,label"];
  for (let i = 0; i < 12; i += 1) rows.push(`synthetic example row number ${i} with distinct content,${i % 2 === 0 ? "alpha" : "beta"}`);
  writeFileSync(csv, rows.join("\n") + "\n");
  const output = join(root, "bench");
  const result = compileDatasetFoundry(csv, output, { now: new Date("2026-07-21T00:00:00Z") });
  assert.deepEqual(result.versioning, { bumps: [] });
  const tasks = readTasks(output);
  assert.ok(tasks.length > 0);
  for (const task of tasks) {
    assert.equal(task.version, "1.0.0");
    assert.match(task.content_hashes.env_sha256, SHA);
  }
  // Recompile into the same dir: identical content => still 1.0.0, no bumps.
  const again = compileDatasetFoundry(csv, output, { now: new Date("2026-07-22T00:00:00Z") });
  assert.deepEqual(again.versioning, { bumps: [] });
  assert.ok(readTasks(output).every((task) => task.version === "1.0.0"));
  // Promote: accept every task, then the initial versions.jsonl line appears once.
  const reviews = join(root, "reviews.jsonl");
  writeFileSync(reviews, tasks.map((task) => JSON.stringify({ task_id: task.task_id, decision: "accept" })).join("\n") + "\n");
  importTraceReviews(output, reviews);
  const promoted = promoteTraceBenchmark(output, { now: new Date("2026-07-23T00:00:00Z"), promotedBy: "test" });
  assert.equal(promoted.versions_log_initialized, true);
  const lines = readFileSync(join(output, "versions.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].schema_version, "understudy.benchmark_version.v1");
  assert.equal(lines[0].version, "1.0.0");
  assert.equal(typeof lines[0].created_at, "string");
  assert.deepEqual(lines[0].task_bumps, []);
  const benchmark = JSON.parse(readFileSync(join(output, "benchmark.json"), "utf8"));
  assert.equal(benchmark.version, "1.0.0");
  assert.ok(existsSync(join(output, "promotion-record.json")));
});

test("stampTaskVersions matches priors by task_id and reports only real bumps", () => {
  const prior = [
    { task_id: "a", title: "A", version: "1.0.0", content_hashes: null },
    { task_id: "b", title: "B" },
  ];
  // Stamp priors first so they carry real hashes.
  stampTaskVersions(prior, [], new Date("2026-07-21T00:00:00Z"));
  const next = [
    { task_id: "a", title: "A" }, // unchanged => no bump
    { task_id: "b", title: "B", outcome_contract: { required: [{ type: "read_obligation", tool: "get" }] } }, // verifier => minor
    { task_id: "c", title: "C" }, // new task => born 1.0.0, no bump entry
  ];
  const bumps = stampTaskVersions(next, prior, new Date("2026-07-22T00:00:00Z"));
  assert.deepEqual(bumps.map((b) => [b.task_id, b.bump]), [["b", "minor"]]);
  assert.equal(next[0].version, "1.0.0");
  assert.equal(next[1].version, "1.1.0");
  assert.equal(next[2].version, "1.0.0");
});
