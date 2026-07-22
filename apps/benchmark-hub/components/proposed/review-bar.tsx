"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ReviewDecision } from "@/lib/types";

const DECISION_COLOR: Record<ReviewDecision, string> = {
  accept: "var(--live)",
  restrict: "var(--warn-ink)",
  needs_more: "var(--warn-ink)",
  reject: "var(--bad)",
};

/** Editing verbs, not judgment: accept is the resting state, never a button here. */
const OVERRIDE_VERBS: { decision: ReviewDecision; label: string }[] = [
  { decision: "reject", label: "Reject" },
  { decision: "needs_more", label: "Needs work" },
  { decision: "restrict", label: "Restrict" },
];

/**
 * Override bar for one proposed task. Tasks are BORN ACCEPTED (review-policy
 * default_decision "accept"): there is no accept button — the verbs are
 * Reject / Needs work / Restrict, each appending an explicit reviews.jsonl
 * override (append-only, newest wins). "Re-accept" appears only on a task a
 * previous line overrode, to bring it back to the resting state.
 */
export function ReviewBar({
  slug,
  taskId,
  current,
  readOnly,
}: {
  slug: string;
  taskId: string;
  /** Latest EXPLICIT persisted decision, if any (null = accepted by default). */
  current: ReviewDecision | null;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<ReviewDecision | null>(current);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (readOnly) {
    return (
      <span className="u-foot-note !mt-0">
        {"// read-only entry (repo fixture) — review decisions cannot be written here"}
      </span>
    );
  }

  const judge = async (d: ReviewDecision) => {
    const previous = decision;
    setDecision(d); // optimistic
    setBusy(true);
    setError(null);
    const res = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, task_id: taskId, decision: d, note }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setDecision(previous); // roll back
      setError(body.error ?? `Review write failed (${res.status})`);
      return;
    }
    setNote("");
    router.refresh();
  };

  const overridden = decision !== null && decision !== "accept";

  return (
    <div className="u-card flex flex-col gap-2.5" style={{ padding: "14px 16px" }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="u-cats-label">Override</span>
        {OVERRIDE_VERBS.map(({ decision: d, label }) => (
          <button
            key={d}
            className="u-chip"
            aria-pressed={decision === d}
            disabled={busy}
            onClick={() => judge(d)}
            style={decision === d ? undefined : { color: DECISION_COLOR[d] }}
          >
            {label}
          </button>
        ))}
        {/* Re-accept only exists on an overridden task — accepted is the resting state. */}
        {overridden && (
          <button className="u-chip" disabled={busy} onClick={() => judge("accept")} style={{ color: DECISION_COLOR.accept }}>
            Re-accept
          </button>
        )}
        <span className="mono text-xs text-ink-muted">
          {decision === null ? (
            <>current: <b style={{ color: DECISION_COLOR.accept }}>accepted (default)</b></>
          ) : (
            <>current: <b style={{ color: DECISION_COLOR[decision] }}>{decision.replace("_", " ")}</b></>
          )}
        </span>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why? (recorded with the next decision)"
        rows={2}
        className="rounded-lg border border-rule-strong bg-card px-2.5 py-1.5 text-xs text-ink focus:border-stamp focus:outline-2 focus:outline-stamp"
      />
      {error && <span className="text-xs text-bad">{error}</span>}
    </div>
  );
}
