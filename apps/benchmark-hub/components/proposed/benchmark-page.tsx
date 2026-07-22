import Link from "next/link";
import { taskDisplayName, type ProposedHubEntry } from "@/lib/types";
import { deriveTaskAttention, effectiveDecision } from "@/lib/data";
import { trivialPassesForTask } from "@/lib/scores";
import { complexityLabel } from "@/lib/trajectory-core";
import { Badge, SourceBadge, StageBadge } from "@/components/badges";
import { EmptyState } from "@/components/empty-state";
import { CalibrationFloors } from "@/components/calibration-floors";
import { TaskInbox, type InboxRow } from "@/components/proposed/task-inbox";

/**
 * The proposed /b/<slug> page IS the task inbox (design feedback: "how would
 * we get this to be JUST the task inbox — too much redundancy").
 *
 * Generated tasks are born accepted: no pending state to clear, no
 * apply-auto-accepts click. One row per task carries the title, split,
 * attention flags, effective decision, and inline reject / needs-work
 * actions; flagged tasks sort to the top. Everything that used to stack here
 * (authored narrative lead, exception-queue section, summary stat cards,
 * category grid) collapses into the compact header strip or the "workload
 * details" disclosure below the inbox — the task pages carry the depth.
 */
export function ProposedBenchmarkPage({ entry }: { entry: ProposedHubEntry }) {
  const name = entry.dir.split("/").pop() ?? entry.slug;
  const total = entry.tasks.length;
  const f = entry.foundry;

  const flagsByTask = new Map(deriveTaskAttention(entry).map((a) => [a.task_id, a.flags]));
  const rows: InboxRow[] = entry.tasks.map((t) => {
    const eff = effectiveDecision(entry, t.task_id);
    const line = entry.latestReviewByTask[t.task_id];
    return {
      taskId: t.task_id,
      href: `/b/${entry.slug}/task/${encodeURIComponent(t.task_id)}`,
      displayName: taskDisplayName(t),
      split: t.split,
      flags: flagsByTask.get(t.task_id) ?? [],
      trivialPass: trivialPassesForTask(entry.calibration, t.task_id).some((v) => v.exceeded),
      decision: eff.decision,
      explicit: eff.explicit,
      auto: line?.source === "auto",
    };
  });
  const attention = rows.filter((r) => !r.explicit && (r.flags.length > 0 || r.trivialPass)).length;
  const overridden = rows.filter((r) => r.explicit && r.decision !== "accept").length;
  const pendingMode = (entry.reviewPolicy?.default_decision ?? "accept") === "pending";

  // Compact calibration status for the header line.
  const cal = entry.calibration;
  const calNote = cal
    ? `incumbent calibration: ${cal.passed_count}/${cal.passed_count + cal.failed_count} passed`
    : "no incumbent calibration yet";

  return (
    <div className="u-page">
      {/* COMPACT HEADER STRIP: name, chips, one status line. */}
      <header className="u-head">
        <p className="u-eyebrow" style={{ marginBottom: 10 }}>
          <Link href="/">← All benchmarks</Link>
        </p>
        <div className="u-title-row">
          <h1>{name}</h1>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StageBadge stage="proposed" />
          <SourceBadge entry={entry} />
          <Badge>machine-compiled · accepted by default</Badge>
          {pendingMode && <Badge className="text-warn border-warn/40">policy: explicit-accept mode</Badge>}
        </div>
        <p className="mono mt-3 text-xs text-ink-muted">
          {total} task{total === 1 ? "" : "s"}
          {attention > 0 ? (
            <span style={{ color: "var(--warn-ink)" }}> · {attention} worth a look</span>
          ) : (
            " · nothing flagged"
          )}
          {overridden > 0 ? ` · ${overridden} overridden` : ""}
          {" · "}
          {calNote}
          {" · "}
          {f.counts.captures} capture{f.counts.captures === 1 ? "" : "s"} (newest{" "}
          {f.freshness.newest_capture_utc.slice(0, 10)})
        </p>
        {/* Trivial-arm floors stay loud — a structural red flag, not detail. */}
        {entry.calibration && <CalibrationFloors calibration={entry.calibration} slug={entry.slug} />}
        {entry.crossCheckErrors.length > 0 && (
          <span className="u-foot-note" style={{ color: "var(--warn-ink)" }}>
            {"// tasks.jsonl and benchmark.json disagree on task ids: " + entry.crossCheckErrors.join("; ")}
          </span>
        )}
      </header>

      {/* THE PAGE IS THE INBOX. */}
      <section className="u-sec" id="tasks">
        {total === 0 ? (
          <EmptyState
            what="The foundry emitted no tasks for this output — the source captures produced no execution groups."
            next="understudy traces build-benchmark --source <captures> --output <dir> --max-age-days <n>"
          />
        ) : (
          <TaskInbox slug={entry.slug} readOnly={entry.readOnly} rows={rows} />
        )}
      </section>

      {/* Everything else folds behind one disclosure. */}
      <WorkloadDetails entry={entry} />
    </div>
  );
}

