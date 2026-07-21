import test from "node:test";
import assert from "node:assert/strict";

import {
  createTrainingFlow,
  answerCard,
} from "../apps/homescreen/app/lib/training-flow.mjs";
import {
  TRAINING_THREAD_STATUSES,
  trainingThreadStatusGlyph,
  trainingThreadTarget,
  trainingThreadTitle,
} from "../apps/homescreen/app/lib/training-threads.mjs";

const CSV_KINDS = ["data_profile", "prediction_target", "plan", "backend", "run"];

function flowWithTarget(answer, details) {
  let flow = createTrainingFlow(CSV_KINDS);
  flow = answerCard(flow, "data_profile", {
    question: "Does this look right?",
    answer: "yes",
  });
  return answerCard(flow, "prediction_target", {
    question: "What should the model predict?",
    answer,
    ...(details === undefined ? {} : { details }),
  });
}

test("thread title is the source name before a target is decided", () => {
  assert.equal(trainingThreadTitle("tickets.csv", null), "tickets.csv");
  assert.equal(trainingThreadTitle("tickets.csv", createTrainingFlow(CSV_KINDS)), "tickets.csv");
  assert.equal(trainingThreadTitle("  ", null), "Dropped workload");
});

test("thread title appends the confirmed target from decision details", () => {
  const flow = flowWithTarget("priority", { target_column: "priority" });
  assert.equal(trainingThreadTarget(flow), "priority");
  assert.equal(trainingThreadTitle("tickets.csv", flow), "tickets.csv → priority");
});

test("free-form goal answers become the target; yes/no answers do not", () => {
  const goal = flowWithTarget("Predict the escalation tier for each ticket");
  assert.equal(
    trainingThreadTarget(goal),
    "Predict the escalation tier for each ticket",
  );
  const confirmed = flowWithTarget("yes");
  assert.equal(trainingThreadTarget(confirmed), null);
  assert.equal(trainingThreadTitle("tickets.csv", confirmed), "tickets.csv");
});

test("long targets are truncated in the title, not in the target itself", () => {
  const long = "x".repeat(120);
  const flow = flowWithTarget(long, { target_column: long });
  assert.equal(trainingThreadTarget(flow), long);
  const title = trainingThreadTitle("tickets.csv", flow);
  assert.ok(title.endsWith("…"));
  assert.ok(title.length < `tickets.csv → ${long}`.length);
});

test("status glyphs follow the kind-boundary treatment", () => {
  assert.deepEqual(TRAINING_THREAD_STATUSES, ["active", "completed", "dismissed"]);
  assert.deepEqual(trainingThreadStatusGlyph("active"), {
    className: "thread-status-glyph active",
    label: "In progress",
  });
  assert.deepEqual(trainingThreadStatusGlyph("completed"), {
    className: "thread-status-glyph completed",
    label: "Completed",
  });
  // Unknown statuses degrade to the muted treatment rather than lying.
  assert.equal(trainingThreadStatusGlyph("weird").className, "thread-status-glyph dismissed");
  assert.equal(trainingThreadStatusGlyph("dismissed").label, "Dismissed");
});
