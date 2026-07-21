import assert from "node:assert/strict";
import test from "node:test";

import {
  TRAINING_FLOW_KIND_ORDER,
  answersEqual,
  insertCard,
  TRAINING_FLOW_SCHEMA_VERSION,
  activeCard,
  answerCard,
  createTrainingFlow,
  deserializeTrainingFlow,
  invalidatesLaterAnswers,
  markCardLoading,
  markCardReady,
  navigateToAnswered,
  serializeTrainingFlow,
} from "../apps/homescreen/app/lib/training-flow.mjs";

const STRUCTURED_KINDS = ["data_profile", "prediction_target", "plan", "consent", "run"];

test("createTrainingFlow orders cards canonically and activates the first", () => {
  const flow = createTrainingFlow(["run", "plan", "data_profile", "consent", "prediction_target"]);
  assert.equal(flow.schema_version, TRAINING_FLOW_SCHEMA_VERSION);
  assert.deepEqual(flow.cards.map((card) => card.kind), STRUCTURED_KINDS);
  assert.deepEqual(flow.cards.map((card) => card.status), [
    "active", "pending", "pending", "pending", "pending",
  ]);
  assert.ok(flow.cards.every((card) => card.id === card.kind && card.decision === null));
  assert.equal(activeCard(flow).id, "data_profile");
});

test("createTrainingFlow rejects unknown kinds and empty flows", () => {
  assert.throws(() => createTrainingFlow(["data_profile", "mystery"]), TypeError);
  assert.throws(() => createTrainingFlow([]), TypeError);
});

test("answerCard advances focus and stamps the decision", () => {
  const flow = createTrainingFlow(STRUCTURED_KINDS);
  const next = answerCard(flow, "data_profile", {
    question: "Does this look like your data?",
    answer: "yes",
    answered_at: "2026-07-20T00:00:00Z",
  });
  assert.equal(next.cards[0].status, "answered");
  assert.deepEqual(next.cards[0].decision, {
    question: "Does this look like your data?",
    answer: "yes",
    answered_at: "2026-07-20T00:00:00Z",
  });
  assert.equal(activeCard(next).id, "prediction_target");
  // Original flow untouched (pure).
  assert.equal(flow.cards[0].status, "active");
  assert.equal(flow.cards[0].decision, null);
});

test("answerCard only accepts the active card and complete decisions", () => {
  const flow = createTrainingFlow(STRUCTURED_KINDS);
  assert.throws(() => answerCard(flow, "plan", { question: "q", answer: "yes" }), TypeError);
  assert.throws(() => answerCard(flow, "data_profile", { question: "q" }), TypeError);
  assert.throws(() => answerCard(flow, "missing", { question: "q", answer: "yes" }), TypeError);
});

test("answering the last card leaves no active card", () => {
  let flow = createTrainingFlow(["data_profile", "run"]);
  flow = answerCard(flow, "data_profile", { question: "q1", answer: "yes" });
  flow = answerCard(flow, "run", { question: "q2", answer: "yes" });
  assert.equal(activeCard(flow), null);
  assert.ok(flow.cards.every((card) => card.status === "answered"));
});

function answeredThroughPlan() {
  let flow = createTrainingFlow(STRUCTURED_KINDS);
  flow = answerCard(flow, "data_profile", { question: "data?", answer: "yes" });
  flow = answerCard(flow, "prediction_target", { question: "target?", answer: "yes" });
  flow = answerCard(flow, "plan", { question: "plan?", answer: "cloud" });
  return flow;
}

test("navigateToAnswered retreats focus and keeps later answers", () => {
  const flow = navigateToAnswered(answeredThroughPlan(), "data_profile");
  assert.equal(activeCard(flow).id, "data_profile");
  assert.equal(flow.cards[0].decision.answer, "yes"); // decision retained
  assert.equal(flow.cards[1].status, "answered");
  assert.equal(flow.cards[2].status, "answered");
  assert.equal(flow.cards[3].status, "pending"); // was active, now pending
  assert.throws(() => navigateToAnswered(flow, "run"), TypeError); // not answered
});

test("re-answering with the same value restores forward progress", () => {
  let flow = navigateToAnswered(answeredThroughPlan(), "prediction_target");
  assert.equal(invalidatesLaterAnswers(flow, "prediction_target", "yes"), false);
  flow = answerCard(flow, "prediction_target", { question: "target?", answer: "yes" });
  assert.equal(flow.cards[2].decision.answer, "cloud"); // plan answer kept
  assert.equal(activeCard(flow).id, "consent"); // back to the frontier
});

