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
        parent: "wave1-node", branch_id: "beta", rank_eligible: wave2.rank_eligible ?? true },
      { node_id: "active-node", label: "Reflecting", wave: "wave2", stage: "reflecting",
        score: null, parent: "wave1-node", branch_id: "gamma", rank_eligible: false },
    ],
    reference_lines: [
      { label: "Incumbent", score: 0.9, rank_comparable: false, note: "k=1 reference" },
    ],
    totals: {
      budget: {
        max_total_episodes: 120,
        stage_a_global_cap: 72,
        max_total_reflections: 8,
        stage_a_completed: 17,
        total_reflections: 4,
      },
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
  assert.equal(summary.evidenceState, "preview");
  assert.deepEqual(summary.episodes, { completed: 17, cap: 120 });
  assert.deepEqual(summary.reflections, { completed: 4, cap: 8 });
  assert.equal(summary.elapsedS, 91);
  assert.equal(summary.holdoutUntouched, true);
  assert.deepEqual(summary.activeStages.map((node) => node.node_id), ["wave2-node", "active-node"]);
  assert.match(renderSummaryHTML(summary), /PREVIEW — not yet backed by canonical confirm receipts/);
});

test("clears preview after a finalized wave2 score", () => {
  const summary = summarizeManifest(manifest({
    stage: "promoted", score: 0.85, protocol,
    provenance: { confirm_consumed: 24, confirmation_receipt: "synthetic-receipt" },
  }));
  assert.equal(summary.isPreview, false);
  assert.equal(summary.evidenceState, "confirmed");
  assert.doesNotMatch(renderSummaryHTML(summary), /PREVIEW/);
});

test("rejected and failed wave2 nodes never clear preview", () => {
  for (const stage of ["rejected", "failed"]) {
    const summary = summarizeManifest(manifest({ stage, score: null, protocol }));
    assert.equal(summary.isPreview, true, `${stage} remains preview`);
  }
});

test("deduped wave2 score without confirmation evidence remains preview", () => {
  const summary = summarizeManifest(manifest({
    stage: "completed",
    score: 0.729,
    protocol,
    provenance: { outcome: "no_improvement_deduplicated", confirm_consumed: 0 },
  }));
  assert.equal(summary.evidenceState, "preview");
  assert.equal(summary.isPreview, true);
});

test("missing budget caps and progress render em dashes without invented caps", () => {
  const noBudget = manifest();
  delete noBudget.totals.budget;
  const summary = summarizeManifest(noBudget);
  assert.deepEqual(summary.episodes, { completed: null, cap: null });
  assert.deepEqual(summary.reflections, { completed: null, cap: null });
  const html = renderSummaryHTML(summary);
  assert.match(html, /episodes —\/—/);
  assert.match(html, /reflections —\/—/);
  assert.doesNotMatch(html, /120/);
  assert.doesNotMatch(html, /\/8/);
});

test("budget caps project from manifest totals", () => {
  const summary = summarizeManifest(manifest());
  assert.equal(summary.episodes.cap, 120);
  assert.equal(summary.reflections.cap, 8);
});

test("canonical protocol and rank eligibility are required to clear preview", () => {
  const mismatched = summarizeManifest(manifest({
    stage: "completed",
    score: 0.85,
    protocol: { ...protocol, samples_per_task: 1 },
    provenance: { confirm_consumed: 24 },
  }));
  assert.equal(mismatched.isPreview, true);
  const ineligible = summarizeManifest(manifest({
    stage: "completed",
    score: 0.85,
    protocol,
    rank_eligible: false,
    provenance: { confirm_consumed: 24 },
  }));
  assert.equal(ineligible.isPreview, true);
});

test("finished deduplicated race is complete without preview", () => {
  const finished = manifest({
    stage: "completed",
    score: null,
    rank_eligible: false,
    provenance: { outcome: "no_improvement_deduplicated", confirm_consumed: 0 },
  });
  finished.totals.budget.stage_a_completed = 72;
  finished.totals.budget.branches = {
    A: { stage: "completed", confirm_consumed: 0, confirm_released: 24 },
    B: { stage: "completed", confirm_consumed: 0, confirm_released: 24 },
  };
  finished.totals.selected_winner = {
    reuses: "wave1-winner",
    new_model_lift: false,
  };
  const summary = summarizeManifest(finished);
  assert.equal(summary.evidenceState, "complete_no_improvement");
  assert.equal(summary.isPreview, false);
  assert.equal(summary.winner, "wave1-winner");
  const html = renderSummaryHTML(summary);
  assert.match(html, /COMPLETE — no new candidate; Wave-1 remains incumbent/);
  assert.doesNotMatch(html, /PREVIEW — not yet backed by canonical confirm receipts/);
});

test("holdout status is fail-closed unless explicitly true", () => {
  const falseSummary = summarizeManifest({ ...manifest(), holdout_untouched: false });
  assert.equal(falseSummary.holdoutUntouched, false);
  assert.match(renderSummaryHTML(falseSummary), /HOLDOUT UNTOUCHED: UNVERIFIED — FAIL CLOSED/);

  const missingManifest = manifest();
  delete missingManifest.holdout_untouched;
  const missingSummary = summarizeManifest(missingManifest);
  assert.equal(missingSummary.holdoutUntouched, null);
  assert.match(renderSummaryHTML(missingSummary), /HOLDOUT UNTOUCHED: UNVERIFIED — FAIL CLOSED/);

  const trueSummary = summarizeManifest(manifest());
  assert.equal(trueSummary.holdoutUntouched, true);
  assert.match(renderSummaryHTML(trueSummary), /holdout untouched/);
  assert.doesNotMatch(renderSummaryHTML(trueSummary), /FAIL CLOSED/);

  const observedSummary = summarizeManifest({
    ...manifest(),
    holdout_untouched: false,
    holdout_status: "historical_holdout_observed",
  });
  assert.equal(observedSummary.holdoutUntouched, false);
  assert.match(renderSummaryHTML(observedSummary), /historical holdout observed/);
  assert.match(renderSummaryHTML(observedSummary), /not promotion evidence/);
});
