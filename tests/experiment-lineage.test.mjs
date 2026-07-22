import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Everything is exercised through the compiled dist — the same anti-drift
// pattern as tests/benchmarks-mcp.test.mjs.
import {
  EXPERIMENT_SCHEMA,
  EXPERIMENT_STATUSES,
  EXPERIMENT_METHODS,
  EXPERIMENT_DECISIONS,
  appendExperiment,
  experimentsPath,
  latestExperiments,
  makeExperiment,
  readExperiments,
  validateExperiment,
} from "../dist/benchmark-artifacts.js";
import { createExperiment, listExperiments, loadEntryFromDir, queueOrCancelRun, updateExperiment } from "../dist/benchmark-hub-core.js";
import { callBenchmarksTool } from "../dist/benchmarks-mcp.js";
import { createRunRequest, readRunRequest, runRequestPath, validateRunRequestInput } from "../dist/run-executor.js";

const bin = path.resolve("dist/bin.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "experiment-lineage-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
delete process.env.BENCHMARK_HUB_DEMO;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = JSON.parse(fs.readFileSync(path.resolve("schemas/understudy.experiment.v1.schema.json"), "utf8"));

/* ---------------- fixtures ---------------- */

// A minimal VALID promoted benchmark dir (validateBenchmarkManifest must pass).
const benchDir = path.join(tmp, "bench");
fs.mkdirSync(benchDir, { recursive: true });
fs.writeFileSync(
  path.join(benchDir, "benchmark.json"),
  JSON.stringify({
    schema_version: "understudy.benchmark.v1",
    benchmark_id: "lineage-bench",
    name: "Lineage bench",
    provenance: { origin: "authored" },
    taxonomy: [{ category_id: "cat-a" }],
    tasks: [{ task_id: "t1", category_id: "cat-a", genesis: "synthesized", split: "holdout" }],
    environment: { format: "verifiers.v1", package_ref: "pkg" },
    verifier: { kind: "reward-fns", strict_metric: "strict" },
  }),
);
const entry = () => loadEntryFromDir(benchDir, "data-dir", "bench", false);
const slug = "data--bench";

// The und-289 shape.
const und289 = () => ({
  experiment_id: "und-289-sft",
  hypothesis: "Fireworks full-parameter SFT on qwen3-8b reaches >=90% exact L3 on the frozen holdout",
  data_selection: {
    selection_hash: "sel-abc123",
    source: "instacart shopper high-confidence CSV (5,377 rows post-dedup)",
    splits_sha256: "deadbeef",
  },
  training: {
    method: "sft",
    base_model: "qwen3-8b",
    provider: "fireworks",
    config: { max_context_length: 1024, epochs: 3 },
    cost_estimate: { short_prompt_usd: 3, fuse_usd: 25 },
    approvals: [{ gate: "consensus_audit", approved_by: "luis", at: "2026-07-21T00:00:00Z" }],
  },
});

/* ---------------- schema + codec ---------------- */

describe("understudy.experiment.v1 schema + codec", () => {
  it("makeExperiment fills stamp/defaults and satisfies the JSON schema's contract", () => {
    const exp = makeExperiment(und289());
    assert.equal(exp.schema_version, EXPERIMENT_SCHEMA);
    assert.equal(exp.status, "draft");
    assert.deepEqual(exp.eval_run_ids, []);
    assert.ok(exp.created_at);
    for (const key of schema.required) assert.ok(key in exp, `experiment is missing ${key}`);
    assert.deepEqual(schema.properties.status.enum, [...EXPERIMENT_STATUSES]);
    assert.deepEqual(schema.properties.training.properties.method.enum, [...EXPERIMENT_METHODS]);
    assert.deepEqual(schema.properties.verdict.properties.decision.enum, [...EXPERIMENT_DECISIONS]);
    assert.equal(schema.properties.schema_version.const, EXPERIMENT_SCHEMA);
    assert.deepEqual(validateExperiment(exp), []);
  });

  it("generates an experiment_id when omitted", () => {
    const { experiment_id, ...rest } = und289();
    const exp = makeExperiment(rest);
    assert.match(exp.experiment_id, /^exp-[0-9a-f]{12}$/);
  });

  it("validation rejects bad status, method, decision, approvals, and artifact shapes", () => {
    const base = makeExperiment(und289());
    assert.ok(validateExperiment({ ...base, status: "done" }).some((e) => e.includes("status")));
    assert.ok(validateExperiment({ ...base, training: { ...base.training, method: "dpo" } }).some((e) => e.includes("method")));
    assert.ok(validateExperiment({ ...base, verdict: { decision: "ship", summary: "s", decided_at: "t" } }).some((e) => e.includes("decision")));
    assert.ok(validateExperiment({ ...base, training: { ...base.training, approvals: [{ gate: "x" }] } }).some((e) => e.includes("approvals")));
    assert.ok(validateExperiment({ ...base, produced_artifact: { kind: "checkpoint" } }).some((e) => e.includes("produced_artifact")));
    assert.ok(validateExperiment({ ...base, data_selection: { source: "s" } }).some((e) => e.includes("selection_hash")));
    assert.throws(() => makeExperiment({ ...und289(), hypothesis: "" }), /invalid experiment/);
  });

  it("append is append-only and the newest line per experiment_id wins", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "codec-"));
    const first = makeExperiment(und289());
    appendExperiment(dir, first);
    appendExperiment(dir, { ...first, status: "training" });
    appendExperiment(dir, makeExperiment({ ...und289(), experiment_id: "other" }));
    const { experiments, skipped } = readExperiments(experimentsPath(dir));
    assert.equal(skipped, 0);
    assert.equal(experiments.length, 3);
    const latest = latestExperiments(experiments);
    assert.equal(latest["und-289-sft"].status, "training");
    assert.equal(latest["other"].status, "draft");
    assert.throws(() => appendExperiment(dir, { ...first, status: "nope" }), /invalid experiment/);
    // invalid appended lines (foreign writers) are dropped, never fatal
    fs.appendFileSync(experimentsPath(dir), '{"schema_version":"other"}\nnot json\n');
    const reread = readExperiments(experimentsPath(dir));
    assert.equal(reread.experiments.length, 3);
    assert.equal(reread.skipped, 1);
  });
});

