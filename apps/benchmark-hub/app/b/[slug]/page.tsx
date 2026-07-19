import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntry } from "@/lib/data";
import { categoryScoreSummary, computeLeaderboard, formatScore } from "@/lib/scores";
import { FlagBadge, OriginBadge, SourceBadge, WarningList, Badge } from "@/components/badges";
import { FlagForm } from "@/components/flag-form";
import { Leaderboard } from "@/components/leaderboard";
import { InsightsSection } from "@/components/insights";
import { CategoryRadar } from "@/components/radar";
import { VersionTimeline } from "@/components/version-timeline";

export const dynamic = "force-dynamic";

function SectionHead({ n, title, sub }: { n: string; title: string; sub?: string }) {
  return (
    <>
      <div className="lb-sec-head">
        <span className="lb-sec-no">{n}</span>
        <h2>{title}</h2>
      </div>
      {sub && <p className="lb-sec-sub">{sub}</p>}
    </>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="lb-card">
      <h3 className="lb-cats-label !mr-0 block">{title}</h3>
      <div className="mt-2 text-xs">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="lb-subt">
      <span className="n">{k}</span>
      <span className="v">{v ?? "—"}</span>
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
    <div>
      <section className="lb-hero" style={{ paddingTop: 34 }}>
        <p className="lb-eyebrow">
          <Link href="/">← All benchmarks</Link>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1>{m.name ?? m.benchmark_id}</h1>
          <OriginBadge origin={m.provenance.origin} />
          <SourceBadge entry={entry} />
          <FlagBadge count={openFlags.length} />
        </div>
        <p className="sub">{m.description}</p>
        <p className="lb-foot-note">
          {"// "}
          {m.benchmark_id} · {entry.manifestPath}
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <WarningList warnings={entry.warnings} />
          {benchmarkFlagged && (
            <div className="lb-warn text-xs" style={{ borderColor: "#f0c4bd", background: "#fff8f6", color: "var(--bad)" }}>
              <span className="lab">Flagged</span> — this benchmark has an open whole-benchmark flag.
            </div>
          )}
          <FlagForm slug={entry.slug} taskId={null} readOnly={entry.readOnly} />
        </div>
        <VersionTimeline versions={entry.versions} label="split freeze" />
      </section>

      <section className="lb-section" id="leaderboard">
        <SectionHead
          n="01"
          title="Leaderboard"
          sub="Every arm that has eval rows against this benchmark, scored on the frozen split in force."
        />
        <Leaderboard manifest={m} rows={entry.rows} flaggedTaskIds={flaggedTaskIds} />
      </section>

      <section className="lb-section" id="insights">
        <SectionHead n="02" title="Insights" sub="Quality against cost and latency, plus per-category profiles." />
        <InsightsSection manifest={m} summaries={insightSummaries} />
        {scoredCategories >= 3 && insightSummaries.length >= 2 && (
          <CategoryRadar manifest={m} summaries={insightSummaries} />
        )}
      </section>

      <section className="lb-section" id="evidence">
        <SectionHead
          n="03"
          title="Evidence — split-freeze history"
          sub="Each dot is a frozen split contract from versions.jsonl; the ringed dot is the freeze in force."
        />
        <VersionTimeline versions={entry.versions} label="split freeze" />
      </section>

      <section className="lb-section">
        <SectionHead n="04" title="Taxonomy" />
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
      </section>

      <section className="lb-section">
        <SectionHead n="05" title="Tasks" />
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
      </section>

      {openFlags.length > 0 && (
        <section className="lb-section">
          <SectionHead n="06" title="Open flags" />
          <div className="mt-5 flex flex-col gap-2">
            {openFlags.map((f, i) => (
              <div key={i} className="lb-card text-xs" style={{ padding: "10px 14px" }}>
                <span className="mono text-bad">{f.reason}</span>
                <span className="mono mx-2 text-ink-muted">{f.task_id ?? "(whole benchmark)"}</span>
                <span>{f.note}</span>
                <span className="mono ml-2 text-faint">{f.created_at}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="lb-section grid grid-cols-1 gap-4 md:grid-cols-3" style={{ borderBottom: "none" }}>
        <Panel title="Provenance">
          <KV k="origin" v={m.provenance.origin} />
          {m.provenance.imported_from && (
            <>
              <KV k="format" v={m.provenance.imported_from.format} />
              <KV k="ref" v={m.provenance.imported_from.ref} />
              <KV k="version" v={m.provenance.imported_from.version} />
              <KV k="license" v={m.provenance.imported_from.license ?? <span className="text-warn">unverified</span>} />
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
