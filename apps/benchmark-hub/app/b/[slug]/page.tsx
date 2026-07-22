import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntry, loadTaskSidecars } from "@/lib/data";
import { aggregatePromotedTasks } from "@/lib/trajectory-core";
import { TaskTable } from "@/components/task-table";
import {
  categoryScoreSummary,
  computeLeaderboard,
  formatCost,
  formatLatency,
  formatScore,
  hasSplits,
  isAnomalousRow,
} from "@/lib/scores";
import { OriginBadge, SourceBadge, SplitChip, StageBadge, Badge } from "@/components/badges";
import { FlagForm } from "@/components/flag-form";
import { FlagBadge } from "@/components/badges";
import { Leaderboard } from "@/components/leaderboard";
import { InsightsSection } from "@/components/insights";
import { CategoryRadar } from "@/components/radar";
import { AnchorRail } from "@/components/anchor-rail";
import { CopySlug } from "@/components/copy-slug";
import { ProposedBenchmarkPage } from "@/components/proposed/benchmark-page";
import { RunPanel } from "@/components/run-panel";

export const dynamic = "force-dynamic";

const RAIL = [
  { id: "run", label: "Run" },
  { id: "leaderboard", label: "Leaderboard" },
  { id: "insights", label: "Insights" },
  { id: "evidence", label: "Evidence" },
  { id: "taxonomy", label: "Taxonomy" },
  { id: "tasks", label: "Tasks" },
];

function Section({
  id,
  title,
  explainer,
  scope,
  children,
}: {
  id: string;
  title: string;
  explainer: string;
  /** Aggregation scope in force, e.g. "holdout · flagged excluded". */
  scope?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="u-sec" id={id}>
      <h2>
        {title}
        {scope && (
          <span className="mono" style={{ marginLeft: 10, fontSize: 10, fontWeight: 400, color: "var(--muted-foreground)" }}>
            {scope}
          </span>
        )}
      </h2>
      <p className="exp">{explainer}</p>
      {children}
    </section>
  );
}

const CONTAM_COLOR: Record<string, string> = {
  clean: "var(--live)",
  unknown: "var(--warn-ink)",
  contaminated: "var(--bad)",
};

