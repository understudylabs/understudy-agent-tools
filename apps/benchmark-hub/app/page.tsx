import Link from "next/link";
import { loadHub } from "@/lib/data";
import { FlagBadge, OriginBadge, SourceBadge, WarningList } from "@/components/badges";
import { VersionTimeline } from "@/components/version-timeline";

export const dynamic = "force-dynamic";

export default function HubIndex() {
  const entries = loadHub();
  // Union of every benchmark's split freezes drives the hub-level release rail.
  const allVersions = entries
    .flatMap((e) => e.versions)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return (
    <div>
      <section className="lb-hero">
        <p className="lb-eyebrow">Local evidence-first benchmark hub</p>
        <h1>Your workloads, benchmarked.</h1>
        <p className="sub">
          Manifests, frozen splits, and eval rows from your own machine — no upload, no account.{" "}
          <b>Every number here is backed by local, auditable evidence.</b>
        </p>
        {allVersions.length > 0 && <VersionTimeline versions={allVersions} label="release" />}
      </section>

      <section className="lb-section">
        <div className="lb-sec-head">
          <span className="lb-sec-no">01</span>
          <h2>Benchmarks</h2>
        </div>
        <p className="lb-sec-sub">
          Discovered from BENCHMARK_HUB_DATA_DIR, <code className="mono">.understudy/benchmarks</code>,{" "}
          <code className="mono">experiments/benchmark-hub-demo</code>, and repo fixtures.
        </p>
        {entries.length === 0 && (
          <div className="lb-state">
            No benchmarks found. Point BENCHMARK_HUB_DATA_DIR at a directory of benchmark dirs (each with a
            benchmark.json manifest).
          </div>
        )}
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {entries.map((entry) => {
            const openFlags = entry.flags.filter((f) => f.status === "open").length;
            const models = new Set(entry.rows.map((r) => r.model ?? "(unknown)")).size;
            return (
              <Link key={entry.slug} href={`/b/${entry.slug}`} className="lb-card block !text-ink transition-shadow hover:shadow-md">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-bold">{entry.manifest.name ?? entry.manifest.benchmark_id}</span>
                  <OriginBadge origin={entry.manifest.provenance.origin} />
                  <SourceBadge entry={entry} />
                  <FlagBadge count={openFlags} />
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-ink-muted">{entry.manifest.description}</p>
                <div className="mono mt-3 flex gap-4 text-xs text-ink-muted">
                  <span>{entry.manifest.taxonomy.length} categories</span>
                  <span>{entry.manifest.tasks.length} tasks</span>
                  <span>{entry.rows.length} rows</span>
                  <span>{models} models</span>
                </div>
                {entry.warnings.length > 0 && (
                  <div className="mt-3">
                    <WarningList warnings={entry.warnings} compact />
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
