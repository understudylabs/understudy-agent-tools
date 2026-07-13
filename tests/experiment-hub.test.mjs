import assert from "node:assert/strict";
import test from "node:test";

import {
  comparisonNextAction,
  identifyCandidateRun,
  listMatchedComparisons,
  projectToolProof,
  toolProofNextAction,
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

function strictProof(overrides = {}) {
  return {
    output_dir: "/private/proof",
    evidence: { complete: true },
    summary: {
      proof_id: "tools-hard-one",
      suite: "hard",
      source_task_file: "tasks-hard.json",
      suite_sha256: "a".repeat(64),
      tool_schema_sha256: "b".repeat(64),
      task_count: 30,
      repetitions: 3,
      candidates: {
        "local-main": {
          model_id: "main-model",
          attempts: 90,
          strict_passes: 81,
          strict_accuracy: 0.9,
          terminal_errors: 0,
          mean_latency_ms: 400,
          total_tokens: 9000,
          failures: [{}],
        },
        "local-fast": {
          model_id: "fast-model",
          attempts: 90,
          strict_passes: 84,
          strict_accuracy: 0.9333,
          terminal_errors: 0,
          mean_latency_ms: 200,
          total_tokens: 7000,
          failures: [{}],
        },
      },
      ...overrides,
    },
  };
}

test("a complete three-repetition strict proof is promotion-grade", () => {
  const proof = projectToolProof(strictProof());
  assert.equal(proof.promotion_ready, true);
  assert.equal(proof.winner_id, "local-fast");
  assert.equal(proof.expected_attempts, 90);
  assert.match(toolProofNextAction(proof).title, /promotion/i);
});

test("a perfect quick proof still requires the hard frozen suite", () => {
  const proof = projectToolProof(strictProof({
    suite: "core",
    source_task_file: "tasks.json",
    task_count: 17,
    repetitions: 1,
    candidates: {
      "local-main": { attempts: 17, strict_passes: 17, strict_accuracy: 1, terminal_errors: 0, mean_latency_ms: 400, total_tokens: 1000, failures: [] },
      "local-fast": { attempts: 17, strict_passes: 17, strict_accuracy: 1, terminal_errors: 0, mean_latency_ms: 200, total_tokens: 800, failures: [] },
    },
  }));
  assert.equal(proof.promotion_ready, false);
  assert.match(proof.blockers.join(" "), /30-task hard suite/i);
  assert.match(toolProofNextAction(proof).title, /hard proof/i);
});

test("terminal errors block promotion instead of counting as model misses", () => {
  const source = strictProof();
  source.summary.candidates["local-fast"].terminal_errors = 1;
  const proof = projectToolProof(source);
  assert.equal(proof.promotion_ready, false);
  assert.match(toolProofNextAction(proof).title, /evidence path/i);
});
