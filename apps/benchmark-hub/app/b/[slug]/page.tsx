import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntry } from "@/lib/data";
import { categoryScoreSummary, computeLeaderboard, formatScore } from "@/lib/scores";
import { FlagBadge, OriginBadge, SourceBadge, WarningList, Badge } from "@/components/badges";
import { FlagForm } from "@/components/flag-form";
import { Leaderboard } from "@/components/leaderboard";
import { QualityCostScatter } from "@/components/insights";
import { CategoryRadar } from "@/components/radar";
import { VersionTimeline } from "@/components/version-timeline";

export const dynamic = "force-dynamic";

function SectionHeading({ n, title }: { n: string; title: string }) {
  return (
    <h2 className="mb-4 flex items-baseline gap-2.5 text-sm font-semibold">
      <span className="font-mono text-xs font-normal text-stamp">{n}</span>
      {title}
    </h2>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-rule bg-card p-4">
      <h3 className="font-mono text-[11px] uppercase tracking-wide text-ink-muted">{title}</h3>
      <div className="mt-2 text-xs">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-rule py-1 last:border-0">
      <span className="text-ink-muted">{k}</span>
      <span className="text-right font-mono">{v ?? "—"}</span>
    </div>
  );
}

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

  return (
    <div className="flex flex-col gap-12">
      <div>
        <Link href="/" className="text-xs text-ink-muted hover:text-ink">← all benchmarks</Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{m.name ?? m.benchmark_id}</h1>
          <OriginBadge origin={m.provenance.origin} />
          <SourceBadge entry={entry} />
          <FlagBadge count={openFlags.length} />
        </div>
        <p className="mt-1 text-sm text-ink-muted">{m.description}</p>
        <p className="mt-1 font-mono text-xs text-ink-muted">
          {m.benchmark_id} · {entry.manifestPath}
        </p>
        <div className="mt-3 flex flex-col gap-3">
          <WarningList warnings={entry.warnings} />
          {benchmarkFlagged && (
            <div className="rounded-md border border-bad/40 bg-bad/10 px-2.5 py-1.5 text-xs text-bad">
              This benchmark has an open whole-benchmark flag.
            </div>
          )}
          <FlagForm slug={entry.slug} taskId={null} readOnly={entry.readOnly} />
        </div>
      </div>

      <section>
        <SectionHeading n="01" title="Leaderboard" />
        <Leaderboard manifest={m} rows={entry.rows} flaggedTaskIds={flaggedTaskIds} />
      </section>

      <section>
        <SectionHeading n="02" title="Insights" />
        <div className="flex flex-col gap-4">
          <QualityCostScatter summaries={insightSummaries} />
          {scoredCategories >= 3 && insightSummaries.length >= 2 && (
            <CategoryRadar manifest={m} summaries={insightSummaries} />
          )}
        </div>
      </section>

      <section>
        <SectionHeading n="03" title="Evidence — split-freeze history" />
        <VersionTimeline versions={entry.versions} />
      </section>

      <section>
        <SectionHeading n="04" title="Taxonomy" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {m.taxonomy.map((c) => (
            <div key={c.category_id} className="rounded-lg border border-rule bg-card p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{c.name ?? c.category_id}</span>
                {c.difficulty && <Badge className="text-ink-muted">{c.difficulty}</Badge>}
                <span className="ml-auto font-mono text-sm font-semibold">
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
                <p className="mt-1 font-mono text-[11px] text-ink-muted">
                  tools: {c.derived_from.tool_signature.join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionHeading n="05" title="Tasks" />
        <div className="overflow-x-auto rounded-lg border border-rule">
          <table className="w-full border-collapse bg-card text-sm">
            <thead className="border-b border-rule font-mono text-[11px] text-ink-muted">
              <tr>
                {["task_id", "category", "genesis", "split", "gold", "flags"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.tasks.map((t) => {
                const nFlags = openFlags.filter((f) => f.task_id === t.task_id).length;
                return (
                  <tr key={t.task_id} className="border-b border-rule last:border-0 hover:bg-hover">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link href={`/b/${entry.slug}/task/${encodeURIComponent(t.task_id)}`} className="text-stamp hover:underline">
                        {t.task_id}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs">{t.category_id}</td>
                    <td className="px-3 py-2 font-mono text-xs">{t.genesis}</td>
                    <td className="px-3 py-2 font-mono text-xs">{t.split}</td>
                    <td className="px-3 py-2 font-mono text-xs">{t.gold ? t.gold.kind : <span className="text-warn">none (unscored)</span>}</td>
                    <td className="px-3 py-2"><FlagBadge count={nFlags} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {openFlags.length > 0 && (
        <section>
          <SectionHeading n="06" title="Open flags" />
          <div className="flex flex-col gap-2">
            {openFlags.map((f, i) => (
              <div key={i} className="rounded-md border border-bad/30 bg-card px-3 py-2 text-xs">
                <span className="font-mono text-bad">{f.reason}</span>
                <span className="mx-2 text-ink-muted">{f.task_id ?? "(whole benchmark)"}</span>
                <span>{f.note}</span>
                <span className="ml-2 text-ink-muted">{f.created_at}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Panel title="Provenance">
          <KV k="origin" v={m.provenance.origin} />
          {m.provenance.imported_from && (
            <>
              <KV k="format" v={m.provenance.imported_from.format} />
              <KV k="ref" v={m.provenance.imported_from.ref} />
              <KV k="version" v={m.provenance.imported_from.version} />
              <KV
                k="license"
                v={m.provenance.imported_from.license ?? <span className="text-warn">unverified</span>}
              />
            </>
          )}
          {(m.provenance.source_refs ?? []).map((r) => (
            <KV key={r} k="source_ref" v={r} />
          ))}
          <KV k="linked_eval" v={m.linked_eval?.eval_id ?? <span className="text-warn">none</span>} />
          <KV k="splits" v={m.splits?.boundary ?? "—"} />
          <KV k="contamination" v={m.splits?.contamination ?? <span className="text-warn">no split contract</span>} />
        </Panel>
        <Panel title="Environment">
          <KV k="format" v={m.environment.format} />
          <KV k="package_ref" v={m.environment.package_ref} />
          <KV k="runtime" v={m.environment.runtime} />
          <KV k="verifiers pin" v={m.environment.verifiers_version_pin} />
          <KV k="tools" v={(m.environment.tool_surface ?? []).join(", ") || "—"} />
        </Panel>
        <Panel title="Verifier">
          <KV k="kind" v={m.verifier.kind} />
          <KV k="strict_metric" v={m.verifier.strict_metric} />
          <KV k="dense_metric" v={m.verifier.dense_metric} />
          <KV k="replayable" v={String(m.verifier.replayable ?? "unknown")} />
          <KV k="row schema" v={m.results_contract?.row_schema} />
          <KV k="projection" v={m.results_contract?.branch_projection} />
        </Panel>
      </section>
    </div>
  );
}
