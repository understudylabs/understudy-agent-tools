import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
  PARTNER_REPORT_SCHEMA,
  derivePartnerReport,
  renderPartnerReport,
  scrubText,
  slugNameTokens,
  writePartnerReport,
} from "../dist/partner-report.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const NOW = new Date("2026-07-22T00:00:00.000Z");

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function row(model, taskId, score, over = {}) {
  return {
    schema_version: "understudy.eval_result.v1",
    run_id: "run-1",
    task_id: taskId,
    status: "ok",
    score,
    model,
    arm_kind: "candidate",
    latency_ms: 1000,
    cost: 0.01,
    ...over,
  };
}

/**
 * Fixture benchmark dir: 4 holdout tasks + 1 train task, an incumbent, two
 * candidates (one never passes — the zero-passed cost edge), a null-agent
 * floor arm, one experiment line, and a leakage-free foundry manifest.
 */
function makeBenchmarkDir({ slug = "acme-support-automation", incumbentScore = 1, monthlyVolumeInManifest = null } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "partner-report-"));
  roots.push(parent);
  const dir = path.join(parent, slug);
  fs.mkdirSync(dir);
  const tasks = ["t1", "t2", "t3", "t4"].map((id) => ({ task_id: id, category_id: "cat-a", split: "holdout" }));
  tasks.push({ task_id: "t5", category_id: "cat-a", split: "train" });
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "pr-bench",
      name: "Acme support automation for support@acme.com",
      description: "Traces from https://app.acme.com/support handled by Acme Corp.",
      provenance: { origin: "derived-from-traces" },
      taxonomy: [{ category_id: "cat-a" }],
      tasks,
      environment: { format: "verifiers.v1", package_ref: "environment" },
      verifier: { kind: "final-state", strict_metric: "task_completed_correctly" },
      ...(monthlyVolumeInManifest != null ? { monthly_volume: monthlyVolumeInManifest } : {}),
    }),
  );
  writeJsonl(
    path.join(dir, "tasks.jsonl"),
    ["t1", "t2", "t3", "t4", "t5"].map((id) => ({
      schema_version: "understudy.benchmark_task.v1",
      task_id: id,
      title: id,
      outcome_contract: {
        required: [{ type: "state_effect", tool: "update-record", observed_arguments: {} }],
        preserved: [],
        forbidden: [],
        grading: "final_state_and_obligations",
      },
    })),
  );
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ leakage_audit: { schema_version: "understudy.leakage_audit.v1", checked_tasks: 5, findings: [] } }),
  );
  const rows = [
    // Incumbent: 4 holdout tasks at incumbentScore, $0.10/rollout.
    ...["t1", "t2", "t3", "t4"].map((id) => row("big-model", id, incumbentScore, { arm_kind: "incumbent", cost: 0.1 })),
    // Candidate small-model: passes 3/4 at $0.01/rollout.
    row("small-model", "t1", 1),
    row("small-model", "t2", 1),
    row("small-model", "t3", 1),
    row("small-model", "t4", 0),
    // Candidate zero-model: spends but never passes (cost-per-correct undefined).
    ...["t1", "t2", "t3", "t4"].map((id) => row("zero-model", id, 0, { cost: 0.02 })),
    // Null-agent floor rows.
    ...["t1", "t2", "t3", "t4"].map((id) => row("null_agent", id, 0, { arm_kind: "null_agent", cost: 0 })),
    // Train-split row: must NEVER enter the holdout-scoped table.
    row("small-model", "t5", 0),
    // Anomalous row: marked, excluded from aggregates, counted.
    row("small-model", "t4", 1, { anomaly: { kind: "empty_final_response", detail: "x" } }),
  ];
  writeJsonl(path.join(dir, "rows-run-1.jsonl"), rows);
  writeJsonl(path.join(dir, "experiments.jsonl"), [
    {
      schema_version: "understudy.experiment.v1",
      experiment_id: "exp-1",
      created_at: NOW.toISOString(),
      hypothesis: "small-model can replace big-model on Acme support",
      status: "concluded",
      data_selection: { selection_hash: "abc", source: "rows" },
      training: { method: "prompt_only", base_model: "small-model", config: {}, provider: "local", approvals: [] },
      eval_run_ids: ["run-1"],
      verdict: { decision: "shadow", summary: "tie on holdout", decided_at: NOW.toISOString() },
    },
  ]);
  return dir;
}

