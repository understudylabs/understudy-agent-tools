// Decision-card model for the "20 questions" training flow.
//
// THIS MODULE IS THE CONTRACT for follow-up work that persists the flow:
// every value in a flow is plain JSON — no components, functions, or class
// instances — so a flow can be serialized, stored, and rehydrated verbatim.
//
// Shape (understudy.training_flow.v1):
//   TrainingFlow = {
//     schema_version: "understudy.training_flow.v1",
//     cards: TrainingFlowCard[],           // deterministic order, one per kind
//   }
//   TrainingFlowCard = {
//     id: string,                          // stable; equals the kind
//     kind: "data_profile" | "prediction_target" | "plan" | "compile_gates"
//         | "backend" | "consent" | "run" | "outcome",
//     status: "pending" | "loading" | "ready" | "answered" | "active",
//     decision: null | {
//       question: string,                  // the yes/no-shaped question shown
//       answer: "yes" | "no" | string,     // "yes"/"no" or a scoped value
//       answered_at: string,               // ISO-8601 timestamp
//     },
//   }
//
// Exactly one card is "active" at a time (the focus surface). "answered"
// cards precede it; "pending"/"loading"/"ready" cards follow it. Readiness
// of upcoming cards is advisory — the UI keeps invoking work eagerly and
// shows an in-place loading state on the active card when its data is not
// ready yet.

export const TRAINING_FLOW_SCHEMA_VERSION = "understudy.training_flow.v1";

/** Canonical ordering; a concrete flow uses the subset of kinds that apply. */
export const TRAINING_FLOW_KIND_ORDER = Object.freeze([
  "data_profile",
  "prediction_target",
  "plan",
  "compile_gates",
  "backend",
  "consent",
  "run",
  "outcome",
]);

/** Compact step-rail labels, keyed by card kind. */
export const TRAINING_FLOW_KIND_LABELS = Object.freeze({
  data_profile: "Data",
  prediction_target: "Target",
  plan: "Plan",
  compile_gates: "Gates",
  backend: "Backend",
  consent: "Approve",
  run: "Run",
  outcome: "Outcome",
});

const UPCOMING_STATUSES = new Set(["pending", "loading", "ready"]);

function assertKnownKinds(kinds) {
  for (const kind of kinds) {
    if (!TRAINING_FLOW_KIND_ORDER.includes(kind)) {
      throw new TypeError(`Unknown training-flow card kind: ${String(kind)}`);
    }
  }
}

function cardIndex(flow, id) {
  const index = flow.cards.findIndex((card) => card.id === id);
  if (index < 0) throw new TypeError(`Unknown training-flow card: ${String(id)}`);
  return index;
}

function withCards(flow, cards) {
  return { schema_version: TRAINING_FLOW_SCHEMA_VERSION, cards };
}

/**
 * Create a flow from the kinds that apply to this dataset. Order is always
 * canonical regardless of the order kinds are passed in; the first card is
 * active, the rest pending.
 */
export function createTrainingFlow(kinds) {
  assertKnownKinds(kinds);
  const unique = TRAINING_FLOW_KIND_ORDER.filter((kind) => kinds.includes(kind));
  if (unique.length === 0) throw new TypeError("A training flow needs at least one card kind.");
  return withCards(null, unique.map((kind, index) => ({
    id: kind,
    kind,
    status: index === 0 ? "active" : "pending",
    decision: null,
  })));
}

/** The card currently occupying the focus surface, or null if none. */
export function activeCard(flow) {
  return flow.cards.find((card) => card.status === "active") ?? null;
}

/**
 * Would answering `id` with `answer` throw away later answered steps?
 * True only when the card was already answered with a different value and at
 * least one later card holds an answer. Use to gate a confirmation prompt.
 */
export function invalidatesLaterAnswers(flow, id, answer) {
  const index = cardIndex(flow, id);
  const card = flow.cards[index];
  if (!card.decision || card.decision.answer === answer) return false;
  return flow.cards.slice(index + 1).some((later) => later.decision !== null);
}

