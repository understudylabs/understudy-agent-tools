import assert from "node:assert/strict";
import test from "node:test";

import {
  TRAINING_FLOW_KIND_ORDER,
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

test("kind order constant covers every card kind exactly once", () => {
  assert.deepEqual([...new Set(TRAINING_FLOW_KIND_ORDER)], [...TRAINING_FLOW_KIND_ORDER]);
  const flow = createTrainingFlow([...TRAINING_FLOW_KIND_ORDER]);
  assert.equal(flow.cards.length, TRAINING_FLOW_KIND_ORDER.length);
});
