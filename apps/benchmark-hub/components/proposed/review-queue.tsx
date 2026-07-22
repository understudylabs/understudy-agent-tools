"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/badges";

/** Serializable projection of one policy proposal for client rendering. */
export type QueueTask = {
  taskId: string;
  displayName: string;
  href: string;
  reasons: string[];
};

/** Why a task landed in the exception queue — human labels for the machine reasons. */
const REASON_LABELS: Record<string, { label: string; detail: string }> = {
  low_confidence: {
    label: "low confidence",
    detail: "machine confidence below the auto-accept bar, or the boundary was a close call",
  },
  self_check_failed: {
    label: "self-check failed",
    detail: "the foundry's generation-time structural self-check flagged this task",
  },
  incumbent_failed: {
    label: "incumbent failed",
    detail: "the production model failed its own task in the incumbent calibration rerun",
  },
  schema_conflict: {
    label: "schema conflict",
    detail: "tasks.jsonl and benchmark.json disagree about this task id",
  },
  anomaly: {
    label: "anomaly",
    detail: "an executor anomaly sentinel fired on an eval row for this task",
  },
};

const REASON_STYLE: Record<string, string> = {
  low_confidence: "text-warn border-warn/40",
  self_check_failed: "text-bad border-bad/40",
  incumbent_failed: "text-bad border-bad/40",
  schema_conflict: "text-warn border-warn/40",
  anomaly: "text-bad border-bad/40",
};

/**
 * Exception-first review queue for one proposed benchmark. Leads with the
 * tasks that NEED human judgment, grouped by machine-readable reason; the
 * auto-acceptable remainder collapses into one summary card with a single
 * explicit "Apply N auto-accepts" action (the ONLY thing that writes
 * source:"auto" accept lines — never the page load) and an expandable list.
 * Everything stays reversible: the per-task review bar overrides any auto
 * decision (append-only reviews.jsonl, newest per task wins).
 */
export function ReviewQueue({
  slug,
  readOnly,
  exceptionsByReason,
  autoAccepts,
}: {
  slug: string;
  readOnly: boolean;
  /** reason → tasks carrying it (a task may appear under several reasons). */
  exceptionsByReason: { reason: string; tasks: QueueTask[] }[];
  autoAccepts: QueueTask[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  const exceptionCount = new Set(exceptionsByReason.flatMap((g) => g.tasks.map((t) => t.taskId))).size;

  const apply = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/reviews/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Auto-accept write failed (${res.status})`);
      return;
    }
    const body = await res.json();
    setAppliedCount(Array.isArray(body.applied) ? body.applied.length : 0);
    router.refresh();
  };

  if (exceptionCount === 0 && autoAccepts.length === 0) return null;

  return (
    <section className="u-sec" id="review-queue">
      <h2>Review queue</h2>
      <p className="exp">
        Only exceptions need your judgment — everything the machine is confident about collapses into one action
        below. Any auto decision can be overridden per task later (newest review wins).
      </p>

      {/* EXCEPTIONS FIRST: the human work, grouped by reason. */}
      {exceptionCount > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-bold">Needs your judgment</span>
            <Badge className="text-warn border-warn/40">
              {exceptionCount} task{exceptionCount === 1 ? "" : "s"}
            </Badge>
          </div>
          {exceptionsByReason.map(({ reason, tasks }) => {
            const meta = REASON_LABELS[reason] ?? { label: reason, detail: "" };
            return (
              <div key={reason} className="u-card" style={{ padding: "12px 14px" }}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge className={REASON_STYLE[reason] ?? "text-warn border-warn/40"}>{meta.label}</Badge>
                  <Badge>
                    {tasks.length} task{tasks.length === 1 ? "" : "s"}
                  </Badge>
                  <span className="mono text-[11px] text-faint">{reason}</span>
                </div>
                {meta.detail && <p className="mt-2 text-xs text-ink-muted">{meta.detail}</p>}
                <ul className="mt-2 flex list-none flex-col gap-1 p-0">
                  {tasks.map((t) => (
                    <li key={t.taskId} className="text-xs">
                      <Link href={t.href}>{t.displayName}</Link>
                      {t.reasons.length > 1 && (
                        <span className="mono ml-1 text-[10px] text-faint">
                          also: {t.reasons.filter((r) => r !== reason).map((r) => (REASON_LABELS[r]?.label ?? r)).join(", ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {/* AUTO-ACCEPTS: one summary card, one explicit click, expandable list. */}
      {autoAccepts.length > 0 && (
        <div className="u-card mt-3" style={{ padding: "12px 14px" }}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold">Clean by every machine signal</span>
            <Badge className="text-ok border-ok/50">
              {autoAccepts.length} task{autoAccepts.length === 1 ? "" : "s"}
            </Badge>
            {readOnly ? (
              <span className="u-foot-note !mt-0">{"// read-only entry — auto-accepts cannot be written here"}</span>
            ) : (
              <button className="u-chip" disabled={busy} onClick={apply} style={{ color: "var(--live)" }}>
                {busy ? "applying…" : `Apply ${autoAccepts.length} auto-accept${autoAccepts.length === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            High machine confidence, self-check clean, no incumbent failure, no schema conflict, no anomaly. Nothing is
            written until you click — each accept lands in reviews.jsonl stamped <span className="mono">source: &quot;auto&quot;</span>{" "}
            and stays reversible from the task page.
          </p>
          {appliedCount != null && (
            <p className="mono mt-2 text-xs" style={{ color: "var(--live)" }}>
              applied {appliedCount} auto-accept{appliedCount === 1 ? "" : "s"}
            </p>
          )}
          {error && <p className="mt-2 text-xs text-bad">{error}</p>}
          <details className="mt-2">
            <summary className="mono cursor-pointer text-[11px] text-ink-muted">
              show the {autoAccepts.length} task{autoAccepts.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-2 flex list-none flex-col gap-1 p-0">
              {autoAccepts.map((t) => (
                <li key={t.taskId} className="text-xs">
                  <Link href={t.href}>{t.displayName}</Link>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
