import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_WORKLOAD_DROP_PHASE,
  isWorkloadDropBusy,
  shouldInspectDroppedTable,
  workloadDropPersonaState,
  workloadDropReducer,
  workloadDropStatus,
} from "../apps/homescreen/app/lib/workload-drop-state.mjs";
import {
  INITIAL_LOCAL_TRAINING_STATE,
  isLocalTrainingActive,
  localPredictionConfidence,
  localTrainingPhaseCopy,
  localTrainingProgress,
  localTrainingReducer,
  localTrainingTiming,
  localTrainingVerdict,
} from "../apps/homescreen/app/lib/local-training-state.mjs";

test("workload drop lifecycle maps native hover to the listening persona", () => {
  const hovering = workloadDropReducer(INITIAL_WORKLOAD_DROP_PHASE, { type: "drag_enter" });
  assert.equal(hovering, "hovering");
  assert.equal(workloadDropPersonaState(hovering), "listening");
  assert.deepEqual(workloadDropStatus(hovering), {
    title: "Drop to begin",
    detail: "One file or folder · stays on this Mac",
  });
  assert.equal(workloadDropReducer(hovering, { type: "drag_leave" }), "idle");
});

test("workload drop lifecycle follows the native compiler phases", () => {
  let phase = workloadDropReducer("hovering", { type: "drop_received" });
  assert.equal(phase, "validating");
  assert.equal(isWorkloadDropBusy(phase), true);
  assert.equal(workloadDropPersonaState(phase), "thinking");

  phase = workloadDropReducer(phase, { type: "compilation_started" });
  assert.equal(phase, "compiling");
  assert.equal(workloadDropStatus(phase)?.detail, "Indexing metadata locally · contents remain unread");

  phase = workloadDropReducer(phase, { type: "succeeded" });
  assert.equal(phase, "ready");
  assert.equal(isWorkloadDropBusy(phase), false);
  assert.equal(workloadDropPersonaState(phase), null);
});

test("busy compiler state cannot be replaced by incidental drag events", () => {
  assert.equal(workloadDropReducer("compiling", { type: "drag_enter" }), "compiling");
  assert.equal(workloadDropReducer("compiling", { type: "drag_leave" }), "compiling");
  assert.equal(workloadDropReducer("compiling", { type: "failed" }), "failed");
  assert.equal(workloadDropReducer("failed", { type: "reset" }), "idle");
});

test("explicit CSV inspection is a truthful thinking phase", () => {
  let phase = workloadDropReducer("ready", { type: "inspection_started" });
  assert.equal(phase, "inspecting");
  assert.equal(isWorkloadDropBusy(phase), true);
  assert.equal(workloadDropPersonaState(phase), "thinking");
  assert.deepEqual(workloadDropStatus(phase), {
    title: "Inspecting training data",
    detail: "Reading this table locally · source rows will not be copied",
  });
  phase = workloadDropReducer(phase, { type: "inspection_succeeded" });
  assert.equal(phase, "ready");
  assert.equal(workloadDropReducer("failed", { type: "inspection_started" }), "inspecting");
});

test("CSV drops move directly from metadata compilation into local inspection", () => {
  let phase = workloadDropReducer("compiling", { type: "inspection_started" });
  assert.equal(phase, "inspecting");
  assert.equal(workloadDropPersonaState(phase), "thinking");
  phase = workloadDropReducer(phase, { type: "inspection_succeeded" });
  assert.equal(phase, "ready");
});

test("classification dataset preparation stays busy until local splits exist", () => {
  let phase = workloadDropReducer("ready", { type: "dataset_started" });
  assert.equal(phase, "preparing_dataset");
  assert.equal(workloadDropPersonaState(phase), "thinking");
  assert.match(workloadDropStatus(phase)?.detail ?? "", /train, dev, and holdout/);
  phase = workloadDropReducer(phase, { type: "dataset_succeeded" });
  assert.equal(phase, "ready");
});

test("out-of-order completion cannot mark an idle lifecycle ready", () => {
  assert.equal(workloadDropReducer("idle", { type: "succeeded" }), "idle");
  assert.equal(workloadDropReducer("ready", { type: "failed" }), "ready");
});

