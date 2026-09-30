import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildStrataPlan,
  CohortStrataPlanSchema,
  DEFAULT_STRATA_SEED,
  planIdentity,
} from "../dist/evals/cohort-strata.js";

const cli = ["node", resolve("dist/bin.js")];
const NOW = new Date("2026-09-05T12:00:00.000Z");
const sha = (value) => createHash("sha256").update(value).digest("hex");

function indexRow(overrides) {
  return {
    schema_version: "understudy.eval-execution-index-row.v1",
    source_status: "included",
    execution_group: "execution-1",
    lineage_status: "complete",
    capture_count: 1,
    source_files: [{ local_path: "source/traces/one.jsonl", content_sha256: sha("one") }],
    task_id: "task-1",
    exclusion_reasons: [],
    ...overrides,
  };
}

function taskRow(overrides) {
  return {
    schema_version: "understudy.benchmark_task.v1",
    task_id: "task-1",
    execution_group: "execution-1",
    // Payload-derived on purpose: the stratifier must never surface this.
    title: "SECRET_PROMPT_LEAK summarize the customer invoice",
    tool_surface: ["read-file"],
    machine_confidence: "high",
    ...overrides,
  };
}

/**
 * Synthetic tool workflow per issue #281: simple single-turn reads, a
 * multi-turn read→write, a longer write, an error/recovery case (ambiguous
 * lineage), an unlinked trace, a taskless execution, and a rare
 * high-consequence case tagged by a human.
 */
