import Link from "next/link";
import { taskDisplayName, type ProposedHubEntry } from "@/lib/types";
import { complexityLabel } from "@/lib/trajectory-core";
import { Badge, SourceBadge, StageBadge } from "@/components/badges";
import { AnchorRail } from "@/components/anchor-rail";
import { EmptyState } from "@/components/empty-state";
import { TaskTable } from "@/components/task-table";

const RAIL = [
  { id: "narrative", label: "Narrative" },
  { id: "tasks", label: "Tasks" },
];

/**
 * The foundry's promotion blockers for machine-compiled outputs. Mirrored
 * statically here rather than read from the output dir's benchmark.json —
 * that file collides with the promoted understudy.benchmark.v1 schema name
 * (rename tracked upstream) and is never consumed beyond task-id cross-checks.
 */
const PROMOTION_BLOCKERS = ["human_final_judgment", "sentinel_tests"];

export function ProposedBenchmarkPage({ entry }: { entry: ProposedHubEntry }) {
  const name = entry.dir.split("/").pop() ?? entry.slug;
  const total = entry.tasks.length;
  const decisions = entry.tasks.map((t) => entry.latestReviewByTask[t.task_id]?.decision ?? null);
  const reviewed = decisions.filter(Boolean).length;
  const awaiting = total - reviewed;
  const accepted = decisions.filter((d) => d === "accept").length;
  const restricted = decisions.filter((d) => d === "restrict").length;
  const rejected = decisions.filter((d) => d === "reject").length;
  const needsMore = decisions.filter((d) => d === "needs_more").length;
  const f = entry.foundry;

  return (
    <div className="u-page">
      <header className="u-head">
        <p className="u-eyebrow" style={{ marginBottom: 10 }}>
          <Link href="/">← All benchmarks</Link>
        </p>
        <div className="u-title-row">
          <h1>{name}</h1>
        </div>
        {/* Chips on their own line — long titles/ids never fight badges */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StageBadge stage="proposed" />
          <SourceBadge entry={entry} />
          <Badge>machine-compiled · review pending</Badge>
        </div>
        <p className="u-desc">
          Compiled from captured traces by the trace foundry. Every task below is a machine proposal — human final
          judgment gates promotion to an executable benchmark.
        </p>
        <div className="u-id">
          <span>local only · contains customer payloads · no upload performed</span>
        </div>

        <div className="u-stats">
          <div className="u-stat">
            <span className="lab">Tasks</span>
            <span className="val">{total}</span>
            <span className="sub">
              {entry.tasks.filter((t) => t.close_call).length} close call{entry.tasks.filter((t) => t.close_call).length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="u-stat">
            <span className="lab">Awaiting review</span>
            <span className="val" style={awaiting > 0 ? { color: "var(--warn-ink)" } : undefined}>
              {awaiting}
            </span>
            <span className="sub">{reviewed} reviewed</span>
          </div>
          <div className="u-stat">
            <span className="lab">Accepted</span>
            <span className="val" style={{ color: accepted > 0 ? "var(--live)" : undefined }}>
              {accepted}
            </span>
            <span className="sub">{restricted} restricted · {needsMore} needs more</span>
          </div>
          <div className="u-stat">
            <span className="lab">Rejected</span>
            <span className="val" style={{ color: rejected > 0 ? "var(--bad)" : undefined }}>
              {rejected}
            </span>
            <span className="sub">never promoted</span>
          </div>
          <div className="u-stat">
            <span className="lab">Captures</span>
            <span className="val">{f.counts.captures}</span>
            <span className="sub">newest {f.freshness.newest_capture_utc.slice(0, 10)}</span>
          </div>
        </div>
        {entry.crossCheckErrors.length > 0 && (
          <span className="u-foot-note" style={{ color: "var(--warn-ink)" }}>
            {"// tasks.jsonl and benchmark.json disagree on task ids: " + entry.crossCheckErrors.join("; ")}
          </span>
        )}
        {entry.diagnostics.skippedLines + entry.diagnostics.droppedRows > 0 && (
          <span className="u-foot-note">
            {"// loader diagnostics: " +
              entry.diagnostics.skippedLines +
              " malformed jsonl lines skipped · " +
              entry.diagnostics.droppedRows +
              " task lines dropped (wrong schema_version)"}
          </span>
        )}
      </header>

      <div className="u-layout">
        <AnchorRail sections={RAIL} />
        <div>
          <section className="u-sec" id="narrative">
            <h2>How this became a benchmark</h2>
            {entry.overview ? (
              <div className="mt-4 flex flex-col gap-4">
                <div className="u-card">
                  <h3>What we&apos;ve seen in your workload</h3>
                  {entry.overview.workload_summary ? (
                    <WorkloadSummary text={entry.overview.workload_summary} />
                  ) : (
                    <p className="mono mt-2 text-xs text-faint">the overview pass produced no workload summary</p>
                  )}
                  {(entry.overview.system_prompt_clusters ?? []).length > 0 && (
                    <details className="mt-3">
                      <summary className="mono cursor-pointer text-[11px] text-ink-muted">
                        {(entry.overview.system_prompt_clusters ?? []).length === 1
                          ? "one canonical system prompt"
                          : `this workload runs ${(entry.overview.system_prompt_clusters ?? []).length} prompt variants`}
                        {" · deterministic evidence"}
                      </summary>
                      <div className="mt-2 flex flex-col gap-2">
                        {(entry.overview.system_prompt_clusters ?? []).map((c) => (
                          <div key={c.hash}>
                            <span className="mono text-[10px] text-faint">
                              {c.hash} · {c.count} capture{c.count === 1 ? "" : "s"} · {(c.coverage * 100).toFixed(0)}% coverage
                            </span>
                            <pre className="u-pre mt-1" style={{ maxHeight: 140 }}>{c.representative_excerpt}</pre>
                          </div>
                        ))}
                        {(entry.overview.tool_usage ?? []).length > 0 && (
                          <ToolUsageTable rows={entry.overview.tool_usage ?? []} />
                        )}
                      </div>
                    </details>
                  )}
                  <p className="mono mt-2 text-[10px] text-faint">
                    authored by {entry.overview.model ?? "unknown model"}
                    {entry.overview.authored_at ? ` · ${entry.overview.authored_at.slice(0, 10)}` : ""}
                  </p>
                </div>
                <div>
                  <h3 className="mb-2">The tasks we&apos;ve identified</h3>
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {entry.overview.categories.map((c) => {
                      const members = new Set(c.representative_task_ids);
                      const representatives = entry.tasks.filter((t) => members.has(t.task_id));
                      return (
                        <div key={c.category_id} className="u-card">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="text-sm font-bold">{c.archetype_title ?? c.category_id}</span>
                            <Badge>{c.task_count ?? c.representative_task_ids.length} task{(c.task_count ?? 1) === 1 ? "" : "s"}</Badge>
                          </div>
                          {c.archetype_description && <p className="mt-2 text-xs text-ink-muted">{c.archetype_description}</p>}
                          {representatives.length > 0 && (
                            <ul className="mt-3 flex list-none flex-col gap-1 p-0">
                              {representatives.map((t) => {
                                const cx = entry.overview?.task_complexity?.[t.task_id];
                                return (
                                  <li key={t.task_id} className="text-xs">
                                    <Link href={`/b/${entry.slug}/task/${encodeURIComponent(t.task_id)}`}>{taskDisplayName(t)}</Link>
                                    {cx?.frontier && (
                                      <span className="mono ml-1 text-[10px]" style={{ color: "var(--warn-ink)" }}>
                                        upper bound: {complexityLabel(cx)}
                                      </span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState
                what="No benchmark narrative yet — the overview pass writes a workload summary and per-category task archetypes grounded on the authored task blocks."
                next={`understudy traces author-tasks --benchmark ${entry.dir} --overview`}
              />
            )}
          </section>

          <section className="u-sec" id="tasks">
            <h2>Task inbox</h2>
            <p className="exp">
              Machine-proposed tasks awaiting final judgment. Click a task to inspect its outcome contract, world
              model, source captures — and record a decision.
            </p>
            {total === 0 ? (
              <EmptyState
                what="The foundry emitted no tasks for this output — the source captures produced no execution groups."
                next="understudy traces build-benchmark --source <captures> --output <dir> --max-age-days <n>"
              />
            ) : (
              <>
                {reviewed === 0 && (
                  <EmptyState
                    what="No task has been reviewed yet — this benchmark is pure machine proposal until a human records a first decision."
                    next={`open a task below → accept | restrict | needs_more | reject  (${total} pending)`}
                  />
                )}
                {awaiting === 0 && total > 0 && (
                  <EmptyState
                    done
                    what={
                      <>
                        <b>All {total} tasks reviewed.</b> Next: promotion — this output stays non-executable until
                        the foundry&apos;s promotion blockers clear: {PROMOTION_BLOCKERS.join(", ")}.
                      </>
                    }
                    next="promotion tooling lands upstream; accepted tasks become the promoted benchmark's manifest"
                  />
                )}
                <TaskTable
                  stage="proposed"
                  rows={entry.tasks.map((t) => {
                    const cx = entry.overview?.task_complexity?.[t.task_id] ?? null;
                    return {
                      taskId: t.task_id,
                      href: `/b/${entry.slug}/task/${encodeURIComponent(t.task_id)}`,
                      displayName: taskDisplayName(t),
                      rawTitle: t.title,
                      split: t.split,
                      confidence: t.machine_confidence,
                      reviewDecision: entry.latestReviewByTask[t.task_id]?.decision ?? null,
                      closeCall: t.close_call,
                      authored: !!t.authored,
                      promptLength: (t.authored?.statement ?? t.title ?? "").length,
                      contextTokens: cx?.approx_context_tokens ?? null,
                      frontier: cx?.frontier ?? false,
                      // Authored "easy" on a frontier-complex task is a mismatch a human should see.
                      complexityMismatch: cx?.frontier === true && t.authored?.difficulty === "easy",
                    };
                  })}
                />
              </>
            )}
          </section>

        </div>
      </div>
    </div>
  );
}

/**
 * Authored summaries arrive as one paragraph; render the first two sentences
 * as the lead and fold the rest behind a disclosure so the narrative never
 * reads as a wall of text.
 */
function WorkloadSummary({ text }: { text: string }) {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [text];
  const lead = sentences.slice(0, 2).join("").trim();
  const rest = sentences.slice(2).join("").trim();
  return (
    <div className="mt-2" style={{ maxWidth: "70ch" }}>
      <p className="text-sm">{lead}</p>
      {rest.length > 0 && (
        <details className="mt-1">
          <summary className="mono cursor-pointer text-[11px] text-ink-muted">read the full summary</summary>
          <p className="mt-1 text-sm text-ink-muted">{rest}</p>
        </details>
      )}
    </div>
  );
}

/** Compact top-N tool table instead of a run-on joined line. */
function ToolUsageTable({ rows }: { rows: { tool: string; calls: number; defined: boolean }[] }) {
  const sorted = [...rows].sort((a, b) => b.calls - a.calls);
  const top = sorted.slice(0, 10);
  const more = sorted.slice(10);
  const row = (r: { tool: string; calls: number; defined: boolean }) => (
    <div key={r.tool} className="flex items-baseline justify-between gap-3">
      <span className="mono text-[11px]">{r.tool}{r.defined ? "" : " *"}</span>
      <span className="mono text-[11px] text-faint">{r.calls === 0 ? "never called" : `×${r.calls}`}</span>
    </div>
  );
  return (
    <div className="mt-2" style={{ maxWidth: "44ch" }}>
      <div className="mono mb-1 text-[10px] uppercase tracking-wide text-faint">tool usage</div>
      <div className="flex flex-col gap-0.5">{top.map(row)}</div>
      {more.length > 0 && (
        <details className="mt-1">
          <summary className="mono cursor-pointer text-[11px] text-ink-muted">{more.length} more tools</summary>
          <div className="mt-1 flex flex-col gap-0.5">{more.map(row)}</div>
        </details>
      )}
      {rows.some((r) => !r.defined) && <div className="mono mt-1 text-[10px] text-faint">* called but not declared</div>}
    </div>
  );
}