test("re-answering with a different value invalidates later steps", () => {
  let flow = navigateToAnswered(answeredThroughPlan(), "prediction_target");
  assert.equal(invalidatesLaterAnswers(flow, "prediction_target", "no"), true);
  flow = answerCard(flow, "prediction_target", { question: "target?", answer: "no" });
  assert.equal(flow.cards[1].decision.answer, "no");
  assert.equal(activeCard(flow).id, "plan");
  for (const later of flow.cards.slice(3)) {
    assert.equal(later.status, "pending");
    assert.equal(later.decision, null);
  }
});

test("markCardLoading and markCardReady only touch upcoming cards", () => {
  let flow = createTrainingFlow(STRUCTURED_KINDS);
  flow = markCardLoading(flow, "plan");
  assert.equal(flow.cards[2].status, "loading");
  flow = markCardReady(flow, "plan");
  assert.equal(flow.cards[2].status, "ready");
  // Active and answered cards are untouched.
  assert.equal(markCardReady(flow, "data_profile"), flow);
  const answered = answerCard(flow, "data_profile", { question: "q", answer: "yes" });
  assert.equal(markCardLoading(answered, "data_profile"), answered);
  // Idempotent no-op returns the same object.
  assert.equal(markCardReady(flow, "plan"), flow);
  assert.throws(() => markCardReady(flow, "missing"), TypeError);
});

test("ready upcoming cards become active on advance, and reset on invalidation", () => {
  let flow = createTrainingFlow(["data_profile", "plan", "run"]);
  flow = markCardReady(flow, "plan");
  flow = answerCard(flow, "data_profile", { question: "q", answer: "yes" });
  assert.equal(activeCard(flow).id, "plan");
  flow = navigateToAnswered(flow, "data_profile");
  flow = answerCard(flow, "data_profile", { question: "q", answer: "no" });
  assert.equal(flow.cards[2].status, "pending");
});

test("serialization round-trips exactly and stays plain JSON", () => {
  const flow = navigateToAnswered(answeredThroughPlan(), "data_profile");
  const serialized = serializeTrainingFlow(flow);
  const revived = deserializeTrainingFlow(serialized);
  assert.deepEqual(revived, flow);
  assert.equal(serializeTrainingFlow(revived), serialized);
  // Every value is serializable: no functions or class instances anywhere.
  assert.deepEqual(JSON.parse(serialized), flow);
});

test("deserializeTrainingFlow rejects malformed flows", () => {
  assert.throws(() => deserializeTrainingFlow("{}"), TypeError);
  assert.throws(
    () => deserializeTrainingFlow(JSON.stringify({ schema_version: TRAINING_FLOW_SCHEMA_VERSION, cards: [] })),
    TypeError,
  );
  const bad = answeredThroughPlan();
  const twoActive = {
    ...bad,
    cards: bad.cards.map((card) => ({ ...card, status: "active" })),
  };
  assert.throws(() => deserializeTrainingFlow(JSON.stringify(twoActive)), TypeError);
  const badKind = { schema_version: TRAINING_FLOW_SCHEMA_VERSION, cards: [{ id: "x", kind: "x", status: "active", decision: null }] };
  assert.throws(() => deserializeTrainingFlow(JSON.stringify(badKind)), TypeError);
  const badDecision = {
    schema_version: TRAINING_FLOW_SCHEMA_VERSION,
    cards: [{ id: "run", kind: "run", status: "answered", decision: { answer: "yes" } }],
  };
  assert.throws(() => deserializeTrainingFlow(JSON.stringify(badDecision)), TypeError);
});

test("decision details are recorded verbatim and survive serialization", () => {
  let flow = createTrainingFlow(STRUCTURED_KINDS);
  flow = answerCard(flow, "data_profile", { question: "data?", answer: "yes" });
  // The editable goal card: the edited goal is the answer; the structured
  // record (goal, target column, acceptable-error gate) rides in details.
  flow = answerCard(flow, "prediction_target", {
    question: "What should the model learn to do?",
    answer: "Predict the ticket priority from its subject and body.",
    details: {
      target_goal: "Predict the ticket priority from its subject and body.",
      target_column: "priority",
      minimum_accuracy: 0.85,
      minimum_accuracy_applied: false,
    },
  });
  assert.equal(flow.cards[1].decision.details.minimum_accuracy, 0.85);
  const revived = deserializeTrainingFlow(serializeTrainingFlow(flow));
  assert.deepEqual(revived, flow);
});