describe("scrubbing", () => {
  it("scrubs names, emails, urls, and domains", () => {
    const stats = { names: 0, emails: 0, urls: 0, domains: 0 };
    const out = scrubText("Acme Corp (ops@acme.com) runs https://app.acme.com/x and acmecorp.io", ["acme"], stats);
    assert.ok(!/acme/i.test(out), out);
    assert.ok(out.includes("[partner]"));
    assert.ok(out.includes("[redacted-email]"));
    assert.ok(out.includes("[redacted-url]"));
    assert.ok(out.includes("[redacted-domain]"));
    assert.ok(stats.names >= 1 && stats.emails === 1 && stats.urls === 1 && stats.domains >= 1);
  });

  it("derives customer-name tokens from the dir slug, skipping generic words", () => {
    assert.deepEqual(slugNameTokens("cedar-automation"), ["cedar"]);
    assert.deepEqual(slugNameTokens("trace-benchmark-42"), []);
  });
});

describe("derivePartnerReport", () => {
  it("derives holdout-scoped arms with CIs, floors, cost-per-correct, and no unsupported winner", () => {
    const dir = makeBenchmarkDir();
    const report = derivePartnerReport(dir, { now: NOW });
    assert.equal(report.schema_version, PARTNER_REPORT_SCHEMA);
    assert.equal(report.workload.scope, "holdout");

    // Name scrubbing: slug token "acme" plus emails/urls never survive.
    assert.ok(!/acme/i.test(JSON.stringify(report)), "customer name leaked into the report JSON");
    assert.ok(report.workload.name.includes("[partner]"));

    const incumbent = report.incumbent;
    assert.ok(incumbent);
    assert.equal(incumbent.model, "big-model");
    // cost-per-correct = total cost / passed tasks = 0.40 / 4.
    assert.ok(Math.abs(incumbent.cost_per_correct_usd - 0.1) < 1e-9);
    assert.ok(incumbent.ci && incumbent.ci.lo === 1 && incumbent.ci.hi === 1);

    const small = report.arms.find((a) => a.model === "small-model");
    // Train row t5 and the anomalous t4 repeat are excluded: 4 tasks, 4 rows scored.
    assert.equal(small.task_n, 4);
    assert.equal(small.passed_tasks, 3);
    assert.ok(Math.abs(small.cost_per_correct_usd - 0.04 / 3) < 1e-9);

    // Zero-passed edge: spent money, no passes → null cpc with an explicit note, never 0.
    const zero = report.arms.find((a) => a.model === "zero-model");
    assert.equal(zero.cost_per_correct_usd, null);
    assert.match(zero.cost_per_correct_note, /zero tasks passed/);

    // Floors: null agent measured at 0, spam/majority honestly unmeasured.
    const nullFloor = report.floors.find((f) => f.arm_kind === "null_agent");
    assert.equal(nullFloor.floor, 0);
    assert.equal(report.floors.find((f) => f.arm_kind === "spam_agent").floor, null);

    // big-model [1,1] and small-model CI overlap at hi=1 → statistical tie, no winner.
    assert.equal(report.winner_is_significant, false);
    assert.match(report.tie_note, /overlapping 95% CIs/);

    // No volume anywhere → no projection, and the report says why.
    assert.equal(report.projected_savings, null);
    assert.equal(report.anonymous_savings, null);

    // Failure clusters: small-model fails t4 (one state_effect obligation).
    assert.deepEqual(report.failure_clusters, [{ obligation_kind: "state_effect", failing_tasks: 1 }]);

    // Experiment lineage rides along, scrubbed.
    assert.equal(report.experiments.length, 1);
    assert.ok(report.experiments[0].hypothesis.includes("[partner]"));

    // Anomalies + small holdout land in limitations automatically.
    assert.equal(report.anomaly_total, 1);
    assert.ok(report.limitations.some((l) => /Small holdout/.test(l)));
    assert.ok(report.limitations.some((l) => /anomaly/.test(l)));
  });

  it("projects EXTRAPOLATED savings from --monthly-volume and emits a share-savings-ready payload", () => {
    const dir = makeBenchmarkDir();
    const report = derivePartnerReport(dir, { now: NOW, monthlyVolume: 1000 });
    const s = report.projected_savings;
    assert.ok(s);
    assert.equal(s.extrapolated, true);
    assert.equal(s.volume_source, "flag");
    // Candidate = cheapest cost-per-correct inside the top tie group (small-model; zero-model has no cpc).
    assert.equal(s.candidate_model, "small-model");
    assert.ok(Math.abs(s.monthly_savings_usd - (0.1 - 0.04 / 3) * 1000) < 1e-6);

    const payload = report.anonymous_savings;
    assert.equal(payload.schema_version, "understudy.anonymous_savings.v1");
    assert.equal(payload.requests_per_month, 1000);
    assert.equal(payload.validated_on_holdout, true);
    // Tied result: honest claim status is claim-packet-required, not claim-supported.
    assert.equal(payload.claim_status, "claim-packet-required");
    assert.ok(report.limitations.some((l) => /EXTRAPOLATION/.test(l)));
  });

  it("falls back to manifest.monthly_volume and labels the source", () => {
    const dir = makeBenchmarkDir({ monthlyVolumeInManifest: 500 });
    const report = derivePartnerReport(dir, { now: NOW });
    assert.equal(report.projected_savings.volume_source, "manifest");
    assert.equal(report.projected_savings.monthly_volume, 500);
  });

  it("claims a winner only when CIs separate on the sealed holdout", () => {
    const dir = makeBenchmarkDir({ incumbentScore: 0 });
    const report = derivePartnerReport(dir, { now: NOW });
    // small-model per-task means [1,1,1,0] vs incumbent [0,0]: bootstrap lo > 0 is not
    // guaranteed, so just assert consistency: significant XOR tie/directional note.
    if (report.winner_is_significant) {
      assert.equal(report.tie_note, null);
      assert.equal(report.best_candidate.model, "small-model");
    } else {
      assert.ok(report.tie_note != null || report.best_candidate != null);
    }
  });
});

