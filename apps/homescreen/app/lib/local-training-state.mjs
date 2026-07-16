export const INITIAL_LOCAL_TRAINING_STATE = Object.freeze({
  phase: "idle",
  event: null,
  result: null,
  error: null,
  runId: null,
});

const ACTIVE_PHASES = new Set([
  "preparing",
  "downloading",
  "training",
  "evaluating",
  "saving",
  "cancelling",
]);

const RUNNER_PHASES = new Set([
  "preparing",
  "downloading",
  "training",
  "evaluating",
  "saving",
]);

export function localTrainingReducer(state, action) {
  switch (action.type) {
    case "start":
      return {
        phase: "preparing",
        event: { phase: "preparing" },
        result: null,
        error: null,
        runId: action.runId,
      };
    case "phase":
      if (!ACTIVE_PHASES.has(state.phase) || state.phase === "cancelling") return state;
      if (!RUNNER_PHASES.has(action.event.phase)) return state;
      return { ...state, phase: action.event.phase, event: action.event };
    case "cancel_requested":
      return ACTIVE_PHASES.has(state.phase) && state.phase !== "cancelling"
        ? { ...state, phase: "cancelling" }
        : state;
    case "cancelled":
      return ACTIVE_PHASES.has(state.phase)
        ? { ...state, phase: "cancelled", event: null, error: null }
        : state;
    case "succeeded":
      return ACTIVE_PHASES.has(state.phase) && state.phase !== "cancelling"
        ? { ...state, phase: "completed", event: null, result: action.result, error: null }
        : state;
    case "failed":
      return ACTIVE_PHASES.has(state.phase)
        ? { ...state, phase: "failed", event: null, error: action.error, result: null }
        : state;
    case "reset":
      return INITIAL_LOCAL_TRAINING_STATE;
    default:
      return state;
  }
}

export function isLocalTrainingActive(state) {
  return ACTIVE_PHASES.has(state.phase);
}

export function localTrainingProgress(event) {
  if (!event) return null;
  const current = Number.isSafeInteger(event.current) ? event.current : null;
  const total = Number.isSafeInteger(event.total) && event.total > 0 ? event.total : null;
  const measured = current !== null && total !== null && current <= total
    ? `${current} of ${total}`
    : null;
  const epoch = Number.isSafeInteger(event.epoch) && event.epoch > 0
    ? `Epoch ${event.epoch}`
    : null;
  return [epoch, measured].filter(Boolean).join(" · ") || null;
}

export function localTrainingTiming({
  phase,
  event,
  runStartedAt,
  trainingStartedAt,
  lastEpochCompletedAt,
  nowMs,
}) {
  if (!Number.isFinite(runStartedAt) || !Number.isFinite(nowMs) || nowMs < runStartedAt) return null;
  const elapsedMs = nowMs - runStartedAt;
  const timing = {
    elapsedMs,
    paceMs: null,
    remainingMs: null,
    completionAt: null,
    measuring: false,
  };
  if (phase !== "training") return timing;

  const current = Number.isSafeInteger(event?.current) ? event.current : 0;
  const total = Number.isSafeInteger(event?.total) && event.total > 0 ? event.total : null;
  if (
    !Number.isFinite(trainingStartedAt) ||
    !Number.isFinite(lastEpochCompletedAt) ||
    lastEpochCompletedAt <= trainingStartedAt ||
    current < 1 ||
    total === null ||
    current > total
  ) {
    return { ...timing, measuring: true };
  }

  const paceMs = (lastEpochCompletedAt - trainingStartedAt) / current;
  const trainingElapsedMs = Math.max(0, nowMs - trainingStartedAt);
  const remainingMs = Math.max(0, paceMs * total - trainingElapsedMs);
  return {
    ...timing,
    paceMs,
    remainingMs,
    completionAt: nowMs + remainingMs,
    measuring: false,
  };
}

export function localTrainingPhaseCopy(phase) {
  switch (phase) {
    case "preparing":
      return ["Preparing", "Checking the local runtime and group-isolated splits"];
    case "downloading":
      return ["Loading model", "Reusing cached runtime and weights; only missing files download"];
    case "training":
      return ["Training", "Teaching a local classifier from the verified training split"];
    case "evaluating":
      return ["Evaluating", "Comparing the trained model with the baseline on untouched rows"];
    case "saving":
      return ["Saving", "Writing the model and immutable run evidence locally"];
    case "cancelling":
      return ["Stopping", "Finishing the current safe checkpoint"];
    default:
      return null;
  }
}

export function localTrainingVerdict(result) {
  if (result.linear_baseline.accuracy >= 0.99 && result.linear_baseline.macro_f1 >= 0.99) {
    return {
      tone: "neutral",
      title: "This dataset is too easy to show model value",
      detail: "The deterministic TF-IDF baseline already scores 100% on the group-isolated holdout. Use a harder or more varied dataset before choosing a model.",
    };
  }
  switch (result.verdict.status) {
    case "promising":
      return {
        tone: "positive",
        title: "Promising, needs another run",
        detail: result.verdict.reason,
      };
    case "improved_not_ready":
      return {
        tone: "caution",
        title: "Improved, not ready",
        detail: result.verdict.reason,
      };
    default:
      return {
        tone: "caution",
        title: "No model value yet",
        detail: result.verdict.reason,
      };
  }
}

export function localPredictionConfidence(score) {
  if (!Number.isFinite(score)) return "Confidence unavailable—review this prediction.";
  if (score < 0.6) return "Low confidence—review this prediction.";
  if (score < 0.8) return "Uncertain—review before using this prediction.";
  return null;
}
