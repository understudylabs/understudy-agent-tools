// Combined-experiment renderer state logic (framework-free, provider-free).
//
// Surgical node-background convention (and nothing else — no edge/label/layout/
// camera/force changes, node identity/position preserved by the caller):
//   * queued / not-started        -> idle   (keep the existing neutral background)
//   * any ACTIVE status            -> active (WHITE pulsing/flashing background)
//     active = screening | reflecting | evaluating | confirming, plus the
//     upstream "started" convention mapped to "running".
//   * terminal + scored            -> success (existing GREEN) or failure (RED)
//     success = completed | promoted ; failure = rejected | failed
// No cyan is ever emitted.

export const ACTIVE_STATUSES = Object.freeze([
  "screening", "reflecting", "evaluating", "confirming", "running", "started",
]);
export const SUCCESS_STATUSES = Object.freeze(["completed", "promoted"]);
export const FAILURE_STATUSES = Object.freeze(["rejected", "failed"]);
export const IDLE_STATUSES = Object.freeze(["queued"]);

// Background colors: reuse the existing gepa-viz green/red; white for active.
export const BG = Object.freeze({
  idle: "#52525b",     // zinc-600, the existing not-started background
  active: "#ffffff",   // white (pulsing via .exp-node--active)
  success: "#16a34a",  // existing green-600 success
  failure: "#dc2626",  // existing red-600 failure
});

// Normalize an upstream status to the renderer's vocabulary.
export function normalizeStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "started" ? "running" : s;
}

// Map a node to one of: "idle" | "active" | "success" | "failure".
export function visualStateOf(node) {
  const status = normalizeStatus(node && (node.status || node.stage));
  if (ACTIVE_STATUSES.includes(status)) return "active";
  if (SUCCESS_STATUSES.includes(status)) return "success";
  if (FAILURE_STATUSES.includes(status)) return "failure";
  return "idle"; // queued / unknown / not-started
}

// CSS class for a node's background given its visual state.
export function backgroundClassOf(visualState) {
  return `exp-node exp-node--${visualState}`;
}

// Convenience: background color literal for a node.
export function backgroundColorOf(node) {
  return BG[visualStateOf(node)];
}