/* ---------------- hub-core write ops ---------------- */

describe("createExperiment / updateExperiment / listExperiments", () => {
  it("creates, rejects duplicates, and supersedes with approval/eval-run append semantics", () => {
    const created = createExperiment(entry(), und289());
    assert.equal(created.ok, true);
    assert.equal(created.experiment.experiment_id, "und-289-sft");

    const dup = createExperiment(entry(), und289());
    assert.equal(dup.ok, false);
    assert.equal(dup.status, 409);

    const bad = createExperiment(entry(), { ...und289(), experiment_id: "bad", training: { method: "sft" } });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);

    const updated = updateExperiment(entry(), "und-289-sft", {
      status: "evaluating",
      created_at: "1999-01-01T00:00:00Z", // immutable — must be ignored
      training: { approvals: [{ gate: "provider_training_spend", approved_by: "luis", at: "2026-07-22T00:00:00Z" }] },
      produced_artifact: { kind: "checkpoint", ref: "fireworks/qwen3-8b-und289", sha256: "cafe" },
      eval_run_ids: ["run-1"],
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.experiment.status, "evaluating");
    assert.equal(updated.experiment.created_at, created.experiment.created_at);
    assert.deepEqual(updated.experiment.training.approvals.map((a) => a.gate), ["consensus_audit", "provider_training_spend"]);
    assert.equal(updated.experiment.training.base_model, "qwen3-8b"); // merged, not replaced
    assert.deepEqual(updated.experiment.eval_run_ids, ["run-1"]);

    const again = updateExperiment(entry(), "und-289-sft", { eval_run_ids: ["run-1", "run-2"] });
    assert.deepEqual(again.experiment.eval_run_ids, ["run-1", "run-2"]); // union, no dup

    assert.equal(updateExperiment(entry(), "nope", { status: "abandoned" }).status, 404);

    const listed = listExperiments(benchDir);
    assert.equal(listed.experiments.length, 1);
    assert.equal(listed.total_lines, 3); // create + 2 superseding updates
    assert.equal(listed.experiments[0].status, "evaluating");
  });
});

/* ---------------- MCP tools ---------------- */

