import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Compiled by `tsc -p tests/tsconfig.json` (see package.json "test" script).
// partner-report-core re-exports the CLI's compiled dist module — this test
// pins the re-export contract the hub Report page depends on.
import { PARTNER_REPORT_SCHEMA, derivePartnerReport, renderPartnerReport } from "./.build/lib/partner-report-core.js";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function makeBenchmarkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-partner-report-"));
  roots.push(dir);
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "hub-pr-bench",
      name: "hub report smoke",
      provenance: { origin: "derived-from-traces" },
      taxonomy: [{ category_id: "cat-a" }],
      tasks: [
        { task_id: "t1", category_id: "cat-a", split: "holdout" },
        { task_id: "t2", category_id: "cat-a", split: "holdout" },
      ],
      environment: { format: "verifiers.v1", package_ref: "environment" },
      verifier: { kind: "final-state", strict_metric: "task_completed_correctly" },
    }),
  );
  const rows = [
    { schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "t1", status: "ok", score: 1, model: "m-a", arm_kind: "incumbent", cost: 0.2, latency_ms: 100 },
    { schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "t2", status: "ok", score: 1, model: "m-a", arm_kind: "incumbent", cost: 0.2, latency_ms: 100 },
    { schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "t1", status: "ok", score: 1, model: "m-b", arm_kind: "candidate", cost: 0.01, latency_ms: 50 },
    { schema_version: "understudy.eval_result.v1", run_id: "r", task_id: "t2", status: "ok", score: 0, model: "m-b", arm_kind: "candidate", cost: 0.01, latency_ms: 50 },
  ];
  fs.writeFileSync(path.join(dir, "rows-run-r.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

describe("partner-report-core (dist re-export)", () => {
  it("derives and renders the same report the CLI writes", () => {
    const dir = makeBenchmarkDir();
    const report = derivePartnerReport(dir, { now: new Date("2026-07-22T00:00:00.000Z") });
    assert.equal(report.schema_version, PARTNER_REPORT_SCHEMA);
    assert.equal(report.workload.scope, "holdout");
    assert.equal(report.arms.length, 2);
    assert.ok(report.incumbent && report.incumbent.model === "m-a");
    assert.ok(report.arms.every((arm) => arm.ci != null));
    const markdown = renderPartnerReport(report);
    assert.match(markdown, /95% CI/);
    assert.match(markdown, /Holdout governance/);
  });
});