test("editing the goal answer invalidates later steps; same goal restores", () => {
  let flow = createTrainingFlow(STRUCTURED_KINDS);
  flow = answerCard(flow, "data_profile", { question: "data?", answer: "yes" });
  flow = answerCard(flow, "prediction_target", { question: "goal?", answer: "Predict priority." });
  flow = answerCard(flow, "plan", { question: "plan?", answer: "cloud" });
  let back = navigateToAnswered(flow, "prediction_target");
  assert.equal(invalidatesLaterAnswers(back, "prediction_target", "Predict priority."), false);
  assert.equal(invalidatesLaterAnswers(back, "prediction_target", "Predict severity."), true);
  back = answerCard(back, "prediction_target", { question: "goal?", answer: "Predict severity." });
  assert.equal(back.cards[2].decision, null); // plan invalidated
  assert.equal(activeCard(back).id, "plan");
});

test("insertCard slots calibration after plan once, preserving state", () => {
  const csvKinds = ["data_profile", "prediction_target", "plan", "backend", "run"];
  let flow = createTrainingFlow(csvKinds);
  flow = answerCard(flow, "data_profile", { question: "data?", answer: "yes" });
  flow = answerCard(flow, "prediction_target", { question: "target?", answer: "label" });
  // Plan is active; prepare reported excluded rows → calibration slots in.
  flow = insertCard(flow, "calibration");
  assert.deepEqual(
    flow.cards.map((card) => card.kind),
    ["data_profile", "prediction_target", "plan", "calibration", "backend", "run"],
  );
  assert.equal(flow.cards[3].status, "pending");
  assert.equal(activeCard(flow).id, "plan"); // untouched
  assert.equal(flow.cards[0].status, "answered"); // untouched
  // Idempotent: same flow object back when the kind exists.
  assert.equal(insertCard(flow, "calibration"), flow);
  // Answering plan focuses the inserted card.
  flow = answerCard(flow, "plan", { question: "plan?", answer: "yes" });
  assert.equal(activeCard(flow).id, "calibration");
  // Round-trips like any other card.
  assert.deepEqual(deserializeTrainingFlow(serializeTrainingFlow(flow)), flow);
});

test("insertCard rejects unknown kinds and slots at or before the active card", () => {
  const flow = createTrainingFlow(["prediction_target", "run"]); // prediction_target active
  assert.throws(() => insertCard(flow, "mystery"), TypeError);
  // data_profile would land before the active card — upcoming cards only.
  assert.throws(() => insertCard(flow, "data_profile"), TypeError);
});

test("kind order constant covers every card kind exactly once", () => {
  assert.deepEqual([...new Set(TRAINING_FLOW_KIND_ORDER)], [...TRAINING_FLOW_KIND_ORDER]);
  const flow = createTrainingFlow([...TRAINING_FLOW_KIND_ORDER]);
  assert.equal(flow.cards.length, TRAINING_FLOW_KIND_ORDER.length);
});

// ---- Conditional kinds, mid-flow insertion, value-object answers ---------

test("calibration is a conditional kind: absent unless asked for, canonical when present", () => {
  const without = createTrainingFlow(["data_profile", "plan", "run"]);
  assert.ok(without.cards.every((card) => card.kind !== "calibration"));
  const withIt = createTrainingFlow(["run", "calibration", "plan", "data_profile"]);
  assert.deepEqual(withIt.cards.map((card) => card.kind), [
    "data_profile", "plan", "calibration", "run",
  ]);
});

test("insertCard slots a discovered kind at its canonical position as pending", () => {
  let flow = createTrainingFlow(["data_profile", "prediction_target", "plan", "backend", "run"]);
  flow = answerCard(flow, "data_profile", { question: "data?", answer: "yes" });
  flow = answerCard(flow, "prediction_target", { question: "target?", answer: "yes" });
  const inserted = insertCard(flow, "calibration");
  assert.deepEqual(inserted.cards.map((card) => card.kind), [
    "data_profile", "prediction_target", "plan", "calibration", "backend", "run",
  ]);
  assert.equal(inserted.cards[3].status, "pending");
  assert.equal(inserted.cards[3].decision, null);
  // Answering the active plan card advances focus INTO the inserted card.
  const answered = answerCard(inserted, "plan", { question: "plan?", answer: "yes" });
  assert.equal(activeCard(answered).id, "calibration");
  // Idempotent: same object back when the kind already exists.
  assert.equal(insertCard(inserted, "calibration"), inserted);
  // Unknown kinds and insertion at/before the active card are errors.
  assert.throws(() => insertCard(flow, "mystery"), TypeError);
  assert.throws(() => insertCard(createTrainingFlow(["compile_gates", "run"]), "calibration"), TypeError);
});

