import type { FoundryTask } from "@/lib/types";
import type { BenchmarkReview } from "@/lib/types";
import { Badge } from "@/components/badges";
import { ReviewBar } from "@/components/proposed/review-bar";

/**
 * "How this became a task" — the bridge between trajectory and task. When an
 * authored block (understudy.task_authoring.v1) exists it renders the
 * confirm-card: statement headline, success criteria as a confirmable
 * checklist, the authored-vs-observed contract diff joined by
 * maps_to_observed, grounding badge + violations, ambiguities as explicit
 * human decisions, category/difficulty suggestions — plus the review actions.
 * Unauthored tasks show the deterministic contract and the author-tasks CLI
 * hint. The raw distinctive-line title is demoted behind a disclosure.
 */
export function AuthoredPanel({
  slug,
  task,
  review,
  readOnly,
}: {
  slug: string;
  task: FoundryTask;
  review: BenchmarkReview | null;
  readOnly: boolean;
}) {
  const authored = task.authored ?? null;

  return (
    <section className="u-section" id="authored">
      <div className="u-sec-head">
        <span className="u-sec-no">02</span>
        <h2>How this became a task</h2>
      </div>

      {authored ? (
        <div className="mt-4 flex flex-col gap-4">

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="u-card">
              <h3>Success criteria — confirm each</h3>
              <ul className="mt-2 flex list-none flex-col gap-2 p-0">
                {(authored.success_criteria ?? []).map((c, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="mono shrink-0" style={{ color: "var(--ok)" }}>☐</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
              {(authored.ambiguities ?? []).length > 0 && (
                <>
                  <h3 className="mt-4">Human decisions needed</h3>
                  <ul className="mt-2 flex list-none flex-col gap-2 p-0">
                    {(authored.ambiguities ?? []).map((a, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <span className="mono shrink-0" style={{ color: "var(--warn)" }}>?</span>
                        <span>{a}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h3 className="mt-4">Suggestions</h3>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {authored.category_proposal?.id && (
                  <Badge className="text-ink-bright">category: {authored.category_proposal.name ?? authored.category_proposal.id}</Badge>
                )}
                {authored.difficulty && <Badge>difficulty: {authored.difficulty}</Badge>}
              </div>
              {authored.difficulty_reason && <p className="mt-1 text-xs text-ink-muted">{authored.difficulty_reason}</p>}
            </div>

          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <div className="u-empty !mt-0">
            <p className="what">
              This task has only its deterministic machine proposal — observed mutating tool calls with raw arguments.
              An authoring pass writes a legible statement, success criteria, and a grounded semantic contract for human
              confirmation.
            </p>
            <span className="next">understudy traces author-tasks --benchmark &lt;output-dir&gt;  # author this task</span>
          </div>
        </div>
      )}

      <details className="mt-4">
        <summary className="mono cursor-pointer text-xs text-ink-muted">raw machine title</summary>
        <p className="mono mt-2 text-xs text-ink-muted" style={{ overflowWrap: "anywhere" }}>{task.title || "(none)"}</p>
      </details>

      <div className="mt-4">
        <ReviewBar slug={slug} taskId={task.task_id} current={review?.decision ?? null} readOnly={readOnly} />
        {review?.note && (
          <p className="mono mt-2 text-xs text-ink-muted">
            latest note ({review.created_at.slice(0, 10)}): {review.note}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The authored statement + trust chips, rendered at the TOP of the task page
 * (it IS the task description). Grounding violations surface here so a failed
 * grounding is never below the fold.
 */
export function AuthoredStatementCard({ task }: { task: FoundryTask }) {
  const authored = task.authored ?? null;
  if (!authored?.statement) return null;
  const groundingRaw = authored.grounding as unknown;
  const groundingStatus =
    typeof groundingRaw === "string" ? groundingRaw : ((groundingRaw as { status?: string } | null)?.status ?? "unknown");
  const groundingViolations: string[] =
    typeof groundingRaw === "object" && groundingRaw !== null && Array.isArray((groundingRaw as { violations?: string[] }).violations)
      ? (groundingRaw as { violations: string[] }).violations
      : ((authored.grounding_violations as string[] | undefined) ?? []);
  return (
    <div className="mt-3">
      {/* Trust chips are cut from the header (design feedback); a FAILED
          grounding still surfaces loudly — that one is never decorative. */}
      {groundingStatus !== "verified" && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="text-bad border-bad/40">grounding {groundingStatus}</Badge>
        </div>
      )}
      <p className="mt-3 text-base" style={{ lineHeight: 1.5 }}>{authored.statement}</p>
      {groundingViolations.length > 0 && (
        <ul className="mt-2 flex list-none flex-col gap-1 p-0">
          {groundingViolations.map((v, i) => (
            <li key={i} className="mono text-xs" style={{ color: "var(--bad)" }}>
              ⚠ {v}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
