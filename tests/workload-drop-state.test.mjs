import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_WORKLOAD_DROP_PHASE,
  isWorkloadDropBusy,
  workloadDropPersonaState,
  workloadDropReducer,
  workloadDropStatus,
} from "../apps/homescreen/app/lib/workload-drop-state.mjs";

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
    detail: "Reading this CSV locally · source rows will not be copied",
  });
  phase = workloadDropReducer(phase, { type: "inspection_succeeded" });
  assert.equal(phase, "ready");
  assert.equal(workloadDropReducer("failed", { type: "inspection_started" }), "inspecting");
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
