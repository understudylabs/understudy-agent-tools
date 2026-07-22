import Link from "next/link";
import { loadHub } from "@/lib/data";
import type { HubEntry, InvalidHubEntry, ProposedHubEntry } from "@/lib/types";
import { FlagBadge, OriginBadge, SourceBadge, StageBadge, WarningList } from "@/components/badges";
import { VersionTimeline } from "@/components/version-timeline";

export const dynamic = "force-dynamic";

function ProposedCard({ entry }: { entry: ProposedHubEntry }) {
  const reviewed = Object.keys(entry.latestReviewByTask).length;
  const total = entry.tasks.length;
  const awaiting = Math.max(0, total - reviewed);
  const newest = entry.foundry.freshness?.newest_capture_utc?.slice(0, 10) ?? "unknown";
  return (
    <Link href={`/b/${entry.slug}`} className="u-card block !text-ink transition-shadow hover:shadow-md">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-bold">{entry.dir.split("/").pop()}</span>
        <StageBadge stage="proposed" />
        <SourceBadge entry={entry} />
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Compiled from captured traces by the foundry — every task awaits human final judgment before promotion.
      </p>
      <div className="mono mt-3 flex flex-wrap gap-4 text-xs text-ink-muted">
        <span>{total} tasks</span>
        <span>{entry.foundry.counts?.captures ?? 0} captures</span>
        <span>
          reviewed {reviewed}/{total}
        </span>
        <span>newest capture {newest}</span>
      </div>
      <div className="mono mt-2 text-[11px] text-ink-muted">local only · contains customer payloads</div>
      {awaiting > 0 && (
        <div className="mt-3">
          <span className="u-warn inline-block text-xs">
            <span className="lab">machine-proposed</span> · {awaiting} task{awaiting === 1 ? "" : "s"} awaiting
            review
          </span>
        </div>
      )}
    </Link>
  );
}

export default function HubIndex() {
  const allEntries = loadHub();
  const entries = allEntries.filter((e): e is HubEntry => e.kind === "ok");
  const proposedEntries = allEntries.filter((e): e is ProposedHubEntry => e.kind === "proposed");
  const invalidEntries = allEntries.filter((e): e is InvalidHubEntry => e.kind === "invalid");
  // Union of every benchmark's split freezes drives the hub-level release rail.
  const allVersions = entries
    .flatMap((e) => e.versions)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return (
    <div>
      <section className="u-hero" style={{ paddingTop: 34 }}>
        <p className="u-eyebrow">Local evidence-first benchmark hub</p>
        <h1 style={{ fontSize: "clamp(24px, 3.6vw, 36px)" }}>Your workloads, benchmarked.</h1>
        <p className="sub">
          Manifests, frozen splits, and eval rows from your own machine — no upload, no account.{" "}
          <b>Every number here is backed by local, auditable evidence.</b>
        </p>
        {allVersions.length > 0 && <VersionTimeline versions={allVersions} label="release" />}
      </section>

      <section className="u-section">
        <div className="u-sec-head">
          <span className="u-sec-no">01</span>
          <h2>Benchmarks</h2>
        </div>
        <p className="u-sec-sub">
          Discovered from BENCHMARK_HUB_DATA_DIR (colon-separated dirs; default{" "}
          <code className="mono">~/.understudy/benchmarks</code>) — plus repo demo data and fixtures when
          BENCHMARK_HUB_DEMO=1.
        </p>
        {invalidEntries.length > 0 && (
          <div className="mt-4 flex flex-col gap-3">
            {invalidEntries.map((entry) => (
              <div key={entry.slug} className="u-card" style={{ borderColor: "var(--bad)" }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-bold" style={{ color: "var(--bad)" }}>
                    Invalid manifest
                  </span>
                  <span className="mono text-xs text-ink-muted">{entry.manifestPath}</span>
                </div>
                <div className="mono mt-2 flex flex-col gap-0.5 text-xs" style={{ color: "var(--bad)" }}>
                  {entry.errors.map((err, i) => (
                    <span key={i}>{"// " + err}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {allEntries.length === 0 && (
          <div className="u-empty">
            <p className="what">
              No benchmarks found — the data dir has no benchmark directories yet. Build one from your own traces,
              or import/derive one with the skills.
            </p>
            <span className="next">
              {"understudy traces build-benchmark --source ~/.understudy/captures --output ~/.understudy/benchmarks/<name>\n" +
                "# or: point BENCHMARK_HUB_DATA_DIR at existing benchmark dirs · import/derive via the capture-evidence & ingest-traces skills"}
            </span>
          </div>
        )}
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {proposedEntries.map((entry) => (
            <ProposedCard key={entry.slug} entry={entry} />
          ))}
          {entries.map((entry) => {
            const openFlags = entry.flags.filter((f) => f.status === "open").length;
            const models = new Set(entry.rows.map((r) => r.model ?? "(unknown)")).size;
            return (
              <Link key={entry.slug} href={`/b/${entry.slug}`} className="u-card block !text-ink transition-shadow hover:shadow-md">
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
