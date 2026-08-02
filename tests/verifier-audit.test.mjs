import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  auditAdapter,
  attachNaturalAudit,
  auditIdempotencyKey,
  gateVerdict,
  metricsFor,
  renderAuditJson,
} from "../dist/verifier-audit.js";
import {
  automationBenchV2Adapter,
  parseAutomationTranscripts,
  syntheticWorkflowAdapter,
} from "../dist/verifier-audit-envs.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("verifier reliability audit", () => {
  it("is deterministic and emits no NaN", () => {
    const first = auditAdapter(syntheticWorkflowAdapter, { splits: ["dev"] });
    const second = auditAdapter(syntheticWorkflowAdapter, { splits: ["dev"] });
    assert.equal(renderAuditJson(first), renderAuditJson(second));
    assert.doesNotMatch(renderAuditJson(first), /NaN/);
  });

  it("stamps a stable idempotency key into identical artifact contracts", () => {
    const refs = [{ path: "outputs/synthetic.jsonl", sha256: "a".repeat(64) }];
    const first = auditAdapter(syntheticWorkflowAdapter, { splits: ["dev"], transcriptRefs: refs });
    const second = auditAdapter(syntheticWorkflowAdapter, { splits: ["dev"], transcriptRefs: refs });
    assert.equal(renderAuditJson(first), renderAuditJson(second));
    assert.equal(first.idempotency_key, auditIdempotencyKey({
      fixture: first.adapter,
      splitHashes: first.split_sha256s,
      gateVersion: first.gate.version,
      probeSuiteVersion: first.probe_suite_version,
      transcriptRefs: refs,
      thresholds: first.thresholds,
    }));
  });

  it("scores the oracle as true success with reward 1", () => {
    const receipt = auditAdapter(automationBenchV2Adapter, { splits: ["dev"], includeResults: true });
    const oracle = receipt.probe_samples.find((result) => result.family === "oracle");
    assert.ok(oracle);
    assert.equal(oracle.reward, 1);
    assert.equal(oracle.true_success, true);
    assert.equal(oracle.ground_truth_disagreement, false);
  });

  it("scores the existing sentinel as true failure with reward 0", () => {
    const receipt = auditAdapter(automationBenchV2Adapter, { splits: ["train"], includeResults: true });
    const sentinel = receipt.probe_samples.find((result) => result.family === "sentinel-clobber");
    assert.ok(sentinel);
    assert.equal(sentinel.reward, 0);
    assert.equal(sentinel.true_success, false);
    assert.equal(sentinel.ground_truth_disagreement, false);
  });

  it("fails the gate for a planted false positive", () => {
    const metrics = metricsFor([
      {
        probe_id: "t:oracle:1",
        task_id: "t",
        split: "train",
        band: "planted",
        family: "oracle",
        expect: "success",
        reward: 1,
        true_success: true,
        declared_success: true,
        ground_truth_disagreement: false,
      },
      ...Array.from({ length: 24 }, (_, index) => ({
        probe_id: `t:wrong:${index}`,
        task_id: "t",
        split: "train",
        band: "planted",
        family: "wrong-value",
        expect: "failure",
        reward: index === 0 ? 1 : 0,
        true_success: false,
        declared_success: false,
        ground_truth_disagreement: false,
      })),
    ], 0, 1);
    const verdict = gateVerdict(metrics);
    assert.equal(verdict.verdict, "untrusted");
    assert.ok(verdict.reasons.some((reason) => reason.startsWith("false_positive_rate_exceeds_max")));
    assert.ok(verdict.reasons.some((reason) => reason.startsWith("reward_hacked_probes_exceeds_max")));
  });

  it("keeps unknown-intent reorder probes out of disagreements and exposes family metrics", () => {
    const receipt = auditAdapter(automationBenchV2Adapter, { splits: ["dev"], includeResults: true });
    assert.ok(receipt.order_dependent_tasks.length > 0);
    assert.equal(receipt.probe_samples.filter((result) => result.expect === "unknown" && result.ground_truth_disagreement).length, 0);
    assert.ok(Object.keys(receipt.per_family["multi-hop"]).some((key) => key.startsWith("oracle-reordered@")));
    assert.equal(receipt.per_family_by_split, undefined);
    assert.ok(Object.keys(receipt.per_family["multi-hop"]).every((key) => key.endsWith("@1")));
  });

  it("replays a fixture transcript faithfully", () => {
    const task = automationBenchV2Adapter.tasks("dev")[0];
    const { reward } = automationBenchV2Adapter.run(task, task.oracle);
    const rows = parseAutomationTranscripts([{
      task_id: task.taskId,
      score: reward,
      transcript: [{ tool_calls: task.oracle }],
    }]);
    const receipt = auditAdapter(automationBenchV2Adapter, { splits: ["dev"] });
    const natural = attachNaturalAudit(receipt, automationBenchV2Adapter, rows, { splits: ["dev"] });
    assert.equal(natural.natural.replay_fidelity_mismatches, 0);
    assert.equal(natural.natural.probes, 1);
  });

  it("marks bands without natural samples insufficient-evidence", () => {
    const receipt = attachNaturalAudit(
      auditAdapter(syntheticWorkflowAdapter, { splits: ["dev"] }),
      syntheticWorkflowAdapter,
      [],
      { splits: ["dev"] },
    );
    assert.ok(Object.values(receipt.verdicts).every((verdict) => verdict.verdict === "insufficient-evidence"));
  });

  it("keeps committed train/dev adversarial receipts fresh", () => {
    const cases = [
      ["automationbench-v2", automationBenchV2Adapter],
      ["synthetic-workflow", syntheticWorkflowAdapter],
    ];
    for (const [fixture, adapter] of cases) {
      const receiptPath = join("experiments", "verifier-reliability-audit", `${fixture}-adversarial.json`);
      const committed = JSON.parse(readFileSync(receiptPath, "utf8"));
      const recomputed = auditAdapter(adapter, {
        splits: ["train", "dev"],
        transcriptRefs: committed.transcript_refs,
      });
      const message = "regenerate the receipts and update docs/verifier-reliability.md";
      assert.equal(recomputed.probe_suite_version, committed.probe_suite_version, `${fixture}: ${message}`);
      assert.equal(recomputed.fixture_sha256, committed.fixture_sha256, `${fixture}: ${message}`);
      assert.deepEqual(recomputed.split_sha256s, committed.split_sha256s, `${fixture}: ${message}`);
      assert.deepEqual(recomputed.gate, committed.gate, `${fixture}: ${message}`);
      assert.deepEqual(
        Object.fromEntries(Object.entries(recomputed.verdicts).map(([band, verdict]) => [band, verdict.verdict])),
        Object.fromEntries(Object.entries(committed.verdicts).map(([band, verdict]) => [band, verdict.verdict])),
        `${fixture}: ${message}`,
      );
      assert.equal(recomputed.idempotency_key, committed.idempotency_key, `${fixture}: ${message}`);
    }
  });

  it("fails the verifier-audit CLI CI gate without a natural arm", () => {
    const out = mkdtempSync(join(tmpdir(), "verifier-audit-cli-"));
    try {
      const result = spawnSync(process.execPath, [
        "dist/bin.js", "benchmarks", "verifier-audit",
        "--fixture", "synthetic-workflow", "--split", "dev", "--ci", "--out", out,
      ], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(readFileSync(join(out, "synthetic-workflow.md"), "utf8"), /Order-dependent|Verifier reliability audit/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
