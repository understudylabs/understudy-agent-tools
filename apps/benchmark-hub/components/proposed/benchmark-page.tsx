import Link from "next/link";
import type { ProposedHubEntry } from "@/lib/types";
import { Badge, DecisionBadge, SourceBadge, SplitChip, StageBadge, ConfidenceChip } from "@/components/badges";
import { AnchorRail } from "@/components/anchor-rail";
import { EmptyState } from "@/components/empty-state";
import { LineageRail } from "@/components/proposed/lineage";

const RAIL = [
  { id: "tasks", label: "Tasks" },
  { id: "lineage", label: "Lineage" },
  { id: "provenance", label: "Provenance" },
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
    <div className="ent-page">
      <header className="ent-head">
        <p className="lb-eyebrow" style={{ marginBottom: 10 }}>
          <Link href="/">← All benchmarks</Link>
        </p>
        <div className="ent-title-row">
          <h1>{name}</h1>
        </div>
        {/* Chips on their own line — long titles/ids never fight badges */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StageBadge stage="proposed" />
          <SourceBadge entry={entry} />
          <Badge>machine-compiled · review pending</Badge>
        </div>
        <p className="ent-desc">
          Compiled from captured traces by the trace foundry. Every task below is a machine proposal — human final
          judgment gates promotion to an executable benchmark.
        </p>
        <div className="ent-id">
          <span>local only · contains customer payloads · no upload performed</span>
        </div>

        <div className="ent-stats">
          <div className="ent-stat">
            <span className="lab">Tasks</span>
            <span className="val">{total}</span>
            <span className="sub">
              {entry.tasks.filter((t) => t.close_call).length} close call{entry.tasks.filter((t) => t.close_call).length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="ent-stat">
            <span className="lab">Awaiting review</span>
            <span className="val" style={awaiting > 0 ? { color: "var(--warn-ink)" } : undefined}>
              {awaiting}
            </span>
            <span className="sub">{reviewed} reviewed</span>
          </div>
          <div className="ent-stat">
            <span className="lab">Accepted</span>
            <span className="val" style={{ color: accepted > 0 ? "var(--live)" : undefined }}>
              {accepted}
            </span>
            <span className="sub">{restricted} restricted · {needsMore} needs more</span>
          </div>
          <div className="ent-stat">
            <span className="lab">Rejected</span>
            <span className="val" style={{ color: rejected > 0 ? "var(--bad)" : undefined }}>
              {rejected}
            </span>
            <span className="sub">never promoted</span>
          </div>
          <div className="ent-stat">
            <span className="lab">Captures</span>
            <span className="val">{f.counts.captures}</span>
            <span className="sub">newest {f.freshness.newest_capture_utc.slice(0, 10)}</span>
          </div>
        </div>
        {entry.crossCheckErrors.length > 0 && (
          <span className="lb-foot-note" style={{ color: "var(--warn-ink)" }}>
            {"// tasks.jsonl and benchmark.json disagree on task ids: " + entry.crossCheckErrors.join("; ")}
          </span>
        )}
        {entry.diagnostics.skippedLines + entry.diagnostics.droppedRows > 0 && (
          <span className="lb-foot-note">
            {"// loader diagnostics: " +
              entry.diagnostics.skippedLines +
              " malformed jsonl lines skipped · " +
              entry.diagnostics.droppedRows +
              " task lines dropped (wrong schema_version)"}
          </span>
        )}
      </header>

      <div className="ent-layout">
        <AnchorRail sections={RAIL} />
        <div>
          <section className="ent-sec" id="tasks">
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
                <div className="lb-tbl-scroll mt-5">
                  <table className="lb-tbl w-full">
                    <thead>
                      <tr>
                        {["title", "split", "confidence", "close call", "review", "status"].map((h) => (
                          <th key={h} className="l" style={{ cursor: "default" }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {entry.tasks.map((t) => {
                        const review = entry.latestReviewByTask[t.task_id];
                        return (
                          <tr key={t.task_id}>
                            <td className="l" style={{ whiteSpace: "normal", maxWidth: 420 }}>
                              <Link href={`/b/${entry.slug}/task/${encodeURIComponent(t.task_id)}`}>
                                {t.title || t.task_id}
                              </Link>
                              <span className="mono block text-[10px] text-faint">{t.task_id}</span>
                            </td>
                            <td className="l">
                              <SplitChip split={t.split} />
                            </td>
                            <td className="l">
                              <ConfidenceChip level={t.machine_confidence} />
                            </td>
                            <td className="l mono text-xs">{t.close_call ? <span className="text-warn">close call</span> : "—"}</td>
                            <td className="l">
                              <DecisionBadge decision={review?.decision ?? null} />
                            </td>
                            <td className="l mono text-xs text-ink-muted">{t.status}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          <section className="ent-sec" id="lineage">
            <h2>Source lineage</h2>
            <p className="exp">
              How the captured rounds relate: each execution group is one traced conversation, ordered by
              captured_at, with typed edges (retry, prefix_append, branch, destructive_mutation) and the
              common-prefix evidence behind each classification.
            </p>
            {entry.dag && entry.dag.nodes.length > 0 ? (
              <div className="mt-4">
                <LineageRail dag={entry.dag} />
              </div>
            ) : (
              <EmptyState
                what="No source DAG accompanies this output — lineage evidence is unavailable."
                next="re-run: understudy traces build-benchmark  # emits source-dag.json"
              />
            )}
          </section>

          <section className="ent-sec" id="provenance">
            <h2>Provenance</h2>
            <p className="exp">
              What the foundry read, what it filtered, and what it wrote — every capture pinned by sha256 pointer.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="lb-card">
                <h3>Freshness window</h3>
                <div className="mono mt-2 flex flex-col gap-1 text-xs text-ink-muted">
                  <span>max age: {f.freshness.max_age_days} days</span>
                  <span>cutoff: {f.freshness.cutoff_utc}</span>
                  <span>newest capture: {f.freshness.newest_capture_utc}</span>
                </div>
              </div>
              <div className="lb-card">
                <h3>Counts</h3>
                <div className="mono mt-2 flex flex-col gap-1 text-xs text-ink-muted">
                  <span>
                    {f.counts.source_files} source files → {f.counts.captures} captures · {f.counts.tasks} tasks ·{" "}
                    {f.counts.edges} edges
                  </span>
                  <span>{f.counts.stale_filtered} stale captures filtered</span>
                  <span>{f.counts.invalid_timestamp_filtered} invalid-timestamp captures filtered</span>
                </div>
              </div>
              <div className="lb-card md:col-span-2">
                <h3>Privacy</h3>
                <p className="mono mt-2 text-xs text-ink-muted">
                  {[
                    f.privacy?.local_only ? "local only" : "NOT local-only",
                    f.privacy?.contains_customer_payloads ? "contains customer payloads" : "no customer payloads",
                    f.privacy?.upload_performed ? "upload performed" : "no upload performed",
                    f.privacy?.provider_called ? "provider called" : "no provider called",
                  ].join(" · ")}
                </p>
              </div>
            </div>
            <div className="lb-tbl-scroll mt-4" style={{ maxHeight: "40vh" }}>
              <table className="lb-tbl w-full">
                <thead>
                  <tr>
                    {["capture_id", "pointer", "sha256"].map((h) => (
                      <th key={h} className="l" style={{ cursor: "default" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entry.captureIndex.map((c) => (
                    <tr key={c.capture_id}>
                      <td className="l mono text-xs">{c.capture_id}</td>
                      <td className="l mono text-xs text-ink-muted">{c.pointer}</td>
                      <td className="l mono text-[10px] text-faint">{c.sha256}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
