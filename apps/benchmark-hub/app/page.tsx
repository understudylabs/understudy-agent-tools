import Link from "next/link";
import { loadHub } from "@/lib/data";
import { FlagBadge, OriginBadge, SourceBadge, WarningList } from "@/components/badges";

export const dynamic = "force-dynamic";

export default function HubIndex() {
  const entries = loadHub();
  return (
    <div>
      <h1 className="text-lg font-semibold">Benchmarks</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Discovered from BENCHMARK_HUB_DATA_DIR, <code className="font-mono">.understudy/benchmarks</code>,{" "}
        <code className="font-mono">experiments/benchmark-hub-demo</code>, and repo fixtures.
      </p>
      {entries.length === 0 && (
        <div className="mt-8 rounded-lg border border-rule bg-card p-6 text-sm text-ink-muted">
          No benchmarks found. Point BENCHMARK_HUB_DATA_DIR at a directory of benchmark dirs (each with a
          benchmark.json manifest).
        </div>
      )}
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {entries.map((entry) => {
          const openFlags = entry.flags.filter((f) => f.status === "open").length;
          const models = new Set(entry.rows.map((r) => r.model ?? "(unknown)")).size;
          return (
            <Link
              key={entry.slug}
              href={`/b/${entry.slug}`}
              className="rounded-lg border border-rule bg-card p-4 transition-colors hover:bg-hover"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{entry.manifest.name ?? entry.manifest.benchmark_id}</span>
                <OriginBadge origin={entry.manifest.provenance.origin} />
                <SourceBadge entry={entry} />
                <FlagBadge count={openFlags} />
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-ink-muted">{entry.manifest.description}</p>
              <div className="mt-3 flex gap-4 font-mono text-xs text-ink-muted">
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
    </div>
  );
}