/**
 * Answer the active card. Advances focus to the next card:
 * - Re-answering with the SAME value (after navigating back) restores the
 *   flow — later answers are kept and focus returns to the first unanswered
 *   card after it.
 * - A NEW or CHANGED answer invalidates everything after: later decisions
 *   are cleared and their statuses reset to "pending"; the next card becomes
 *   "active". Answering the last card leaves no active card.
 */
export function answerCard(flow, id, decision) {
  const index = cardIndex(flow, id);
  const card = flow.cards[index];
  if (card.status !== "active") {
    throw new TypeError(`Card ${id} is not active (status: ${card.status}).`);
  }
  if (typeof decision?.question !== "string" || decision.answer == null) {
    throw new TypeError("A decision needs a question and an answer.");
  }
  const next = {
    question: decision.question,
    answer: decision.answer,
    answered_at: decision.answered_at ?? new Date().toISOString(),
  };
  const sameAnswer = card.decision !== null && card.decision.answer === next.answer;
  const cards = flow.cards.map((existing, at) => {
    if (at < index) return existing;
    if (at === index) return { ...existing, status: "answered", decision: next };
    if (sameAnswer) return existing;
    return { ...existing, status: "pending", decision: null };
  });
  const focusAt = cards.findIndex(
    (existing, at) => at > index && existing.status !== "answered",
  );
  if (focusAt >= 0) cards[focusAt] = { ...cards[focusAt], status: "active" };
  return withCards(flow, cards);
}

/**
 * Navigate back to an answered card. It becomes active again (its decision
 * is retained until re-answered); the card that was active reverts to
 * "pending". Later answered cards keep their answers until the revisited
 * card is re-answered with a different value.
 */
export function navigateToAnswered(flow, id) {
  const index = cardIndex(flow, id);
  if (flow.cards[index].status !== "answered") {
    throw new TypeError(`Card ${id} has not been answered yet.`);
  }
  const cards = flow.cards.map((card, at) => {
    if (at === index) return { ...card, status: "active" };
    if (card.status === "active") return { ...card, status: "pending" };
    return card;
  });
  return withCards(flow, cards);
}

/** Mark an upcoming card's background work as in flight. No-op otherwise. */
export function markCardLoading(flow, id) {
  return setUpcomingStatus(flow, id, "loading");
}

/** Mark an upcoming card's data as preloaded and ready. No-op otherwise. */
export function markCardReady(flow, id) {
  return setUpcomingStatus(flow, id, "ready");
}

function setUpcomingStatus(flow, id, status) {
  const index = cardIndex(flow, id);
  const card = flow.cards[index];
  if (!UPCOMING_STATUSES.has(card.status) || card.status === status) return flow;
  const cards = [...flow.cards];
  cards[index] = { ...card, status };
  return withCards(flow, cards);
}

/** Serialize to a JSON string; the exact inverse of deserializeTrainingFlow. */
export function serializeTrainingFlow(flow) {
  return JSON.stringify(flow);
}

/** Parse and validate a serialized flow; throws on any shape violation. */
export function deserializeTrainingFlow(serialized) {
  const flow = JSON.parse(serialized);
  if (flow?.schema_version !== TRAINING_FLOW_SCHEMA_VERSION) {
    throw new TypeError("Not a training flow: bad schema_version.");
  }
  if (!Array.isArray(flow.cards) || flow.cards.length === 0) {
    throw new TypeError("Not a training flow: missing cards.");
  }
  let activeSeen = 0;
  for (const card of flow.cards) {
    if (!TRAINING_FLOW_KIND_ORDER.includes(card.kind) || card.id !== card.kind) {
      throw new TypeError(`Invalid training-flow card: ${JSON.stringify(card)}`);
    }
    if (!["pending", "loading", "ready", "answered", "active"].includes(card.status)) {
      throw new TypeError(`Invalid card status: ${String(card.status)}`);
    }
    if (card.status === "active") activeSeen += 1;
    if (card.decision !== null) {
      const { question, answer, answered_at } = card.decision;
      if (typeof question !== "string" || answer == null || typeof answered_at !== "string") {
        throw new TypeError(`Invalid card decision on ${card.id}.`);
      }
    }
  }
  if (activeSeen > 1) throw new TypeError("A training flow has at most one active card.");
  return { schema_version: flow.schema_version, cards: flow.cards.map((card) => ({ ...card })) };
}
