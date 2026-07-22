import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { deriveRigorReport, renderRigorReport, writeRigorReport } from "../dist/rigor-report.js";
import { createRunRequest, executeRunRequest, oracleRunner } from "../dist/run-executor.js";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function makeBenchmarkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rigor-"));
  roots.push(dir);
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "rigor-bench",
      provenance: { origin: "derived-from-traces" },
      taxonomy: [{ category_id: "cat-a" }],
      tasks: [
        { task_id: "t1", category_id: "cat-a", genesis: "replayed", split: "train" },
        { task_id: "t2", category_id: "cat-a", genesis: "replayed", split: "holdout" },
      ],
      environment: { format: "verifiers.v1", package_ref: "environment" },
      verifier: { kind: "final-state", strict_metric: "task_completed_correctly", dense_metric: "final_state_partial_credit" },
    }),
  );
  const sidecar = [
    {
      schema_version: "understudy.benchmark_task.v1",
      task_id: "t1",
      title: "Ritual-satisfiable",
      outcome_contract: {
        required: [{ type: "state_effect", tool: "update-record", observed_arguments: {} }],
        preserved: [],
        forbidden: [{ tool: "delete-record" }],
        grading: "final_state_and_obligations",
      },
    },
    {
      schema_version: "understudy.benchmark_task.v1",
      task_id: "t2",
      title: "Anchored + response",
      outcome_contract: {
        required: [
          { type: "state_effect", tool: "update-record", observed_arguments: { id: "record-12345" } },
          { type: "response_obligation", kind: "json_parses" },
        ],
        preserved: [{ tool: "list-items" }],
        forbidden: [],
        grading: "final_state_and_obligations",
      },
    },
  ];
  fs.writeFileSync(path.join(dir, "tasks.jsonl"), sidecar.map((t) => JSON.stringify(t)).join("\n") + "\n");
  const servers = path.join(dir, "environment", "understudy_trace_env", "servers");
  fs.mkdirSync(servers, { recursive: true });
  fs.writeFileSync(path.join(servers, "schemas.json"), JSON.stringify({ "update-record": { required: ["id"], properties: { id: "string" } } }));
  return dir;
}

/** Golden fixture: a benchmark dir with an oracle run + trivial arms already executed. */
async function makeExecutedDir() {
  const dir = makeBenchmarkDir();
  const run = createRunRequest(dir, {
    benchmark_id: "rigor-bench",
    models: ["oracle-inc"],
    split: "all",
    tasks: "all",
    rollouts_per_task: 1,
    incumbent_models: ["oracle-inc"],
    trivial_arms: ["null_agent", "spam_agent"],
  });
  const result = await executeRunRequest(dir, run.run_id, { runner: oracleRunner() });
  assert.equal(result.status, "done");
  return dir;
}

describe("deriveRigorReport", () => {
  it("reports honest UNKNOWNs on a benchmark with no runs at all", () => {
    const report = deriveRigorReport(makeBenchmarkDir(), new Date("2026-07-22T00:00:00Z"));
    const byItem = Object.fromEntries(report.items.map((i) => [i.item, i]));
    assert.equal(byItem["Oracle solver"].status, "UNKNOWN");
    assert.equal(byItem["Null-agent floor"].status, "UNKNOWN");
    assert.equal(byItem["Spam-agent floor"].status, "UNKNOWN");
    assert.equal(byItem["Incumbent calibration"].status, "UNKNOWN");
    assert.equal(byItem["Rollout anomalies"].status, "UNKNOWN");
    assert.equal(byItem["Leakage / contamination audit"].status, "UNKNOWN");
    assert.equal(byItem["Confidence intervals"].status, "UNKNOWN");
    assert.equal(byItem["Split provenance"].status, "PASS");
    assert.deepEqual(report.split_counts, { train: 1, holdout: 1 });
    assert.equal(report.row_counts.total, 0);
  });

  it("derives the ABC items + per-task complexity from an executed dir (golden fixture)", async () => {
    const dir = await makeExecutedDir();
    const report = deriveRigorReport(dir, new Date("2026-07-22T00:00:00Z"));
    const byItem = Object.fromEntries(report.items.map((i) => [i.item, i]));

    // Oracle solvability: the state-effect oracle passes t1 but honestly
    // flags t2 (its response_obligation is not oracle-satisfiable by the
    // offline oracle runner) — a real coverage gap, reported not hidden.
    assert.equal(byItem["Oracle solver"].status, "FLAG");
    assert.equal(byItem["Oracle solver"].value, "1/2 tasks pass");
    assert.match(byItem["Oracle solver"].detail, /t2/);
    // Null agent passes nothing here; spam passes the ritual-satisfiable t1.
    assert.equal(byItem["Null-agent floor"].status, "PASS");
    assert.match(byItem["Null-agent floor"].value, /0\.0% \(0\/2\)/);
    assert.equal(byItem["Spam-agent floor"].status, "FLAG");
    assert.match(byItem["Spam-agent floor"].value, /50\.0% \(1\/2\)/);
    assert.match(byItem["Spam-agent floor"].detail, /t1/);
    // Incumbent calibration from calibration.json: the oracle incumbent also
    // fails t2's response obligation, so the gate flags it as suspect.
    assert.equal(byItem["Incumbent calibration"].status, "FLAG");
    assert.match(byItem["Incumbent calibration"].detail, /t2/);
    assert.equal(byItem["Rollout anomalies"].status, "PASS");
    // Honest UNKNOWNs stay UNKNOWN even on a fully executed dir.
    assert.equal(byItem["Leakage / contamination audit"].status, "UNKNOWN");
    assert.equal(byItem["Confidence intervals"].status, "UNKNOWN");

    // Per-task contract complexity from tasks.jsonl.
    const t2 = report.tasks.find((t) => t.task_id === "t2");
    assert.equal(t2.required_total, 2);
    assert.deepEqual(t2.required_by_kind, { state_effect: 1, response_obligation: 1 });
    assert.equal(t2.preserved, 1);
    assert.equal(t2.split, "holdout");
    const t1 = report.tasks.find((t) => t.task_id === "t1");
    assert.equal(t1.forbidden, 1);

    // Row accounting by arm kind.
    assert.deepEqual(report.row_counts.by_arm_kind, { incumbent: 2, null_agent: 2, spam_agent: 2 });
  });
});

