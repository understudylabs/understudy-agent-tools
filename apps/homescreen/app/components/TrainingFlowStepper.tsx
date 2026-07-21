"use client";

import {
  TRAINING_FLOW_KIND_LABELS,
  type TrainingFlow,
  type TrainingFlowCard,
} from "../lib/training-flow.mjs";

/**
 * Compact progress rail pinned below the active focus card. Reuses the
 * numbered-dot visual language of the existing 01/02/03/04 analysis stages.
 * Answered steps show their one-line decision and navigate back on click.
 */
export function TrainingFlowStepper({
  flow,
  summaries,
  onNavigate,
}: {
  flow: TrainingFlow;
  /** One-line decision summaries per card id, e.g. "Data confirmed · 11,443 rows". */
  summaries?: Partial<Record<string, string>>;
  onNavigate: (cardId: string) => void;
}) {
  return (
    <ol
      className="automatic-goal-card-stages training-flow-stepper"
      aria-label="Training decisions"
    >
      {flow.cards.map((card: TrainingFlowCard, index: number) => {
        const state = card.status === "answered"
          ? "complete"
          : card.status === "active"
            ? "active"
            : "pending";
        const label = TRAINING_FLOW_KIND_LABELS[card.kind] ?? card.kind;
        const summary = card.status === "answered"
          ? summaries?.[card.id]
            ?? (card.decision
              ? card.decision.answer === "yes"
                ? "Confirmed"
                : card.decision.answer === "no"
                  ? "Declined"
                  : String(card.decision.answer)
              : "Answered")
          : card.status === "loading"
            ? "Preparing…"
            : card.status === "ready"
              ? "Ready"
              : card.status === "active"
                ? "Your decision"
                : "Up next";
        const body = (
          <>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{label}</strong>
              <small>{summary}</small>
            </div>
          </>
        );
        return (
          <li
            key={card.id}
            data-state={state}
            aria-current={state === "active" ? "step" : undefined}
          >
            {card.status === "answered" ? (
              <button
                type="button"
                className="training-flow-step-jump"
                title={card.decision?.question}
                onClick={() => onNavigate(card.id)}
              >
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ol>
  );
}
