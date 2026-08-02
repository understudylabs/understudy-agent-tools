import assert from "node:assert/strict";
import test from "node:test";
import { renderSummaryHTML, summarizeManifest } from "./monitor-panel.mjs";

const protocol = {
  method: "canonical_rollout",
  scorer_version: "synthetic-scorer",
  rollout_contract: "synthetic-contract",
  split_sha256: "dev-synthetic",
  samples_per_task: 3,
};

function manifest(wave2 = { stage: "confirming", score: null }) {
  return {
    headline: { high_score: 0.8, high_score_node: "wave1-node" },
    rank_protocol: protocol,
    dev_split_sha256: "dev-synthetic",
    holdout_untouched: true,
    nodes: [
      { node_id: "baseline-node", label: "Baseline", wave: "baseline", stage: "completed",
        score: 0.5, parent: null, branch_id: null, rank_eligible: true },
      { node_id: "wave1-node", label: "Wave 1", wave: "wave1", stage: "completed",
        score: 0.8, parent: "baseline-node", branch_id: "alpha", rank_eligible: true },
      { node_id: "wave2-node", label: "Wave 2", wave: "wave2", ...wave2,
        parent: "wave1-node", branch_id: "beta", rank_eligible: true },
      { node_id: "active-node", label: "Reflecting", wave: "wave2", stage: "reflecting",
        score: null, parent: "wave1-node", branch_id: "gamma", rank_eligible: false },
    ],
    reference_lines: [
      { label: "Incumbent", score: 0.9, rank_comparable: false, note: "k=1 reference" },
    ],
    totals: {
      budget: { stage_a_completed: 17, total_reflections: 4 },
      wall_clock_s: 91,
      selected_winner: null,
    },
  };
}

test("projects canonical headline and keeps incumbent reference-only", () => {
  const summary = summarizeManifest(manifest());
  assert.equal(summary.headlineHighScore, 0.8);
  assert.equal(summary.incumbentReference.score, 0.9);
  assert.match(summary.incumbentReference.note, /k=1; not rank-comparable/);
  assert.equal(summary.nodesByWave.baseline.length, 1);
  assert.equal(summary.nodesByWave.wave1.length, 1);
  assert.equal(summary.nodesByWave.wave2.length, 2);
});

test("surfaces preview, progress, active stages, and holdout status", () => {
  const summary = summarizeManifest(manifest());
  assert.equal(summary.isPreview, true);
  assert.deepEqual(summary.episodes, { completed: 17, cap: 120 });
  assert.deepEqual(summary.reflections, { completed: 4, cap: 8 });
  assert.equal(summary.elapsedS, 91);
  assert.equal(summary.holdoutUntouched, true);
  assert.deepEqual(summary.activeStages.map((node) => node.node_id), ["wave2-node", "active-node"]);
  assert.match(renderSummaryHTML(summary), /PREVIEW — not yet backed by canonical confirm receipts/);
});

test("clears preview after a finalized wave2 score", () => {
  const summary = summarizeManifest(manifest({ stage: "promoted", score: 0.85 }));
  assert.equal(summary.isPreview, false);
  assert.doesNotMatch(renderSummaryHTML(summary), /PREVIEW/);
});
