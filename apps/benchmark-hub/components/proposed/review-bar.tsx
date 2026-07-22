"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { REVIEW_DECISIONS, type ReviewDecision } from "@/lib/types";

const DECISION_COLOR: Record<ReviewDecision, string> = {
  accept: "var(--live)",
  restrict: "var(--warn-ink)",
  needs_more: "var(--warn-ink)",
  reject: "var(--bad)",
};

/**
 * Review action bar for one proposed task: accept / restrict / needs_more /
 * reject + optional note → POST /api/reviews. Optimistic: the chosen decision
 * renders immediately; a failed write rolls back and shows the error.
 */
export function ReviewBar({
  slug,
  taskId,
  current,
  readOnly,
}: {
  slug: string;
  taskId: string;
  /** Latest persisted decision, if any. */
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
      <span className="lb-foot-note !mt-0">
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

  return (
    <div className="lb-card flex flex-col gap-2.5" style={{ padding: "14px 16px" }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="lb-cats-label">Final judgment</span>
        {REVIEW_DECISIONS.map((d) => (
          <button
            key={d}
            className="lb-chip"
            aria-pressed={decision === d}
            disabled={busy}
            onClick={() => judge(d)}
            style={decision === d ? undefined : { color: DECISION_COLOR[d] }}
          >
            {d.replace("_", " ")}
          </button>
        ))}
        {decision && (
          <span className="mono text-xs text-ink-muted">
            current: <b style={{ color: DECISION_COLOR[decision] }}>{decision.replace("_", " ")}</b>
          </span>
        )}
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
