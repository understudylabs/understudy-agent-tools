"use client";

import { useEffect, useRef, type ReactNode } from "react";
import {
  TRAINING_FLOW_KIND_LABELS,
  activeCard,
  type TrainingFlow,
  type TrainingFlowCard,
  type TrainingFlowDecision,
} from "../lib/training-flow.mjs";

/**
 * Human label for an answer, including label-choice value objects
 * ({choice:"confirm"|"correct"|"ambiguous", label?, of_labels?}).
 */
function answerLabel(decision: TrainingFlowDecision | null): string {
  if (!decision) return "Answered";
  const { answer } = decision;
  if (typeof answer === "string") {
    return answer === "yes" ? "Confirmed" : answer === "no" ? "Declined" : answer;
  }
  if (answer && typeof answer === "object" && "choice" in answer) {
    if (answer.choice === "confirm") return "Confirmed";
    if (answer.choice === "correct") return answer.label ? `Corrected · ${answer.label}` : "Corrected";
    if (answer.choice === "ambiguous") return "Marked ambiguous";
  }
  return "Recorded";
}

/**
 * Lab-notebook timeline: answered decisions stay visible as a scrollable
 * single column ABOVE the active card (the bottom of the thread), which is
 * auto-scrolled into view whenever focus moves. Each answered entry keeps a
 * condensed, non-interactive card body plus its decision line; clicking the
 * entry is the go-back affordance — same invalidation semantics as the
 * stepper. Committed states resolve toward mint (promotion ring), matching
 * the design system's mint-green-ring-and-gate semantic.
 */
export function TrainingFlowTimeline({
  flow,
  summaries,
  onNavigate,
  renderCommitted,
  children,
}: {
  flow: TrainingFlow;
  summaries?: Partial<Record<string, string>>;
  onNavigate: (cardId: string) => void;
  /** Condensed committed body for an answered card; null for summary-only. */
  renderCommitted?: (card: TrainingFlowCard) => ReactNode;
  /** The active card body — rendered at the bottom of the thread. */
  children: ReactNode;
}) {
  const activeRef = useRef<HTMLDivElement | null>(null);
  const activeId = activeCard(flow)?.id ?? null;
  const activeIndex = flow.cards.findIndex((card) => card.status === "active");
  // The thread is chronological: answered chapters before the active card;
  // answered cards after a revisited step stay in the stepper only, so the
  // active card is always the bottom of the timeline.
  const committed = flow.cards.filter(
    (card, index) => card.status === "answered" && (activeIndex < 0 || index < activeIndex),
  );
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [activeId, committed.length]);
  return (
    <div className="training-flow-timeline" role="log" aria-label="Decisions so far">
      {committed.map((card) => {
        // Chapter number = position in the flow, matching the stepper rail.
        const index = flow.cards.findIndex((existing) => existing.id === card.id);
        const label = TRAINING_FLOW_KIND_LABELS[card.kind] ?? card.kind;
        const body = renderCommitted?.(card) ?? null;
        return (
          <article
            key={card.id}
            className="training-flow-timeline-entry"
            data-state="complete"
          >
            {body != null && (
              // Committed body: visible for context, never interactive. The
              // only affordance on an answered card is the go-back button.
              <div className="training-flow-timeline-body" inert aria-hidden="true">
                {body}
              </div>
            )}
            <button
              type="button"
              className="training-flow-timeline-decision"
              title="Go back to this decision"
              onClick={() => onNavigate(card.id)}
            >
              <span className="training-flow-timeline-kicker">
                {String(index + 1).padStart(2, "0")} · {label}
              </span>
              <strong>{card.decision?.question ?? label}</strong>
              <small>{summaries?.[card.id] ?? answerLabel(card.decision)}</small>
            </button>
          </article>
        );
      })}
      <div ref={activeRef} className="training-flow-timeline-active">
        {children}
      </div>
    </div>
  );
}

/**
 * Compact progress rail pinned below the active focus card. Reuses the
 * numbered-dot visual language of the existing 01/02/03/04 analysis stages
 * as chapter markers. Answered steps show their one-line decision and
 * navigate back on click.
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
          ? summaries?.[card.id] ?? answerLabel(card.decision)
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