test("extensionless and common delimited files enter local table inspection", () => {
  for (const source_name of ["expenses.csv", "messages.tsv", "SMSSpamCollection"]) {
    assert.equal(shouldInspectDroppedTable({
      source_name,
      source_type: "file",
      source_kinds: { "local-file": 1 },
    }), true);
  }
  assert.equal(shouldInspectDroppedTable({
    source_name: "notes.md",
    source_type: "file",
    source_kinds: { document: 1 },
  }), false);
});

test("local training follows only real runner phases and measured progress", () => {
  let state = localTrainingReducer(INITIAL_LOCAL_TRAINING_STATE, {
    type: "start",
    runId: "desktop-run-123",
  });
  assert.equal(state.phase, "preparing");
  assert.equal(isLocalTrainingActive(state), true);
  assert.deepEqual(localTrainingPhaseCopy(state.phase), [
    "Preparing",
    "Checking the local runtime and group-isolated splits",
  ]);

  state = localTrainingReducer(state, {
    type: "phase",
    event: { phase: "training", epoch: 2, current: 10, total: 25 },
  });
  assert.equal(state.phase, "training");
  assert.equal(localTrainingProgress(state.event), "Epoch 2 · 10 of 25");
  assert.equal(localTrainingProgress({ phase: "training" }), null);
});

test("training ETA waits for a measured epoch and uses completed-epoch pace", () => {
  assert.deepEqual(localTrainingTiming({
    phase: "training",
    event: { phase: "training", current: 0, total: 3 },
    runStartedAt: 1_000,
    trainingStartedAt: 2_000,
    lastEpochCompletedAt: null,
    nowMs: 12_000,
  }), {
    elapsedMs: 11_000,
    paceMs: null,
    remainingMs: null,
    completionAt: null,
    measuring: true,
  });

  assert.deepEqual(localTrainingTiming({
    phase: "training",
    event: { phase: "training", current: 1, total: 3 },
    runStartedAt: 1_000,
    trainingStartedAt: 2_000,
    lastEpochCompletedAt: 62_000,
    nowMs: 72_000,
  }), {
    elapsedMs: 71_000,
    paceMs: 60_000,
    remainingMs: 110_000,
    completionAt: 182_000,
    measuring: false,
  });
});

test("cancelling a local run cannot be overwritten by a late success", () => {
  let state = localTrainingReducer(INITIAL_LOCAL_TRAINING_STATE, {
    type: "start",
    runId: "desktop-run-123",
  });
  state = localTrainingReducer(state, { type: "cancel_requested" });
  assert.equal(state.phase, "cancelling");
  state = localTrainingReducer(state, { type: "succeeded", result: { impossible: true } });
  assert.equal(state.phase, "cancelling");
  state = localTrainingReducer(state, { type: "cancelled" });
  assert.equal(state.phase, "cancelled");
  assert.equal(isLocalTrainingActive(state), false);
});

test("failed local training remains retryable from the prepared dataset", () => {
  let state = localTrainingReducer(INITIAL_LOCAL_TRAINING_STATE, {
    type: "start",
    runId: "desktop-run-123",
  });
  state = localTrainingReducer(state, { type: "failed", error: "runtime missing" });
  assert.equal(state.phase, "failed");
  assert.equal(state.error, "runtime missing");
  state = localTrainingReducer(state, { type: "start", runId: "desktop-run-456" });
  assert.equal(state.phase, "preparing");
  assert.equal(state.runId, "desktop-run-456");
  assert.equal(state.error, null);
});

test("one-run verdict copy is cautious and flags saturated datasets", () => {
  assert.deepEqual(localTrainingVerdict({
    linear_baseline: { accuracy: 0.523, macro_f1: 0.443 },
    verdict: { status: "improved_not_ready", reason: "Weak classes remain." },
  }), {
    tone: "caution",
    title: "Improved, not ready",
    detail: "Weak classes remain.",
  });
  assert.equal(localTrainingVerdict({
    linear_baseline: { accuracy: 1, macro_f1: 1 },
    verdict: { status: "not_better", reason: "No headroom." },
  }).title, "This dataset is too easy to show model value");
});

test("prediction confidence warns without inventing certainty", () => {
  assert.equal(localPredictionConfidence(0.348), "Low confidence—review this prediction.");
  assert.equal(localPredictionConfidence(0.72), "Uncertain—review before using this prediction.");
  assert.equal(localPredictionConfidence(0.986), null);
  assert.equal(localPredictionConfidence(undefined), "Confidence unavailable—review this prediction.");
});
