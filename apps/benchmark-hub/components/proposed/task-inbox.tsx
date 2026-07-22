"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, SplitChip, DECISION_STYLES } from "@/components/badges";

/**
 * Serializable projection of one proposed task for the inbox list. Tasks are
 * BORN ACCEPTED (review-policy default_decision "accept"): `decision` is the
 * effective decision — an explicit reviews.jsonl line when present, else the
 * policy default — and `flags` are machine ATTENTION signals, never
 * acceptance blockers.
 */
export type InboxRow = {
  taskId: string;
  href: string;
  displayName: string;
  split: string;
  /** Attention flags (AUTO_REVIEW_REASONS vocabulary). */
  flags: string[];
  /** A trivial (null/spam) calibration arm passes this task — suspect. */
  trivialPass: boolean;
  /** Effective decision (null only under policy default_decision "pending"). */
  decision: string | null;
  /** True when a human/auto reviews.jsonl line decided it (vs the default). */
  explicit: boolean;
  /** True when the deciding line was stamped source:"auto". */
  auto: boolean;
};

/** Compact badge labels for the machine attention flags. */
const FLAG_LABELS: Record<string, { label: string; className: string }> = {
  low_confidence: { label: "low confidence", className: "text-warn border-warn/40" },
  self_check_failed: { label: "self-check", className: "text-bad border-bad/40" },
  incumbent_failed: { label: "incumbent failed", className: "text-bad border-bad/40" },
  schema_conflict: { label: "schema conflict", className: "text-warn border-warn/40" },
  anomaly: { label: "anomaly", className: "text-bad border-bad/40" },
};

function needsAttention(row: InboxRow): boolean {
  return !row.explicit && (row.flags.length > 0 || row.trivialPass);
}

/**
 * The page IS the task inbox: one row per task — title, split chip, attention
 * flags as compact badges, effective decision state, and inline quick actions
 * (reject / needs work / open). Attention-flagged rows sort to the top;
 * clean accepted tasks read as a calm list, not a to-do. Row actions append
 * explicit override lines via POST /api/reviews (append-only, newest wins).
 */
export function TaskInbox({ slug, readOnly, rows }: { slug: string; readOnly: boolean; rows: InboxRow[] }) {
  const router = useRouter();
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sorted = [...rows].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)));
  const attentionCount = rows.filter(needsAttention).length;

  const act = async (taskId: string, decision: string) => {
    setBusyTask(taskId);
    setError(null);
    const res = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, task_id: taskId, decision }),
    });
    setBusyTask(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `Review write failed (${res.status})`);
      return;
    }
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-2">
      {attentionCount > 0 && (
        <p className="mono text-xs" style={{ color: "var(--warn-ink)" }}>
          {attentionCount} task{attentionCount === 1 ? "" : "s"} worth a look — flagged rows first. Everything below
          is accepted and runnable as-is.
        </p>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
      <ul className="flex list-none flex-col gap-1.5 p-0">
        {sorted.map((row) => {
          const attention = needsAttention(row);
          return (
            <li
              key={row.taskId}
              className="u-card flex flex-wrap items-center gap-2"
              style={{
                padding: "10px 12px",
                borderColor: attention ? "color-mix(in srgb, var(--warn-ink) 45%, transparent)" : undefined,
              }}
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2" style={{ minWidth: "16rem" }}>
                <Link href={row.href} className="text-sm font-medium" style={{ overflowWrap: "anywhere" }}>
                  {row.displayName}
                </Link>
                <SplitChip split={row.split} />
                {row.flags.map((f) => {
                  const meta = FLAG_LABELS[f] ?? { label: f, className: "text-warn border-warn/40" };
                  return (
                    <Badge key={f} className={meta.className}>
                      {meta.label}
                    </Badge>
                  );
                })}
                {row.trivialPass && <Badge className="text-bad border-bad/40">trivial pass · suspect</Badge>}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {/* Effective decision: quiet when it's the born-accepted default,
                    a colored badge when a human (or auto line) decided. */}
                {row.explicit ? (
                  <Badge className={DECISION_STYLES[row.decision ?? ""] ?? ""}>
                    {(row.decision ?? "").replace("_", " ")}
                    {row.auto ? " · auto" : ""}
                  </Badge>
                ) : row.decision === "accept" ? (
                  <span className="mono text-[11px] text-faint">accepted</span>
                ) : (
                  <span className="mono text-[11px]" style={{ color: "var(--warn-ink)" }}>pending</span>
                )}
                {!readOnly && (
                  <>
                    {row.explicit && row.decision !== "accept" ? (
                      <button
                        className="u-chip"
                        disabled={busyTask === row.taskId}
                        onClick={() => act(row.taskId, "accept")}
                        style={{ color: "var(--live)" }}
                        title="Override the current decision back to accepted"
                      >
                        re-accept
                      </button>
                    ) : (
                      <>
                        <button
                          className="u-chip"
                          disabled={busyTask === row.taskId}
                          onClick={() => act(row.taskId, "reject")}
                          style={{ color: "var(--bad)" }}
                        >
                          reject
                        </button>
                        <button
                          className="u-chip"
                          disabled={busyTask === row.taskId}
                          onClick={() => act(row.taskId, "needs_more")}
                          style={{ color: "var(--warn-ink)" }}
                        >
                          needs work
                        </button>
                      </>
                    )}
                  </>
                )}
                <Link className="u-chip" href={row.href}>
                  open
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
