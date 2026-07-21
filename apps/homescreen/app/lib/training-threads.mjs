// Training threads: title/status mapping helpers shared by the sidebar and
// ChatPane persistence. A thread's title is "source_name → target" once a
// prediction target has been confirmed; its status glyph follows the design
// language — active = cyan live dot, completed = mint promotion ring,
// dismissed = muted.

export const TRAINING_THREAD_STATUSES = Object.freeze([
  "active",
  "completed",
  "dismissed",
]);

/**
 * Pull the confirmed prediction target out of a serialized flow, preferring
 * the structured decision details over the free-form answer string.
 * Returns null when no target has been decided yet.
 */
export function trainingThreadTarget(flow) {
  const card = flow?.cards?.find(
    (existing) => existing.kind === "prediction_target" && existing.decision,
  );
  if (!card) return null;
  const details = card.decision.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const column = details.target_column;
    if (typeof column === "string" && column.trim()) return column.trim();
  }
  const answer = card.decision.answer;
  if (typeof answer === "string" && answer.trim() && answer !== "yes" && answer !== "no") {
    return answer.trim();
  }
  return null;
}

/** "tickets.csv → priority" once a target exists; the source name before. */
export function trainingThreadTitle(sourceName, flow) {
  const source = (sourceName ?? "").trim() || "Dropped workload";
  const target = trainingThreadTarget(flow);
  if (!target) return source;
  const compact = target.length > 80 ? `${target.slice(0, 77)}…` : target;
  return `${source} → ${compact}`;
}

/**
 * Nav treatment for a thread status. Glyph semantics per the design system:
 * cyan = live activity, mint ring = promotion/completion, muted = dismissed.
 */
export function trainingThreadStatusGlyph(status) {
  switch (status) {
    case "active":
      return { className: "thread-status-glyph active", label: "In progress" };
    case "completed":
      return { className: "thread-status-glyph completed", label: "Completed" };
    default:
      return { className: "thread-status-glyph dismissed", label: "Dismissed" };
  }
}