describe("leakage-audit wiring", () => {
  function writeAudit(dir, audit) {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schema_version: "understudy.trace_foundry.v1", leakage_audit: audit }));
  }

  it("flips the leakage row to PASS from a clean manifest.json audit", () => {
    const dir = makeBenchmarkDir();
    writeAudit(dir, { schema_version: "understudy.leakage_audit.v1", status: "clean", checked_tasks: 2, findings: [], tier_counts: { verbatim: 0, fuzzy: 0, semantic: 0 }, heuristic: "test" });
    const byItem = Object.fromEntries(deriveRigorReport(dir).items.map((i) => [i.item, i]));
    assert.equal(byItem["Leakage / contamination audit"].status, "PASS");
    assert.equal(byItem["Leakage / contamination audit"].value, "0 verbatim / 0 fuzzy over 2 task(s)");
  });

  it("FLAGs on verbatim findings and stays PASS (advisory) on fuzzy-only findings", () => {
    const verbatimDir = makeBenchmarkDir();
    writeAudit(verbatimDir, {
      schema_version: "understudy.leakage_audit.v1", status: "findings", checked_tasks: 2, heuristic: "test",
      findings: [{ task_id: "t1", location: "fixtures.json", kind: "state_effect_value", excerpt: "x", tier: "verbatim", similarity: 1, signal: "verbatim" }],
      tier_counts: { verbatim: 1, fuzzy: 0, semantic: 0 },
    });
    const verbatimRow = deriveRigorReport(verbatimDir).items.find((i) => i.item === "Leakage / contamination audit");
    assert.equal(verbatimRow.status, "FLAG");
    assert.match(verbatimRow.value, /1 verbatim \/ 0 fuzzy/);

    const fuzzyDir = makeBenchmarkDir();
    writeAudit(fuzzyDir, {
      schema_version: "understudy.leakage_audit.v1", status: "advisory", checked_tasks: 2, heuristic: "test",
      findings: [{ task_id: "t1", location: "fixtures.json", kind: "state_effect_value", excerpt: "x", tier: "fuzzy", similarity: 0.6, signal: "shingle containment 3/5" }],
      tier_counts: { verbatim: 0, fuzzy: 1, semantic: 0 },
    });
    const fuzzyRow = deriveRigorReport(fuzzyDir).items.find((i) => i.item === "Leakage / contamination audit");
    assert.equal(fuzzyRow.status, "PASS", "fuzzy findings are advisory, not alarms");
    assert.match(fuzzyRow.value, /0 verbatim \/ 1 fuzzy/);
    assert.match(fuzzyRow.detail, /advisory/);
  });

  it("treats pre-tier findings (no tier field) as verbatim", () => {
    const dir = makeBenchmarkDir();
    writeAudit(dir, {
      schema_version: "understudy.leakage_audit.v1", status: "findings", checked_tasks: 1, heuristic: "test",
      findings: [{ task_id: "t1", location: "fixtures.json", kind: "state_effect_value", excerpt: "x" }],
    });
    const row = deriveRigorReport(dir).items.find((i) => i.item === "Leakage / contamination audit");
    assert.equal(row.status, "FLAG");
    assert.match(row.value, /1 verbatim/);
  });
});

describe("renderRigorReport + writeRigorReport", () => {
  it("writes rigor-report.md into the benchmark dir with the ABC table and per-task table", async () => {
    const dir = await makeExecutedDir();
    const { path: written, report } = writeRigorReport(dir, new Date("2026-07-22T00:00:00Z"));
    assert.equal(written, path.join(dir, "rigor-report.md"));
    const md = fs.readFileSync(written, "utf8");
    assert.equal(md, renderRigorReport(report), "file content is exactly the renderer output");
    assert.match(md, /# Benchmark rigor report — rigor-bench/);
    assert.match(md, /Generated 2026-07-22T00:00:00\.000Z/);
    assert.match(md, /\| Item \| Status \| Value \| Detail \|/);
    assert.match(md, /\| Null-agent floor \| PASS \|/);
    assert.match(md, /\| Spam-agent floor \| FLAG \|/);
    assert.match(md, /\| Leakage \/ contamination audit \| UNKNOWN \|/);
    assert.match(md, /\| Confidence intervals \| UNKNOWN \|/);
    assert.match(md, /\| t2 \| holdout \| 2 \| response_obligation: 1, state_effect: 1|state_effect: 1, response_obligation: 1/);
    assert.match(md, /no network, no model calls/);
  });
});