test("answers can be label-choice value objects, compared structurally", () => {
  const correction = { choice: "correct", label: "spam", of_labels: ["spam", "ham"] };
  let flow = createTrainingFlow(["calibration", "backend", "run"]);
  flow = answerCard(flow, "calibration", { question: "label?", answer: correction });
  assert.deepEqual(flow.cards[0].decision.answer, correction);
  // The stored answer is a JSON clone, not the caller's mutable object.
  correction.label = "ham";
  assert.equal(flow.cards[0].decision.answer.label, "spam");
  flow = answerCard(flow, "backend", { question: "where?", answer: "local" });
  flow = navigateToAnswered(flow, "calibration");
  // Structural equality (key order irrelevant): same value restores progress.
  const same = { of_labels: ["spam", "ham"], label: "spam", choice: "correct" };
  assert.equal(invalidatesLaterAnswers(flow, "calibration", same), false);
  flow = answerCard(flow, "calibration", { question: "label?", answer: same });
  assert.equal(flow.cards[1].decision.answer, "local");
  assert.equal(activeCard(flow).id, "run");
  // A different value object invalidates later answers.
  flow = navigateToAnswered(flow, "calibration");
  const changed = { choice: "ambiguous" };
  assert.equal(invalidatesLaterAnswers(flow, "calibration", changed), true);
  flow = answerCard(flow, "calibration", { question: "label?", answer: changed });
  assert.equal(flow.cards[1].decision, null);
  assert.equal(activeCard(flow).id, "backend");
});

test("answersEqual compares plain JSON structurally", () => {
  assert.equal(answersEqual("yes", "yes"), true);
  assert.equal(answersEqual("yes", "no"), false);
  assert.equal(answersEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true);
  assert.equal(answersEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(answersEqual([1, 2], [2, 1]), false);
  assert.equal(answersEqual({ a: null }, { a: null }), true);
  assert.equal(answersEqual({ a: undefined }, {}), true); // undefined drops in JSON
  assert.equal(answersEqual(null, {}), false);
});

test("decision details are recorded as a JSON clone", () => {
  const details = { minimum_accuracy: 0.85, target_column: "label", applied: false };
  let flow = createTrainingFlow(["prediction_target", "plan"]);
  flow = answerCard(flow, "prediction_target", { question: "goal?", answer: "yes", details });
  details.minimum_accuracy = 0.5;
  assert.equal(flow.cards[0].decision.details.minimum_accuracy, 0.85);
});

test("value-object answers and details round-trip through serialization", () => {
  let flow = createTrainingFlow(["data_profile", "calibration", "run"]);
  flow = answerCard(flow, "data_profile", { question: "data?", answer: "yes" });
  flow = answerCard(flow, "calibration", {
    question: "Proceed without the 7 excluded rows?",
    answer: { choice: "confirm" },
    details: {
      conflicted_group_rows_removed: 5,
      unusable_rows_removed: 2,
      reviewed_examples: [
        { group: "g1", label: "spam", verdict: "yes", choice: "confirm" },
        // Forward-compatible clarification-queue shape: a per-example label
        // correction with the candidates that were on offer.
        { group: "g2", label: "spam", verdict: "no", choice: "correct", corrected_label: "ham", of_labels: ["spam", "ham"] },
        { group: "g3", label: "ham", verdict: "no", choice: "ambiguous", of_labels: ["spam", "ham"] },
      ],
      verdicts_applied: false,
    },
    answered_at: "2026-07-20T00:00:00Z",
  });
  const serialized = serializeTrainingFlow(flow);
  const revived = deserializeTrainingFlow(serialized);
  assert.deepEqual(revived, flow);
  assert.equal(serializeTrainingFlow(revived), serialized);
  assert.deepEqual(JSON.parse(serialized), flow);
});
