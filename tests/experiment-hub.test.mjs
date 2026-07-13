import assert from "node:assert/strict";
import test from "node:test";

import {
  comparisonNextAction,
  identifyCandidateRun,
  listMatchedComparisons,
} from "../apps/homescreen/app/lib/experiment-comparison.mjs";

const candidates = [
  { id: "local-main", label: "Local main" },
  { id: "local-fast", label: "Local fast" },
];

function row(id, candidate, task, mode, score, overrides = {}) {
  return {
    id,
    run_id: `compare-1-${candidate}`,
    capture_run_id: `capture-${id}`,
    runtime_backend: "pi",
    task_id: task,
    mode,
    model: candidate,
    elapsed_ms: candidate === "local-fast" ? 100 : 300,
    prompt_tokens: 10,
    completion_tokens: candidate === "local-fast" ? 8 : 12,
    score,
    status: "ok",
    cost_usd: null,
    harness_sha256: "harness-a",
    split_sha256: "split-a",
    ...overrides,
  };
}

test("candidate identity preserves the exact parent run id", () => {
  assert.deepEqual(
    identifyCandidateRun("compare-1-local-fast", candidates),
    { candidate_id: "local-fast", parent_run_id: "compare-1" },
  );
  assert.equal(identifyCandidateRun("unrelated-run", candidates), null);
});

test("a fully captured same-hash slice is promotion-ready and rankable", () => {
  const comparison = listMatchedComparisons([
    row(1, "local-main", "task-a", "main-only", 0.8),
    row(2, "local-main", "task-b", "main-only", 0.8),
    row(3, "local-fast", "task-a", "main-only", 1),
    row(4, "local-fast", "task-b", "main-only", 1),
  ], candidates)[0];
  assert.equal(comparison.matched_slice, true);
  assert.equal(comparison.promotion_ready, true);
  assert.equal(comparison.winner_id, "local-fast");
  assert.equal(comparison.candidates[1].capture_coverage, 1);
  assert.match(comparisonNextAction(comparison).title, /harder slice/i);
});

test("matching visible rows stay directional when immutable hashes are absent", () => {
  const comparison = listMatchedComparisons([
    row(1, "local-main", "task-a", "main-only", 1, { harness_sha256: null, split_sha256: null }),
    row(2, "local-fast", "task-a", "main-only", 1, { harness_sha256: null, split_sha256: null }),
  ], candidates)[0];
  assert.equal(comparison.matched_slice, true);
  assert.equal(comparison.promotion_ready, false);
  assert.match(comparison.blockers.join(" "), /suite hashes/i);
  assert.match(comparisonNextAction(comparison).title, /directional/i);
});

test("skips, missing capture ids, and mismatched task slices block promotion", () => {
  const comparison = listMatchedComparisons([
    row(1, "local-main", "task-a", "main-only", 1),
    row(2, "local-main", "task-b", "main-only", 1),
    row(3, "local-fast", "task-a", "main-only", null, {
      capture_run_id: null,
      status: "skipped",
    }),
  ], candidates)[0];
  assert.equal(comparison.matched_slice, false);
  assert.equal(comparison.promotion_ready, false);
  assert.equal(comparison.winner_id, null);
  assert.match(comparison.blockers.join(" "), /identical task and mode slice/i);
  assert.match(comparison.blockers.join(" "), /skipped rows/i);
});

test("the newest matched parent run wins over older ledger rows", () => {
  const rows = [
    row(1, "local-main", "task-a", "main-only", 1, { run_id: "older-local-main" }),
    row(2, "local-fast", "task-a", "main-only", 1, { run_id: "older-local-fast" }),
    row(7, "local-main", "task-a", "main-only", 1, { run_id: "newer-local-main" }),
    row(8, "local-fast", "task-a", "main-only", 1, { run_id: "newer-local-fast" }),
  ];
  const comparisons = listMatchedComparisons(rows, candidates);
  assert.equal(comparisons[0].parent_run_id, "newer");
  assert.equal(comparisons[1].parent_run_id, "older");
});