/**
 * Secondary disclosure: the authored workload narrative, prompt-variant
 * evidence, category grid, and loader diagnostics — moved off the main scan
 * path (they used to lead the page).
 */
function WorkloadDetails({ entry }: { entry: ProposedHubEntry }) {
  const overview = entry.overview;
  const hasDiagnostics = entry.diagnostics.skippedLines + entry.diagnostics.droppedRows > 0;
  if (!overview && !hasDiagnostics) return null;
  return (
    <section className="u-sec" id="details">
      <details>
        <summary className="mono cursor-pointer text-[11px] text-ink-muted">workload details — narrative, categories, evidence</summary>

        {overview && (
          <div className="u-card mt-3">
            <h3>What we&apos;ve seen in your workload</h3>
            {overview.workload_summary ? (
              <p className="mt-2 text-sm">{overview.workload_summary}</p>
            ) : (
              <p className="mono mt-2 text-xs text-faint">the overview pass produced no workload summary</p>
            )}
            {(overview.system_prompt_clusters ?? []).length > 0 && (
              <details className="mt-3">
                <summary className="mono cursor-pointer text-[11px] text-ink-muted">
                  {(overview.system_prompt_clusters ?? []).length === 1
                    ? "one canonical system prompt"
                    : `this workload runs ${(overview.system_prompt_clusters ?? []).length} prompt variants`}
                  {" · deterministic evidence"}
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  {(overview.system_prompt_clusters ?? []).map((c) => (
                    <div key={c.hash}>
                      <span className="mono text-[10px] text-faint">
                        {c.hash} · {c.count} capture{c.count === 1 ? "" : "s"} · {(c.coverage * 100).toFixed(0)}% coverage
                      </span>
                      <pre className="u-pre mt-1" style={{ maxHeight: 140 }}>{c.representative_excerpt}</pre>
                    </div>
                  ))}
                  {(overview.tool_usage ?? []).length > 0 && <ToolUsageTable rows={overview.tool_usage ?? []} />}
                </div>
              </details>
            )}
            <p className="mono mt-2 text-[10px] text-faint">
              authored by {overview.model ?? "unknown model"}
              {overview.authored_at ? ` · ${overview.authored_at.slice(0, 10)}` : ""}
            </p>
          </div>
        )}

        {overview && overview.categories.length > 0 && (
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {overview.categories.map((c) => {
              const members = new Set(c.representative_task_ids);
              const representatives = entry.tasks.filter((t) => members.has(t.task_id));
              return (
                <div key={c.category_id} className="u-card">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-bold">{c.archetype_title ?? c.category_id}</span>
                    <Badge>
                      {c.task_count ?? c.representative_task_ids.length} task{(c.task_count ?? 1) === 1 ? "" : "s"}
                    </Badge>
                  </div>
                  {c.archetype_description && <p className="mt-2 text-xs text-ink-muted">{c.archetype_description}</p>}
                  {representatives.length > 0 && (
                    <ul className="mt-3 flex list-none flex-col gap-1 p-0">
                      {representatives.map((t) => {
                        const cx = overview.task_complexity?.[t.task_id];
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
        )}

        {hasDiagnostics && (
          <span className="u-foot-note">
            {"// loader diagnostics: " +
              entry.diagnostics.skippedLines +
              " malformed jsonl lines skipped · " +
              entry.diagnostics.droppedRows +
              " task lines dropped (wrong schema_version)"}
          </span>
        )}
      </details>
    </section>
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
