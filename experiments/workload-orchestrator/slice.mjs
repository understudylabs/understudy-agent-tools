/**
 * Workload slice: WL-OR (synthetic workload "orchestrator").
 *
 * A named subset of the published `synthetic-workflow-shapes-offline-v2`
 * fixture whose task shape mirrors this workload: a multi-step controller that
 * reads a conversation, updates an entity or agent state, edits a document,
 * and persists a completion summary. Nothing here creates new tasks — the
 * slice only selects families, so every frozen fixture hash still holds.
 *
 * Splits are inherited from the fixture (never re-drawn), so a task that is
 * dev or holdout in the fixture stays dev or holdout in the slice.
 */
import { createHash } from "node:crypto";

import {
  FROZEN_HOLDOUT_SHA256,
  TASKS,
  canonicalJson,
  taskBands,
  taskPool,
} from "../../dist/synthetic-workflow-offline.js";

export const SLICE = {
  slice_id: "wl-or-orchestrator-v1",
  workload_code: "WL-OR",
  fixture_id: "synthetic-workflow-shapes-offline-v2",
  benchmark_id: "synthetic-workflow-shapes-offline",
  families: [
    "multi-step-orchestrator-chain",
    "summary-orchestration",
    "agent-state-synchronization",
    "agent-state-partial-failure",
    "document-preservation",
  ],
};

const FAMILY_SET = new Set(SLICE.families);

export const inSlice = (task) => FAMILY_SET.has(task.family);

export const SLICE_TASKS = TASKS.filter(inSlice);

export const SLICE_BANDS = Object.fromEntries(
  Object.entries(taskBands()).filter(([family]) => FAMILY_SET.has(family)),
);

/** Fixture split membership, restricted to the slice. Holdout stays sealed. */
export function slicePool(split, frozenHoldoutSha256) {
  return taskPool({ split, frozenHoldoutSha256 }).filter(inSlice);
}

export function sliceSplitSha256(split) {
  const rows = SLICE_TASKS
    .filter((task) => task.split === split)
    .map((task) => ({ task_id: task.taskId, assertions: task.assertions }));
  return createHash("sha256").update(canonicalJson(rows)).digest("hex");
}

export function sliceSha256() {
  return createHash("sha256")
    .update(canonicalJson({ slice: SLICE, tasks: SLICE_TASKS }))
    .digest("hex");
}

export function sliceCounts() {
  return SLICE_TASKS.reduce(
    (counts, task) => ({ ...counts, [task.split]: counts[task.split] + 1 }),
    { train: 0, dev: 0, holdout: 0 },
  );
}

export { FROZEN_HOLDOUT_SHA256 };
