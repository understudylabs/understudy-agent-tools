export const INITIAL_WORKLOAD_DROP_PHASE = "idle";

const BUSY_PHASES = new Set(["validating", "compiling", "inspecting", "preparing_dataset"]);

/**
 * One explicit lifecycle owns the drop affordance. UI motion and copy derive
 * from these real phases instead of maintaining independent hover/loading
 * booleans that can disagree with the native compiler.
 */
export function workloadDropReducer(phase, action) {
  switch (action.type) {
    case "drag_enter":
      return BUSY_PHASES.has(phase) ? phase : "hovering";
    case "drag_leave":
      return phase === "hovering" ? "idle" : phase;
    case "drop_received":
    case "validation_started":
      return "validating";
    case "compilation_started":
      return phase === "validating" || phase === "compiling" ? "compiling" : phase;
    case "inspection_started":
      return phase === "ready" || phase === "failed" ? "inspecting" : phase;
    case "inspection_succeeded":
      return phase === "inspecting" ? "ready" : phase;
    case "dataset_started":
      return phase === "ready" || phase === "failed" ? "preparing_dataset" : phase;
    case "dataset_succeeded":
      return phase === "preparing_dataset" ? "ready" : phase;
    case "succeeded":
      return BUSY_PHASES.has(phase) ? "ready" : phase;
    case "failed":
      return BUSY_PHASES.has(phase) ? "failed" : phase;
    case "reset":
      return INITIAL_WORKLOAD_DROP_PHASE;
    default:
      return phase;
  }
}

export function isWorkloadDropBusy(phase) {
  return BUSY_PHASES.has(phase);
}

export function workloadDropPersonaState(phase) {
  if (phase === "hovering") return "listening";
  if (BUSY_PHASES.has(phase)) return "thinking";
  return null;
}

export function workloadDropStatus(phase) {
  switch (phase) {
    case "hovering":
      return {
        title: "Drop to begin",
        detail: "One file or folder · stays on this Mac",
      };
    case "validating":
      return {
        title: "Checking this item",
        detail: "Validating one local path…",
      };
    case "compiling":
      return {
        title: "Preparing your workload",
        detail: "Indexing metadata locally · contents remain unread",
      };
    case "inspecting":
      return {
        title: "Inspecting training data",
        detail: "Reading this CSV locally · source rows will not be copied",
      };
    case "preparing_dataset":
      return {
        title: "Preparing local dataset",
        detail: "Writing deterministic train, dev, and holdout examples on this Mac",
      };
    default:
      return null;
  }
}