describe("benchmarks MCP experiment tools", () => {
  it("create/update/list round-trip through callBenchmarksTool", () => {
    const created = callBenchmarksTool("create_experiment", {
      slug,
      experiment: { ...und289(), experiment_id: "mcp-exp" },
    });
    assert.equal(created.ok, true);

    const updated = callBenchmarksTool("update_experiment", {
      slug,
      experiment_id: "mcp-exp",
      patch: { status: "concluded", verdict: { decision: "collect", summary: "tail classes underrepresented", decided_at: "2026-07-22T01:00:00Z" } },
    });
    assert.equal(updated.experiment.verdict.decision, "collect");

    const listed = callBenchmarksTool("list_experiments", { slug });
    assert.deepEqual(listed.experiments.map((e) => e.experiment_id).sort(), ["mcp-exp", "und-289-sft"]);

    assert.throws(() => callBenchmarksTool("update_experiment", { slug, experiment_id: "ghost", patch: {} }), /unknown experiment_id/);
    assert.throws(
      () => callBenchmarksTool("create_experiment", { slug, experiment: { hypothesis: "x" } }),
      /invalid experiment/,
    );
  });

  it("read_benchmark additively surfaces experiment count + latest verdicts", () => {
    const out = callBenchmarksTool("read_benchmark", { slug });
    assert.equal(out.experiments.count, 2);
    const mcp = out.experiments.latest.find((e) => e.experiment_id === "mcp-exp");
    assert.equal(mcp.decision, "collect");
    assert.equal(mcp.status, "concluded");
  });
});

/* ---------------- run-request passthrough ---------------- */

describe("run_request experiment_id passthrough", () => {
  it("validateRunRequestInput accepts a well-formed id and rejects bad shapes", () => {
    const base = { benchmark_id: "b", models: ["m"], split: "all", tasks: "all", rollouts_per_task: 1 };
    assert.deepEqual(validateRunRequestInput({ ...base, experiment_id: "und-289-sft" }, []), []);
    assert.deepEqual(validateRunRequestInput(base, []), []); // absent = fine
    assert.ok(validateRunRequestInput({ ...base, experiment_id: "" }, []).some((e) => e.includes("experiment_id")));
    assert.ok(validateRunRequestInput({ ...base, experiment_id: "a b" }, []).some((e) => e.includes("experiment_id")));
    assert.ok(validateRunRequestInput({ ...base, experiment_id: 7 }, []).some((e) => e.includes("experiment_id")));
  });

  it("createRunRequest persists the field only when present (old shape otherwise)", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "runs-"));
    const withExp = createRunRequest(dir, { benchmark_id: "b", models: ["m"], split: "all", tasks: "all", rollouts_per_task: 1, experiment_id: "und-289-sft" });
    const persisted = readRunRequest(runRequestPath(dir, withExp.run_id));
    assert.equal(persisted.experiment_id, "und-289-sft");
    assert.ok(!("requires" in persisted), "provenance passthrough must not add a capability gate");
    const bare = createRunRequest(dir, { benchmark_id: "b", models: ["m"], split: "all", tasks: "all", rollouts_per_task: 1 });
    assert.ok(!("experiment_id" in readRunRequest(runRequestPath(dir, bare.run_id))));
  });

  it("queue_run cross-checks the experiment against experiments.jsonl", () => {
    const missing = queueOrCancelRun(entry(), { models: ["m"], tasks: "all", split: "all", rollouts_per_task: 1, experiment_id: "ghost" });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    const ok = queueOrCancelRun(entry(), { models: ["m"], tasks: "all", split: "all", rollouts_per_task: 1, experiment_id: "und-289-sft" });
    assert.equal(ok.ok, true);
    assert.equal(ok.run.experiment_id, "und-289-sft");
  });
});

/* ---------------- CLI round-trip ---------------- */

describe("understudy benchmarks experiment CLI", () => {
  const run = (...args) => spawnSync(process.execPath, [bin, "benchmarks", "experiment", ...args], { encoding: "utf8" });

  it("create/list/show/update round-trip JSON", () => {
    const cliDir = path.join(tmp, "cli-bench");
    fs.mkdirSync(cliDir, { recursive: true });
    fs.copyFileSync(path.join(benchDir, "benchmark.json"), path.join(cliDir, "benchmark.json"));

    const created = run("create", cliDir, "--input", JSON.stringify({ ...und289(), experiment_id: "cli-exp" }));
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).experiment_id, "cli-exp");

    const updated = run("update", cliDir, "cli-exp", "--input", JSON.stringify({ status: "training" }));
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(JSON.parse(updated.stdout).status, "training");

    const listed = run("list", cliDir);
    assert.equal(listed.status, 0, listed.stderr);
    const list = JSON.parse(listed.stdout);
    assert.equal(list.experiments.length, 1);
    assert.equal(list.total_lines, 2);

    const shown = run("show", cliDir, "cli-exp");
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).status, "training");

    const ghost = run("show", cliDir, "ghost");
    assert.notEqual(ghost.status, 0);

    const invalid = run("create", cliDir, "--input", JSON.stringify({ hypothesis: "no training block" }));
    assert.notEqual(invalid.status, 0);
  });
});