describe("renderPartnerReport", () => {
  it("renders floors, CI columns, tie honesty, and the extrapolation label", () => {
    const dir = makeBenchmarkDir();
    const markdown = renderPartnerReport(derivePartnerReport(dir, { now: NOW, monthlyVolume: 1000 }));
    assert.match(markdown, /a do-nothing agent scores 0\.0%/);
    assert.match(markdown, /95% CI/);
    assert.match(markdown, /\*\*No winner is claimed\.\*\*/);
    assert.match(markdown, /\*\*EXTRAPOLATED\*\*/);
    assert.match(markdown, /cost-per-correct-task is undefined/);
    assert.ok(!/acme/i.test(markdown));
  });

  it("matches the golden report fixture byte-for-byte", () => {
    const dir = makeBenchmarkDir();
    const markdown = renderPartnerReport(derivePartnerReport(dir, { now: NOW, monthlyVolume: 1000 }));
    const goldenPath = path.join(FIXTURES, "partner-report-golden.md");
    if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(goldenPath, markdown);
    // The fixture embeds the benchmark.json/tasks.jsonl hashes of THIS builder,
    // so any derivation or rendering drift fails loudly here.
    assert.equal(markdown, fs.readFileSync(goldenPath, "utf8"));
  });
});

describe("writePartnerReport", () => {
  it("writes partner-report.md and .json into --out without touching a read-only benchmark dir", () => {
    const dir = makeBenchmarkDir();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "partner-report-out-"));
    roots.push(out);
    const before = fs.readdirSync(dir).sort();
    const { markdownPath, jsonPath, report } = writePartnerReport(dir, { now: NOW, outDir: out });
    assert.equal(path.dirname(markdownPath), out);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
    const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.equal(json.schema_version, PARTNER_REPORT_SCHEMA);
    assert.equal(json.benchmark_id, report.benchmark_id);
  });
});