export default async function BenchmarkDetail({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = getEntry(slug);
  if (!entry) notFound();
  if (entry.kind === "proposed") return <ProposedBenchmarkPage entry={entry} />;
  if (entry.kind === "invalid") {
    return (
      <div className="u-page">
        <header className="u-head">
          <p className="u-eyebrow" style={{ marginBottom: 10 }}>
            <Link href="/">← All benchmarks</Link>
          </p>
          <div className="u-title-row">
            <h1>Invalid manifest</h1>
            <Badge className="border-bad/40 text-bad">invalid</Badge>
          </div>
          <div className="u-id">
            <span>{entry.manifestPath}</span>
          </div>
          <p className="u-desc">
            This directory has a benchmark.json that does not validate against understudy.benchmark.v1. Fix the
            manifest to make the benchmark appear here.
          </p>
          <div className="flex flex-col gap-0.5">
            {entry.errors.map((err, i) => (
              <span key={i} className="u-foot-note !mt-0" style={{ color: "var(--bad)" }}>
                {"// " + err}
              </span>
            ))}
          </div>
          <div className="u-empty" style={{ borderColor: "var(--bad-border)" }}>
            <p className="what">This directory stays visible (never silently hidden) until its manifest validates.</p>
            <span className="next">{"fix " + entry.manifestPath + " against schemas/understudy.benchmark.v1.schema.json"}</span>
          </div>
        </header>
      </div>
    );
  }
  const m = entry.manifest;
  const sidecars = loadTaskSidecars(entry);
  const openFlags = entry.flags.filter((f) => f.status === "open");
  const flaggedTaskIds = [...new Set(openFlags.filter((f) => f.task_id).map((f) => f.task_id as string))];
  const benchmarkFlagged = openFlags.some((f) => f.task_id === null);
  // Taxonomy uses the same flag-exclusion discipline as the other sections.
  const catScores = categoryScoreSummary(m, entry.rows, new Set(flaggedTaskIds));
  // All-split summaries for the insights charts (cost/latency aggregate over
  // the full run; flagged tasks stay excluded like the leaderboard default).
  const insightSummaries = computeLeaderboard(m, entry.rows, {
    excludeTaskIds: new Set(flaggedTaskIds),
    split: "all",
  });
  const scoredCategories = m.taxonomy.filter((c) =>
    insightSummaries.some((s) => (s.categoryDetail[c.category_id]?.rowCount ?? 0) > 0),
  ).length;

  // Stat strip: best-arm numbers on the leaderboard's default view
  // (holdout when splits exist), flagged tasks excluded.
  const stripSplit = hasSplits(m) ? ("holdout" as const) : ("all" as const);
  const strip = computeLeaderboard(m, entry.rows, {
    excludeTaskIds: new Set(flaggedTaskIds),
    split: stripSplit,
  });
  const bestArm = strip.find((s) => s.overall != null) ?? null;
  const withCost = strip.filter((s) => s.costPerSuccess != null);
  const bestCost = withCost.length
    ? withCost.reduce((a, b) => ((a.costPerSuccess as number) <= (b.costPerSuccess as number) ? a : b))
    : null;
  const withP50 = strip.filter((s) => s.p50LatencyMs != null);
  const bestP50 = withP50.length
    ? withP50.reduce((a, b) => ((a.p50LatencyMs as number) <= (b.p50LatencyMs as number) ? a : b))
    : null;
  const splitCounts = m.tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.split] = (acc[t.split] ?? 0) + 1;
    return acc;
  }, {});
  const splitsSummary = Object.entries(splitCounts)
    .map(([s, n]) => `${n} ${s}`)
    .join(" · ");
  const contamination = m.splits?.contamination ?? "unknown";
  // Structural-sentinel counts: anomalous rows are excluded from every
  // aggregate on this page but the counts stay visible (marked, not dropped).
  const anomalousRows = entry.rows.filter(isAnomalousRow);
  const anomaliesByTask = anomalousRows.reduce<Record<string, number>>((acc, r) => {
    acc[r.task_id] = (acc[r.task_id] ?? 0) + 1;
    return acc;
  }, {});
  const noLinkedEval = entry.warnings.some((w) => w.kind === "no-linked-eval");
  const otherWarnings = entry.warnings.filter(
    (w) => w.kind !== "no-linked-eval" && w.kind !== "contamination" && w.kind !== "no-splits",
  );

  return (
    <div className="u-page">
      {/* Entity header — one subject, quiet chrome */}
      <header className="u-head">
        <p className="u-eyebrow" style={{ marginBottom: 10 }}>
          <Link href="/">← All benchmarks</Link>
        </p>
        <div className="u-title-row">
          <h1>{m.name ?? m.benchmark_id}</h1>
          <OriginBadge origin={m.provenance.origin} />
          <StageBadge stage="promoted" />
          <SourceBadge entry={entry} />
          <FlagBadge count={openFlags.length} />
          <div className="u-flag-slot">
            <FlagForm slug={entry.slug} taskId={null} readOnly={entry.readOnly} />
          </div>
        </div>
        <div className="u-id">
          <span>{m.benchmark_id}</span>
          <CopySlug text={m.benchmark_id} />
        </div>
        <p className="u-desc">{m.description}</p>

        {/* Stat strip — absorbs the old warning banners */}
        <span className="mono" style={{ fontSize: 10, color: "var(--muted-foreground)" }}>
          {(stripSplit === "holdout" ? "holdout split" : "all splits") + " · flagged excluded · best arm per stat"}
        </span>
        <div className="u-stats">
          <div className="u-stat">
            <span className="lab">Strict score</span>
            <span className="val">{formatScore(bestArm?.overall)}</span>
            <span className="sub">{bestArm ? bestArm.model : "no scored arms"}</span>
          </div>
          <div className="u-stat">
            <span className="lab">Cost p/ success</span>
            <span className="val">
              {bestCost ? ((bestCost.costPerSuccess as number) < 1e-6 ? "≈$0" : formatCost(bestCost.costPerSuccess)) : "—"}
            </span>
            <span className="sub">{bestCost ? `best: ${bestCost.model}` : "no cost data"}</span>
          </div>
          <div className="u-stat">
            <span className="lab">P50 latency</span>
            <span className="val">{formatLatency(bestP50?.p50LatencyMs)}</span>
            <span className="sub">{bestP50 ? `best: ${bestP50.model}` : "no latency data"}</span>
          </div>
          <div className="u-stat">
            <span className="lab">Tasks</span>
            <span className="val">{m.tasks.length}</span>
            <span className="sub">{splitsSummary || "no tasks"}</span>
          </div>
          <div className="u-stat">
            <span className="lab">Contamination</span>
            <span className="val" style={{ color: CONTAM_COLOR[contamination] ?? "var(--warn-ink)" }}>
              {contamination}
            </span>
            {!m.splits?.contamination && <span className="warnline">no split contract</span>}
            {noLinkedEval && <span className="warnline">no linked eval</span>}
          </div>
        </div>
        {anomalousRows.length > 0 && (
          <span className="u-foot-note" style={{ color: "var(--bad)" }}>
            {"// " +
              anomalousRows.length +
              " eval row" +
              (anomalousRows.length === 1 ? "" : "s") +
              " flagged by structural rollout sentinels (" +
              [...new Set(anomalousRows.map((r) => r.anomaly?.kind))].join(", ") +
              ") — excluded from every aggregate on this page, marked on affected tasks below"}
          </span>
        )}
        {benchmarkFlagged && (
          <span className="u-foot-note" style={{ color: "var(--bad)" }}>
            {"// this benchmark has an open whole-benchmark flag"}
          </span>
        )}
        {otherWarnings.map((w) => (
          <span key={w.kind} className="u-foot-note !mt-0" style={{ color: "var(--warn-ink)" }}>
            {"// " + w.label + " — " + w.detail}
          </span>
        ))}
        {(entry.diagnostics.skippedLines > 0 ||
          entry.diagnostics.droppedRows > 0 ||
          entry.diagnostics.foreignRows > 0 ||
          entry.diagnostics.foreignFlags > 0) && (
          <span className="u-foot-note">
            {"// loader diagnostics: " +
              entry.diagnostics.skippedLines +
              " malformed jsonl lines skipped · " +
              entry.diagnostics.droppedRows +
              " rows dropped (wrong schema_version) · " +
              entry.diagnostics.foreignRows +
              " foreign rows + " +
              entry.diagnostics.foreignFlags +
              " foreign flags dropped (benchmark_id mismatch)"}
          </span>
        )}
      </header>

      {/* Anchor rail + sections */}
      <div className="u-layout">
        <AnchorRail sections={RAIL} />
        <div>
          <Section
            id="run"
            title="Run"
            explainer="Queue a benchmark run against gateway models. The hub only writes a run request file; a local `understudy runs execute --watch` daemon executes it and rows stream back into the leaderboard below."
          >
            <div className="mt-4">
              <RunPanel
                slug={entry.slug}
                dir={entry.dir}
                readOnly={entry.readOnly}
                taskCountBySplit={{
                  ...m.tasks.reduce<Record<string, number>>((acc, t) => {
                    acc[t.split] = (acc[t.split] ?? 0) + 1;
                    return acc;
                  }, {}),
                  all: m.tasks.length,
                }}
              />
            </div>
          </Section>

          <Section
            id="leaderboard"
            title="Leaderboard"
            scope={(hasSplits(m) ? "holdout" : "all splits") + " · flagged excluded (defaults; filters below)"}
            explainer="Every arm with eval rows against this benchmark, scored on the frozen split in force. Expand a row for per-category strict/dense detail and run quality."
          >
            <Leaderboard manifest={m} rows={entry.rows} flaggedTaskIds={flaggedTaskIds} />
          </Section>

          <Section
            id="insights"
            title="Insights"
            scope="all splits · flagged excluded"
            explainer="Strict quality against cost and latency across arms. The dashed line is the value frontier — the best score available at each price."
          >
            <InsightsSection manifest={m} summaries={insightSummaries} />
            {scoredCategories >= 3 && insightSummaries.length >= 2 && (
              <CategoryRadar manifest={m} summaries={insightSummaries} />
            )}
          </Section>

          <Section
            id="evidence"
            title="Evidence"
            explainer="The split-freeze contract in force, from versions.jsonl (newest last)."
          >
            {entry.versions.length > 0 ? (
              <p className="mono mt-3 text-xs text-ink-muted">
                {entry.versions.length} freeze{entry.versions.length === 1 ? "" : "s"} · latest{" "}
                {entry.versions[entry.versions.length - 1].created_at.slice(0, 10)} · splits{" "}
                {entry.versions[entry.versions.length - 1].splits_sha256?.slice(0, 12) ?? "no hash"} ·{" "}
                {entry.versions[entry.versions.length - 1].contamination ?? "contamination unknown"}
              </p>
            ) : (
              <p className="mono mt-3 text-xs text-ink-muted">no split freezes recorded (versions.jsonl absent)</p>
            )}
          </Section>

          <Section
            id="taxonomy"
            title="Taxonomy"
            scope="all splits · flagged excluded"
            explainer="The categories this benchmark scores, with the mean strict score across all arms. Derived categories carry their source intent and tool signature."
          >
            <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
              {m.taxonomy.map((c) => (
                <div key={c.category_id} className="u-card">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold">{c.name ?? c.category_id}</span>
                    {c.difficulty && <Badge>{c.difficulty}</Badge>}
                    <span className="mono ml-auto text-sm font-bold">
                      {formatScore(catScores[c.category_id]?.score)}
                      <span className="ml-1 text-[10px] font-normal text-ink-muted">
                        ({catScores[c.category_id]?.n ?? 0} scored rows)
                      </span>
                    </span>
                  </div>
                  {c.derived_from?.intent_summary && (
                    <p className="mt-1 text-xs text-ink-muted">{c.derived_from.intent_summary}</p>
                  )}
                  {c.derived_from?.tool_signature && c.derived_from.tool_signature.length > 0 && (
                    <p className="mono mt-1 text-[11px] text-ink-muted">
                      tools: {c.derived_from.tool_signature.join(", ")}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </Section>

          <Section
            id="tasks"
            title="Tasks"
            explainer="Grouped by example: every task with its rollout count and average reward, distributions embedded in the sortable headers. Click a task for the trajectory explorer."
          >
            <TaskTable
              stage="promoted"
              rows={aggregatePromotedTasks(
                m.tasks,
                entry.rows,
                Object.fromEntries(
                  m.tasks.map((t) => {
                    const q = sidecars[t.task_id]?.question;
                    return [t.task_id, typeof q === "string" && q.trim() ? (q.length > 90 ? q.slice(0, 89) + "…" : q) : t.task_id];
                  }),
                ),
                Object.fromEntries(
                  m.tasks.map((t) => {
                    const q = sidecars[t.task_id]?.question;
                    return [t.task_id, typeof q === "string" ? q.length : 0];
                  }),
                ),
              ).map((a) => {
                const task = m.tasks.find((t) => t.task_id === a.taskId);
                return {
                  taskId: a.taskId,
                  href: `/b/${entry.slug}/task/${encodeURIComponent(a.taskId)}`,
                  displayName: a.displayName,
                  split: task?.split ?? "none",
                  rollouts: a.rollouts,
                  avgScore: a.avgScore,
                  anomalies: anomaliesByTask[a.taskId] ?? 0,
                  promptLength: a.promptLength,
                };
              })}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}