function buildFoundry(root, { extraIndexRows = [], extraTaskRows = [] } = {}) {
  const dir = join(root, "foundry");
  mkdirSync(dir, { recursive: true });
  const indexRows = [
    indexRow({ execution_group: "e-simple-1", task_id: "t-1" }),
    indexRow({ execution_group: "e-simple-2", task_id: "t-2" }),
    indexRow({ execution_group: "e-simple-3", task_id: "t-3" }),
    indexRow({ execution_group: "e-simple-4", task_id: "t-4" }),
    indexRow({ execution_group: "e-write-short", task_id: "t-5", capture_count: 4 }),
    indexRow({ execution_group: "e-write-long", task_id: "t-6", capture_count: 7 }),
    indexRow({ execution_group: "e-recovery", task_id: "t-7", lineage_status: "ambiguous", exclusion_reasons: ["ambiguous_parent"] }),
    indexRow({ execution_group: "e-unlinked", task_id: null, lineage_status: "unlinked", exclusion_reasons: ["missing_valid_trace_context"] }),
    indexRow({ execution_group: "e-taskless", task_id: null }),
    indexRow({ execution_group: "e-excluded-source", source_status: "excluded", task_id: null, execution_group: null }),
    indexRow({ execution_group: "e-rare-billing", task_id: "t-8", capture_count: 2 }),
    ...extraIndexRows,
  ];
  const taskRows = [
    taskRow({ task_id: "t-1", execution_group: "e-simple-1" }),
    taskRow({ task_id: "t-2", execution_group: "e-simple-2" }),
    taskRow({ task_id: "t-3", execution_group: "e-simple-3" }),
    taskRow({ task_id: "t-4", execution_group: "e-simple-4" }),
    taskRow({ task_id: "t-5", execution_group: "e-write-short", tool_surface: ["read-file", "write-report"], machine_confidence: "medium" }),
    taskRow({ task_id: "t-6", execution_group: "e-write-long", tool_surface: ["read-file", "update-task", "write-file"], machine_confidence: "low" }),
    taskRow({ task_id: "t-7", execution_group: "e-recovery" }),
    taskRow({ task_id: "t-8", execution_group: "e-rare-billing", machine_confidence: "medium" }),
    ...extraTaskRows,
  ];
  const executionIndex = join(dir, "execution-index.jsonl");
  const tasks = join(dir, "tasks.jsonl");
  writeFileSync(executionIndex, `${indexRows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  writeFileSync(tasks, `${taskRows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  return { dir, executionIndex, tasks };
}

const basePlanOptions = {
  seed: DEFAULT_STRATA_SEED,
  axes: ["outcome", "mode", "turns", "confidence", "tag"],
  targetPerStratum: 2,
  rareThreshold: 3,
  tags: { "e-rare-billing": ["consequence:billing-mutation"] },
  highConsequenceTags: ["consequence:billing-mutation"],
  now: NOW,
};

test("stratify derives execution strata and selects toward per-stratum targets", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-cohort-strata-"));
  try {
    const { executionIndex, tasks } = buildFoundry(root);
    const plan = buildStrataPlan({ executionIndexPath: executionIndex, tasksPath: tasks, planOptions: basePlanOptions });
    CohortStrataPlanSchema.parse(plan);

    assert.equal(plan.pool.eligible, 7);
    const excluded = Object.fromEntries(plan.pool.excluded.map((entry) => [entry.reason, entry.count]));
    assert.deepEqual(excluded, { lineage_ambiguous: 1, lineage_unlinked: 1, missing_task: 1, source_excluded: 1 });

    const byLabel = new Map(plan.strata.map((stratum) => [`${stratum.axis}:${stratum.value}`, stratum]));
    // Terminal outcome stratum exists for every eligible execution.
    assert.equal(byLabel.get("outcome:complete").available, 7);
    // Write vs no-op comes from the foundry's own mutating-tool classifier.
    assert.equal(byLabel.get("mode:write").available, 2);
    assert.equal(byLabel.get("mode:read-only").available, 5);
    // Turn buckets from capture counts.
    assert.equal(byLabel.get("turns:single").available, 4);
    assert.equal(byLabel.get("turns:short").available, 2);
    assert.equal(byLabel.get("turns:long").available, 1);
    // Human-guided tag, never inferred.
    const tag = byLabel.get("tag:consequence:billing-mutation");
    assert.equal(tag.available, 1);
    assert.equal(tag.rule, "saturated_high_consequence");
    assert.equal(tag.selected, 1);
    // Rare strata are saturated: minimums, never caps.
    assert.equal(byLabel.get("turns:long").rule, "saturated_rare");
    assert.equal(byLabel.get("turns:long").selected, 1);

    const groups = plan.selection.map((entry) => entry.execution_group);
    assert.ok(groups.includes("e-rare-billing"), "high-consequence execution must always be selected");
    assert.ok(groups.includes("e-write-long"), "rare stratum member must be saturated in");
    for (const entry of plan.selection) {
      assert.ok(entry.task_id, "every selected execution must be judgeable (have a task)");
      assert.ok(entry.strata.length > 0);
      assert.equal(entry.frozen, false);
    }
    assert.equal(plan.expansion_of, null);
    assert.equal(plan.stability.status, "not_applicable");
    assert.deepEqual(plan.privacy, { local_only: true, payload_fields_read: false, upload_performed: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stratify plans are byte-identical for the same seed and inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-cohort-strata-determinism-"));
  try {
    const { executionIndex, tasks } = buildFoundry(root);
    const one = buildStrataPlan({ executionIndexPath: executionIndex, tasksPath: tasks, planOptions: basePlanOptions });
    const two = buildStrataPlan({ executionIndexPath: executionIndex, tasksPath: tasks, planOptions: basePlanOptions });
    assert.equal(JSON.stringify(one), JSON.stringify(two));
    const other = buildStrataPlan({
      executionIndexPath: executionIndex,
      tasksPath: tasks,
      planOptions: { ...basePlanOptions, seed: "other-seed" },
    });
    assert.equal(other.selection.length > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stratify treats pilot sizes as minimums, never caps", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-cohort-strata-minimums-"));
  try {
    const { executionIndex, tasks } = buildFoundry(root);
    // Target of 1 per stratum, yet the 2-execution write stratum is rare
    // (<= threshold 3) and both members must be included.
    const plan = buildStrataPlan({
      executionIndexPath: executionIndex,
      tasksPath: tasks,
      planOptions: { ...basePlanOptions, targetPerStratum: 1 },
    });
    const write = plan.strata.find((stratum) => `${stratum.axis}:${stratum.value}` === "mode:write");
    assert.equal(write.available, 2);
    assert.equal(write.selected, 2);
    assert.equal(write.rule, "saturated_rare");
    const groups = plan.selection.map((entry) => entry.execution_group);
    assert.ok(groups.includes("e-write-short"));
    assert.ok(groups.includes("e-write-long"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stratify keeps payloads out of the plan artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-cohort-strata-redaction-"));
  try {
    const { executionIndex, tasks } = buildFoundry(root);
    const plan = buildStrataPlan({ executionIndexPath: executionIndex, tasksPath: tasks, planOptions: basePlanOptions });
    const serialized = JSON.stringify(plan);
    assert.ok(!serialized.includes("SECRET_PROMPT_LEAK"), "task titles are payload-derived and must not leak");
    assert.ok(!serialized.includes("customer invoice"), "task payloads must not leak");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stratify expansion preserves frozen selections and reports stability", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-cohort-strata-expand-"));
  try {
    const { executionIndex, tasks } = buildFoundry(root);
    const prior = buildStrataPlan({ executionIndexPath: executionIndex, tasksPath: tasks, planOptions: basePlanOptions });

    // Grow the pool with two same-shape executions: prevalence of every
    // stratum stays within tolerance, so the increment reports stable.
    const extra = ["e-new-1", "e-new-2"].map((group, index) =>
      indexRow({ execution_group: group, task_id: `t-new-${index}` }),
    );
    const extraTasks = ["e-new-1", "e-new-2"].map((group, index) =>
      taskRow({ task_id: `t-new-${index}`, execution_group: group }),
    );
    const grownIndex = join(root, "grown-execution-index.jsonl");
    const grownTasks = join(root, "grown-tasks.jsonl");
    const priorIndexRows = readFileSync(executionIndex, "utf8").trim().split("\n");
    writeFileSync(grownIndex, `${[...priorIndexRows, ...extra.map((row) => JSON.stringify(row))].join("\n")}\n`, { mode: 0o600 });
    const priorTaskRows = readFileSync(tasks, "utf8").trim().split("\n");
    writeFileSync(grownTasks, `${[...priorTaskRows, ...extraTasks.map((row) => JSON.stringify(row))].join("\n")}\n`, { mode: 0o600 });

    const expanded = buildStrataPlan({
      executionIndexPath: grownIndex,
      tasksPath: grownTasks,
      priorPlan: prior,
      tolerance: 0.1,
      planOptions: basePlanOptions,
    });

    const priorGroups = prior.selection.map((entry) => entry.execution_group);
    const expandedByGroup = new Map(expanded.selection.map((entry) => [entry.execution_group, entry]));
    for (const group of priorGroups) {
      assert.ok(expandedByGroup.has(group), `frozen selection ${group} must survive expansion`);
      assert.equal(expandedByGroup.get(group).frozen, true);
    }
    assert.equal(expanded.expansion_of, planIdentity(prior));
    assert.equal(expanded.stability.status, "stable");
    assert.deepEqual(expanded.stability.moved, []);

    // Expanding with a different seed is rejected: frozen selections would reorder.
    assert.throws(() => buildStrataPlan({
      executionIndexPath: grownIndex,
      tasksPath: grownTasks,
      priorPlan: prior,
      planOptions: { ...basePlanOptions, seed: "other-seed" },
    }), /different seed/);
    // Expanding with different axes is rejected instead of silently mutating.
    assert.throws(() => buildStrataPlan({
      executionIndexPath: grownIndex,
      tasksPath: grownTasks,
      priorPlan: prior,
      planOptions: { ...basePlanOptions, axes: ["outcome"] },
    }), /different axes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stratify expansion reports unstable materials when the batch shifts stratum prevalence", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-cohort-strata-unstable-"));
  try {
    // Start with a tiny balanced pool: one read-only, one write execution.
    const smallIndex = join(root, "small-index.jsonl");
    const smallTasks = join(root, "small-tasks.jsonl");
    writeFileSync(smallIndex, [
      JSON.stringify(indexRow({ execution_group: "e-simple-1", task_id: "t-1" })),
      JSON.stringify(indexRow({ execution_group: "e-write-long", task_id: "t-6", capture_count: 7 })),
    ].join("\n") + "\n", { mode: 0o600 });
    writeFileSync(smallTasks, [
      JSON.stringify(taskRow({ task_id: "t-1", execution_group: "e-simple-1" })),
      JSON.stringify(taskRow({ task_id: "t-6", execution_group: "e-write-long", tool_surface: ["update-task"], machine_confidence: "low" })),
    ].join("\n") + "\n", { mode: 0o600 });

    const prior = buildStrataPlan({
      executionIndexPath: smallIndex,
      tasksPath: smallTasks,
      planOptions: { ...basePlanOptions, targetPerStratum: 3 },
    });
    // Then expand with a read-only-heavy batch: the eligible pool's
    // composition shifts hard (read-only prevalence 0.5 → 0.83), which is
    // material movement past the declared tolerance.
    const extra = ["e-new-1", "e-new-2", "e-new-3", "e-new-4"].map((group, index) =>
      JSON.stringify(indexRow({ execution_group: group, task_id: `t-new-${index}` })),
    );
    const grownIndex = join(root, "grown-index.jsonl");
    writeFileSync(grownIndex, readFileSync(smallIndex, "utf8") + extra.join("\n") + "\n", { mode: 0o600 });
    const extraTasks = ["e-new-1", "e-new-2", "e-new-3", "e-new-4"].map((group, index) =>
      JSON.stringify(taskRow({ task_id: `t-new-${index}`, execution_group: group })),
    );
    const grownTasks = join(root, "grown-tasks.jsonl");
    writeFileSync(grownTasks, readFileSync(smallTasks, "utf8") + extraTasks.join("\n") + "\n", { mode: 0o600 });

    const expanded = buildStrataPlan({
      executionIndexPath: grownIndex,
      tasksPath: grownTasks,
      priorPlan: prior,
      tolerance: 0.05,
      planOptions: { ...basePlanOptions, targetPerStratum: 3 },
    });
    assert.equal(expanded.stability.status, "unstable");
    assert.ok(expanded.stability.moved.some((move) => move.axis === "mode" && move.value === "read-only"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stratify flags underfilled rare strata as blocking readiness", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-cohort-strata-blocking-"));
  try {
    const { executionIndex, tasks } = buildFoundry(root);
    // Target 4 but the high-consequence tag stratum only has 1 execution:
    // selection saturates it, yet the shortfall stays machine-readable.
    const plan = buildStrataPlan({
      executionIndexPath: executionIndex,
      tasksPath: tasks,
      planOptions: { ...basePlanOptions, targetPerStratum: 4, rareThreshold: 1 },
    });
    assert.equal(plan.ready, false);
    assert.ok(plan.blocking.some((reason) => reason.includes("consequence:billing-mutation")));
    const underfilled = plan.coverage.underfilled_strata.map((entry) => `${entry.axis}:${entry.value}`);
    assert.ok(underfilled.includes("tag:consequence:billing-mutation"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evals stratify CLI writes a metadata-only plan from foundry output", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-cohort-strata-cli-"));
  try {
    const { dir } = buildFoundry(root);
    const tagsPath = join(root, "tags.json");
    writeFileSync(tagsPath, JSON.stringify({ "e-rare-billing": ["consequence:billing-mutation"] }), { mode: 0o600 });
    const outPath = join(root, "plan.json");
    const baseEnv = { ...process.env };
    delete baseEnv.UNDERSTUDY_API_KEY;
    delete baseEnv.UNDERSTUDY_GATEWAY_URL;
    delete baseEnv.FORCE_COLOR;
    const result = spawnSync(cli[0], [cli[1], "evals", "stratify",
      "--from-foundry", dir,
      "--axes", "outcome,mode,turns,confidence,tag",
      "--tags", tagsPath,
      "--high-consequence-tags", "consequence:billing-mutation",
      "--out", outPath,
    ], { cwd: process.cwd(), encoding: "utf8", env: baseEnv });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Stratified cohort plan: \d+ of 7 eligible executions\./);
    // Rare/high-consequence scarcity is surfaced as blocking evidence.
    assert.match(result.stdout, /ready: no/);
    assert.match(result.stdout, /High-consequence stratum tag:consequence:billing-mutation/);
    assert.doesNotMatch(result.stdout, /SECRET_PROMPT_LEAK/);

    const plan = JSON.parse(readFileSync(outPath, "utf8"));
    CohortStrataPlanSchema.parse(plan);
    assert.ok(!readFileSync(outPath, "utf8").includes("SECRET_PROMPT_LEAK"));

    // JSON mode emits the same plan artifact on stdout.
    const jsonRun = spawnSync(cli[0], [cli[1], "--json", "evals", "stratify",
      "--from-foundry", dir,
      "--axes", "outcome,mode,turns,confidence,tag",
      "--tags", tagsPath,
      "--high-consequence-tags", "consequence:billing-mutation",
      "--out", join(root, "plan2.json"),
    ], { cwd: process.cwd(), encoding: "utf8", env: baseEnv });
    assert.equal(jsonRun.status, 0, jsonRun.stderr);
    const jsonPlan = JSON.parse(jsonRun.stdout);
    assert.equal(jsonPlan.schema_version, "understudy.eval-cohort-strata-plan.v1");

    // Expansion via CLI keeps frozen selections.
    const expandRun = spawnSync(cli[0], [cli[1], "evals", "stratify",
      "--from-foundry", dir,
      "--axes", "outcome,mode,turns,confidence,tag",
      "--tags", tagsPath,
      "--high-consequence-tags", "consequence:billing-mutation",
      "--expand-from", outPath,
      "--out", join(root, "plan3.json"),
    ], { cwd: process.cwd(), encoding: "utf8", env: baseEnv });
    assert.equal(expandRun.status, 0, expandRun.stderr);
    assert.match(expandRun.stdout, /frozen selection\(s\) preserved, stability stable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
