import assert from "node:assert/strict";
import test from "node:test";

import {
  accumulateLossPoints,
  baselineScorePercent,
  detectPlateau,
  formatEta,
  formatWait,
  lossSparklineGeometry,
  narrationFeed,
  progressHeadline,
} from "../apps/homescreen/app/lib/training-run-view.mjs";

test("loss accumulation merges poll deltas, dedupes by step, and stays sorted", () => {
  const first = accumulateLossPoints([], [
    { step: 10, value: 1.2 },
    { step: 0, value: 2.0 },
  ]);
  assert.deepEqual(first.map((p) => p.step), [0, 10]);

  const second = accumulateLossPoints(first, [
    { step: 10, value: 1.1 }, // re-emitted step: latest value wins
    { step: 20, value: 0.9 },
    { step: Number.NaN, value: 1 }, // malformed points are dropped
  ]);
  assert.deepEqual(second, [
    { step: 0, value: 2.0 },
    { step: 10, value: 1.1 },
    { step: 20, value: 0.9 },
  ]);

  // empty delta returns the same array (no re-render churn)
  assert.equal(accumulateLossPoints(second, []), second);
  assert.equal(accumulateLossPoints(second, undefined), second);
});

test("plateau detection marks a flat tail and stays quiet while loss still moves", () => {
  const falling = Array.from({ length: 20 }, (_, i) => ({ step: i, value: 2 - i * 0.1 }));
  assert.equal(detectPlateau(falling), null);

  const flattened = [
    ...Array.from({ length: 10 }, (_, i) => ({ step: i, value: 2 - i * 0.18 })),
    ...Array.from({ length: 8 }, (_, i) => ({ step: 10 + i, value: 0.38 + (i % 2) * 0.001 })),
  ];
  const index = detectPlateau(flattened);
  assert.equal(index, flattened.length - 6);

  // too short to judge
  assert.equal(detectPlateau(flattened.slice(0, 5)), null);
});

test("ETA and queue-wait copy", () => {
  assert.equal(formatEta(45), "about a minute left");
  assert.equal(formatEta(480), "about 8m left");
  assert.equal(formatEta(7_500), "about 2h 5m left");
  assert.equal(formatEta(7_200), "about 2h left");
  assert.equal(formatEta(undefined), null);
  assert.equal(formatEta(-3), null);
  assert.equal(formatWait(42), "42s in line");
  assert.equal(formatWait(300), "5m in line");
  assert.equal(formatWait(null), null);
});

test("progress headline is phase-aware", () => {
  assert.deepEqual(progressHeadline(undefined), { title: "Starting", detail: null });

  const queued = progressHeadline({
    phase: "provider_queue",
    message: "Waiting for capacity.",
    details: { queue_seconds: 95, elapsed_seconds: 120, estimated_spend_usd: 0 },
  });
  assert.equal(queued.title, "Waiting for a training machine");
  assert.equal(queued.detail, "1m in line");

  // queued with no queue_seconds still reads intentionally
  assert.equal(progressHeadline({ phase: "provider_queue", message: "x" }).detail, null);

  const training = progressHeadline({
    phase: "training",
    message: "Loss is dropping.",
    progress: { completed: 2, total: 3, unit: "epochs", epoch: 2, total_epochs: 3, step: 1_240 },
    details: { estimated_remaining_seconds: 540, elapsed_seconds: 300, estimated_spend_usd: 0.42 },
  });
  assert.equal(training.title, "Training — pass 2 of 3 · step 1,240");
  assert.equal(training.detail, "about 9m left · $0.42 so far");

  // queued providers omit the ETA entirely; spend of 0 never shows
  const early = progressHeadline({
    phase: "training",
    message: "Started.",
    progress: { completed: 0, total: 100, unit: "percent", percent: 4 },
    details: { elapsed_seconds: 10, estimated_spend_usd: 0 },
  });
  assert.equal(early.title, "Training — 4%");
  assert.equal(early.detail, null);

  assert.equal(progressHeadline({ phase: "evaluation", message: "x" }).title, "Evaluating");
  assert.equal(progressHeadline({ phase: "deployment", message: "x" }).title, "Preparing your model");
  assert.equal(progressHeadline({ phase: "cleanup", message: "x" }).title, "Finishing safely");
  assert.equal(progressHeadline({ phase: "upload", message: "x" }).title, "Starting");
});

test("baseline score reads completed baseline_evaluation events, fraction or percent", () => {
  assert.equal(baselineScorePercent([]), null);
  assert.equal(
    baselineScorePercent([
      { type: "baseline_evaluation", message: "Testing the untrained model.", details: { stage: "started" } },
    ]),
    null,
  );
  assert.equal(
    baselineScorePercent([
      { type: "baseline_evaluation", message: "Done.", details: { stage: "completed", score: 0.66 } },
    ]),
    66,
  );
  assert.equal(
    baselineScorePercent([
      { type: "baseline_evaluation", message: "Done.", details: { stage: "completed", aggregate_score: 71 } },
    ]),
    71,
  );
});

test("narration feed keeps the last four verbatim messages and rewrites completed baselines", () => {
  const events = [
    { sequence: 1, type: "run_created", occurred_at: "2026-07-20T10:00:00Z", message: "Run created." },
    { sequence: 2, type: "training_progress", message: "Uploading your data." },
    { sequence: 3, type: "training_progress", message: "Uploading your data." }, // consecutive dupe collapses
    { sequence: 4, type: "baseline_evaluation", message: "Baseline test finished.", details: { stage: "completed", score: 0.66 } },
    { sequence: 5, type: "training_progress", message: "Loss is dropping steadily." },
    { sequence: 6, type: "training_progress", message: "Halfway through pass two." },
  ];
  const feed = narrationFeed(events, 4);
  assert.equal(feed.length, 4);
  assert.deepEqual(feed.map((line) => line.text), [
    "Uploading your data.",
    "Untrained model scores 66% — that's the bar to beat.",
    "Loss is dropping steadily.",
    "Halfway through pass two.",
  ]);
  assert.equal(feed[1].kind, "baseline");
  assert.equal(feed[2].kind, "narration");
});

test("sparkline geometry needs two points and labels the latest value", () => {
  assert.equal(lossSparklineGeometry([]), null);
  assert.equal(lossSparklineGeometry([{ step: 0, value: 1 }]), null);

  const geometry = lossSparklineGeometry(
    [
      { step: 0, value: 2 },
      { step: 50, value: 1 },
      { step: 100, value: 0.5 },
    ],
    { width: 100, height: 50, pad: 0 },
  );
  assert.ok(geometry);
  assert.equal(geometry.latest.step, 100);
  assert.equal(geometry.latest.value, 0.5);
  assert.equal(geometry.latest.x, 100); // max step maps to right edge
  assert.equal(geometry.latest.y, 50); // min loss maps to bottom of the value band... top is max
  const first = geometry.at(0);
  assert.deepEqual(first, { x: 0, y: 0 }); // max loss at the top-left
  assert.equal(geometry.at(99), null);
  assert.match(geometry.area, /0,50$/); // area closes along the baseline
});
