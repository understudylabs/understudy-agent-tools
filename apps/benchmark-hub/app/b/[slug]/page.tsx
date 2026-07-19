import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntry } from "@/lib/data";
import {
  categoryScoreSummary,
  computeLeaderboard,
  formatCost,
  formatLatency,
  formatScore,
  hasSplits,
} from "@/lib/scores";
import { OriginBadge, SourceBadge, Badge } from "@/components/badges";
import { FlagForm } from "@/components/flag-form";
import { FlagBadge } from "@/components/badges";
import { Leaderboard } from "@/components/leaderboard";
import { InsightsSection } from "@/components/insights";
import { CategoryRadar } from "@/components/radar";
import { VersionTimeline } from "@/components/version-timeline";
import { AnchorRail } from "@/components/anchor-rail";
import { CopySlug } from "@/components/copy-slug";

export const dynamic = "force-dynamic";

const RAIL = [
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
  children,
}: {
  id: string;
  title: string;
  explainer: string;
  children: React.ReactNode;
}) {
  return (
    <section className="ent-sec" id={id}>
      <h2>{title}</h2>
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
  const m = entry.manifest;
  const openFlags = entry.flags.filter((f) => f.status === "open");
  const flaggedTaskIds = [...new Set(openFlags.filter((f) => f.task_id).map((f) => f.task_id as string))];
  const benchmarkFlagged = openFlags.some((f) => f.task_id === null);
  const catScores = categoryScoreSummary(m, entry.rows);
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
  const noLinkedEval = entry.warnings.some((w) => w.kind === "no-linked-eval");
  const otherWarnings = entry.warnings.filter(
    (w) => w.kind !== "no-linked-eval" && w.kind !== "contamination" && w.kind !== "no-splits",
  );

  return (
    <div>
      {/* Entity header — one subject, quiet chrome */}
      <header className="ent-head">
        <p className="lb-eyebrow" style={{ marginBottom: 10 }}>
          <Link href="/">← All benchmarks</Link>
        </p>
        <div className="ent-title-row">
          <h1>{m.name ?? m.benchmark_id}</h1>
          <OriginBadge origin={m.provenance.origin} />
          <SourceBadge entry={entry} />
          <FlagBadge count={openFlags.length} />
          <div className="ent-flag-slot">
            <FlagForm slug={entry.slug} taskId={null} readOnly={entry.readOnly} />
          </div>
        </div>
        <div className="ent-id">
          <span>{m.benchmark_id}</span>
          <CopySlug text={m.benchmark_id} />
        </div>
        <p className="ent-desc">{m.description}</p>

        {/* Stat strip — absorbs the old warning banners */}
        <div className="ent-stats">
          <div className="ent-stat">
            <span className="lab">Strict score</span>
            <span className="val">{formatScore(bestArm?.overall)}</span>
            <span className="sub">{bestArm ? bestArm.model : "no scored arms"}</span>
          </div>
          <div className="ent-stat">
            <span className="lab">Cost p/ success</span>
            <span className="val">
              {bestCost ? ((bestCost.costPerSuccess as number) < 1e-6 ? "≈$0" : formatCost(bestCost.costPerSuccess)) : "—"}
            </span>
            <span className="sub">{bestCost ? `best: ${bestCost.model}` : "no cost data"}</span>
          </div>
          <div className="ent-stat">
            <span className="lab">P50 latency</span>
            <span className="val">{formatLatency(bestP50?.p50LatencyMs)}</span>
            <span className="sub">{bestP50 ? `best: ${bestP50.model}` : "no latency data"}</span>
          </div>
          <div className="ent-stat">
            <span className="lab">Tasks</span>
            <span className="val">{m.tasks.length}</span>
            <span className="sub">{splitsSummary || "no tasks"}</span>
          </div>
          <div className="ent-stat">
            <span className="lab">Contamination</span>
            <span className="val" style={{ color: CONTAM_COLOR[contamination] ?? "var(--warn-ink)" }}>
              {contamination}
            </span>
            {!m.splits?.contamination && <span className="warnline">no split contract</span>}
            {noLinkedEval && <span className="warnline">no linked eval</span>}
          </div>
        </div>
        {benchmarkFlagged && (
          <span className="lb-foot-note" style={{ color: "var(--bad)" }}>
            {"// this benchmark has an open whole-benchmark flag"}
          </span>
        )}
        {otherWarnings.map((w) => (
          <span key={w.kind} className="lb-foot-note !mt-0" style={{ color: "var(--warn-ink)" }}>
            {"// " + w.label + " — " + w.detail}
          </span>
        ))}
      </header>

      {/* Anchor rail + sections */}
      <div className="ent-layout">
        <AnchorRail sections={RAIL} />
        <div>
          <Section
            id="leaderboard"
            title="Leaderboard"
            explainer="Every arm with eval rows against this benchmark, scored on the frozen split in force. Expand a row for per-category strict/dense detail and run quality."
          >
            <Leaderboard manifest={m} rows={entry.rows} flaggedTaskIds={flaggedTaskIds} />
          </Section>

          <Section
            id="insights"
            title="Insights"
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
            explainer="Split-freeze history from versions.jsonl: each dot is a frozen split contract, the ringed dot is the freeze in force."
          >
            <VersionTimeline versions={entry.versions} label="split freeze" />
          </Section>

          <Section
            id="taxonomy"
            title="Taxonomy"
            explainer="The categories this benchmark scores, with the mean strict score across all arms. Derived categories carry their source intent and tool signature."
          >
            <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
              {m.taxonomy.map((c) => (
                <div key={c.category_id} className="lb-card">
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
            explainer="Every task in the manifest with its category, genesis, split, and gold. Click a task to inspect its eval rows and trace branches."
          >
            <div className="lb-tbl-scroll mt-5">
              <table className="lb-tbl w-full">
                <thead>
                  <tr>
                    {["task_id", "category", "genesis", "split", "gold", "flags"].map((h) => (
                      <th key={h} className="l" style={{ cursor: "default" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {m.tasks.map((t) => {
                    const nFlags = openFlags.filter((f) => f.task_id === t.task_id).length;
                    return (
                      <tr key={t.task_id}>
                        <td className="l mono text-xs">
                          <Link href={`/b/${entry.slug}/task/${encodeURIComponent(t.task_id)}`}>{t.task_id}</Link>
                        </td>
                        <td className="l">{t.category_id}</td>
                        <td className="l mono text-xs">{t.genesis}</td>
                        <td className="l mono text-xs">{t.split}</td>
                        <td className="l mono text-xs">
                          {t.gold ? t.gold.kind : <span className="text-warn">none (unscored)</span>}
                        </td>
                        <td className="l">
                          <FlagBadge count={nFlags} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
