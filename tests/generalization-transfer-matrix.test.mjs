import assert from "node:assert/strict";
import { test } from "node:test";
import { splitSha256 as automationHoldout } from "../dist/automationbench-offline.js";
import { scoreCompletion, TASKS as eventTasks } from "../dist/event-categorizer-offline.js";
import { BudgetLedger, parseAction, runModelRows } from "../dist/generalization-model-runner.js";
import { groupAAdapter } from "../dist/generalization-group-adapters.js";
import { deriveGeneralizationReport } from "../dist/generalization.js";

test("AutomationBench frozen holdout hash is pinned", () => {
  assert.equal(
    automationHoldout("holdout"),
    "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701",
  );
});

test("per-group frozen hash mismatch is a hard error", () => {
  const manifest = {
    schema_version: "understudy.generalization_manifest.v1",
    frozen_split_sha256: "manifest",
    groups: [{ group_id: "g", frozen_split_sha256: "group", match: { task_id_prefix: "g-" } }],
    arms: [{ arm_id: "a", train_groups: [], baseline: { rows: "b" }, candidate: { rows: "c" } }],
  };
  const row = { run_id: "r", task_id: "g-1", split: "holdout", score: 0, status: "ok", provenance: { split_sha256: "manifest" } };
  assert.throws(() => deriveGeneralizationReport(manifest, { a: { baseline: [row], candidate: [row] } }), /expected frozen hash group/);
});

test("required content hashes and coverage counts are enforced", () => {
  const base = {
    schema_version: "understudy.generalization_manifest.v1",
    frozen_split_sha256: "frozen",
    require_content_hashes: true,
    require_all_groups_scored: true,
    groups: [{ group_id: "g", expected_task_counts: { holdout: 1 }, match: { task_id_prefix: "g-" } }],
    arms: [{ arm_id: "a", train_groups: [], baseline: { rows: "b" }, candidate: { rows: "c" } }],
  };
  const missing = { run_id: "r", task_id: "g-1", split: "holdout", score: 0, status: "ok", provenance: { split_sha256: "frozen" } };
  assert.throws(() => deriveGeneralizationReport(base, { a: { baseline: [missing], candidate: [missing] } }), /missing required task content hashes/);
  const complete = {
    ...missing,
    provenance: { split_sha256: "frozen", task_content_hashes: { env_sha256: "e", verifier_sha256: "v" } },
  };
  assert.throws(() => deriveGeneralizationReport(base, { a: { baseline: [complete], candidate: [] } }), /coverage mismatch/);
  const extra = { ...complete, task_id: "g-2" };
  assert.throws(() => deriveGeneralizationReport(base, { a: { baseline: [complete, extra], candidate: [complete, extra] } }), /expected 1 holdout task rows/);
});

test("event categorizer scores gold and malformed completions", () => {
  const task = eventTasks[0];
  assert.equal(scoreCompletion(task.task_id, [{ role: "assistant", content: JSON.stringify(task.gold) }]).score, 1);
  const malformed = scoreCompletion(task.task_id, [{ role: "assistant", content: "not json" }]);
  assert.equal(malformed.score, 0);
  assert.equal(malformed.subscores.structured_output_ok, 0);
});

test("model runner emits rows and enforces its budget with a stub transport", async () => {
  const transport = async () => ({
    content: JSON.stringify({ tool: "finish" }),
    usage: { prompt: 100, completion: 100 },
    status: 200,
  });
  const rows = await runModelRows({
    adapter: groupAAdapter(),
    split: "dev",
    runId: "stub",
    model: "stub",
    provider: "fireworks",
    price: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
    budget: new BudgetLedger(1),
    transport,
  });
  assert.equal(rows.length, 12);
  assert.equal(rows[0].schema_version, "understudy.eval_result.v1");
  assert.equal(rows[0].route, "fireworks-openai-compat");
  await assert.rejects(
    () => runModelRows({
      adapter: groupAAdapter(),
      split: "dev",
      runId: "too-small",
      model: "stub",
      provider: "fireworks",
      price: { inputUsdPerMillion: 10_000, outputUsdPerMillion: 10_000 },
      budget: new BudgetLedger(0.001),
      transport,
    }),
    /budget exceeded/,
  );
});

