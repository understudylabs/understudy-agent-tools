import type { AuthoredContractEntry, FoundryContractItem, FoundryTask } from "@/lib/types";
import type { BenchmarkReview } from "@/lib/types";
import { Badge, ConfidenceChip } from "@/components/badges";
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
  // The authoring CLI writes grounding as a flat string ("verified"|"failed");
  // an earlier draft nested it as {status, violations}. Accept both shapes.
  const groundingRaw = authored?.grounding as unknown;
  const groundingStatus =
    typeof groundingRaw === "string" ? groundingRaw : ((groundingRaw as { status?: string } | null)?.status ?? "unknown");
  const groundingViolations: string[] =
    typeof groundingRaw === "object" && groundingRaw !== null && Array.isArray((groundingRaw as { violations?: string[] }).violations)
      ? ((groundingRaw as { violations: string[] }).violations)
      : ((authored?.grounding_violations as string[] | undefined) ?? []);
  const detRequired = (task.outcome_contract?.required ?? []) as FoundryContractItem[];

  return (
    <section className="u-section" id="authored">
      <div className="u-sec-head">
        <span className="u-sec-no">02</span>
        <h2>How this became a task</h2>
      </div>

      {authored ? (
        <div className="mt-4 flex flex-col gap-4">
          <div className="u-card">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={groundingStatus === "verified" ? "text-ok border-ok/50" : "text-bad border-bad/40"}>
                grounding {groundingStatus}
              </Badge>
              <ConfidenceChip level={authored.confidence} />
              {authored.model && <Badge>authored by {authored.model}</Badge>}
              {authored.authored_at && <span className="mono text-[10px] text-faint">{authored.authored_at.slice(0, 10)}</span>}
            </div>
            <p className="mt-3 text-base font-semibold" style={{ lineHeight: 1.4 }}>{authored.statement}</p>
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

            <div className="u-card">
              <h3>Contract diff — authored (semantic) vs observed (deterministic)</h3>
              <ul className="mt-2 flex list-none flex-col gap-2.5 p-0">
                {(authored.contract?.required ?? []).map((entry: AuthoredContractEntry, i) => {
                  const observed = detRequired.find((d) => d.tool === entry.tool);
                  return (
                    <li key={i} className="u-msg">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className="text-ink-bright">{entry.tool}</Badge>
                        {(entry.maps_to_observed ?? []).map((id) => (
                          <span key={id} className="mono text-[10px] text-faint">↦ {id}</span>
                        ))}
                      </div>
                      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                        <div>
                          <span className="mono text-[10px] text-ink-muted">authored · arguments_semantic</span>
                          <pre className="u-pre mt-1" style={{ maxHeight: 140 }}>{JSON.stringify(entry.arguments_semantic ?? {}, null, 2)}</pre>
                        </div>
                        <div>
                          <span className="mono text-[10px] text-ink-muted">observed · deterministic</span>
                          <pre className="u-pre mt-1" style={{ maxHeight: 140 }}>
                            {observed ? JSON.stringify(observed.observed_arguments ?? {}, null, 2) : "// no deterministic entry for this tool"}
                          </pre>
                        </div>
                      </div>
                    </li>
                  );
                })}
                {detRequired
                  .filter((d) => !(authored.contract?.required ?? []).some((e) => e.tool === d.tool))
                  .map((d, i) => (
                    <li key={"unmapped-" + i} className="u-msg">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className="border-warn/40 text-warn">{d.tool} — observed but not authored</Badge>
                      </div>
                      <pre className="u-pre mt-2" style={{ maxHeight: 140 }}>{JSON.stringify(d.observed_arguments ?? {}, null, 2)}</pre>
                    </li>
                  ))}
              </ul>
              {((authored.contract?.preserved ?? []).length > 0 || (authored.contract?.forbidden ?? []).length > 0) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {(authored.contract?.preserved ?? []).map((e, i) => (
                    <Badge key={"p" + i}>preserve {e.tool}</Badge>
                  ))}
                  {(authored.contract?.forbidden ?? []).map((e, i) => (
                    <Badge key={"f" + i} className="border-bad/40 text-bad">forbid {e.tool}</Badge>
                  ))}
                </div>
              )}
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