test("model action parser extracts embedded JSON and repairs only after a second failure", () => {
  assert.deepEqual(parseAction('I will act now: {"tool":"finish"}'), { tool: "finish", arguments: {} });
  assert.deepEqual(parseAction('```json\n{"tool":"api_fetch","arguments":{"method":"GET","url":"/x","body":{}}}\n```'), {
    tool: "api_fetch", arguments: { method: "GET", url: "/x", body: {} },
  });
  assert.equal(parseAction("empty response"), null);
});

test("model runner takes one corrective turn after malformed JSON", async () => {
  const base = groupAAdapter();
  const adapter = { ...base, taskIds: (options) => base.taskIds(options).slice(0, 1) };
  let calls = 0;
  const rows = await runModelRows({
    adapter,
    split: "dev",
    runId: "repair",
    model: "stub",
    provider: "fireworks",
    price: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
    budget: new BudgetLedger(1),
    transport: async () => {
      calls += 1;
      return {
        content: calls === 1 ? "not json" : JSON.stringify({ tool: "finish" }),
        usage: { prompt: 1, completion: 1 },
        status: 200,
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(rows[0].subscores.parse_failures, 1);
});

test("per-arm scores exclude mechanism demos from the aggregate", () => {
  const content = { env_sha256: "e", verifier_sha256: "v" };
  const row = (task_id, score) => ({
    run_id: "r", task_id, split: "holdout", score, status: "ok",
    benchmark_id: "b", provenance: { split_sha256: "frozen", task_content_hashes: content },
  });
  const manifest = {
    schema_version: "understudy.generalization_manifest.v1",
    frozen_split_sha256: "frozen",
    groups: [
      { group_id: "g", expected_task_counts: { holdout: 1 }, frozen_split_sha256: "frozen", match: { benchmark_id: "b" } },
    ],
    arms: [
      { arm_id: "model", train_groups: [], eval_splits: ["holdout"], baseline: { rows: "b" }, candidate: { rows: "c" } },
      { arm_id: "demo", train_groups: ["g"], eval_splits: ["holdout"], mechanism_demo: true, exclude_from_score: true, baseline: { rows: "b" }, candidate: { rows: "c" } },
    ],
  };
  const report = deriveGeneralizationReport(manifest, {
    model: { baseline: [row("t", 0)], candidate: [row("t", 0.2)] },
    demo: { baseline: [row("t", 0)], candidate: [row("t", 1)] },
  });
  assert.equal(report.arms.find((arm) => arm.arm_id === "demo").score.in_domain_gain, 1);
  assert.equal(report.score.in_domain_gain, null);
});

test("arm eval_splits gate rejects undeclared and incomplete splits", () => {
  const content = { env_sha256: "e", verifier_sha256: "v" };
  const row = (task_id, split) => ({
    run_id: "r", task_id, split, score: 0, status: "ok", benchmark_id: "b",
    provenance: { split_sha256: split === "holdout" ? "frozen" : "devhash", task_content_hashes: content },
  });
  const base = {
    schema_version: "understudy.generalization_manifest.v1", frozen_split_sha256: "frozen",
    groups: [{ group_id: "g", expected_task_counts: { dev: 1, holdout: 1 }, frozen_split_sha256: "frozen", match: { benchmark_id: "b" } }],
    arms: [{ arm_id: "a", train_groups: [], eval_splits: ["dev", "holdout"], baseline: { rows: "b" }, candidate: { rows: "c" } }],
  };
  assert.throws(() => deriveGeneralizationReport(base, {
    a: { baseline: [row("t", "dev"), row("t", "holdout")], candidate: [row("t", "dev")] },
  }), /coverage mismatch|expected 1 holdout/);
  assert.throws(() => deriveGeneralizationReport(base, {
    a: { baseline: [row("t", "train")], candidate: [row("t", "train")] },
  }), /undeclared split/);
});
