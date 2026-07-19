import type { BenchmarkVersion } from "@/lib/types";
import { cn } from "@/lib/utils";

const CONTAM_STYLE: Record<string, string> = {
  clean: "text-ok",
  contaminated: "text-bad",
  unknown: "text-warn",
};

function shortHash(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "no hash";
}

/**
 * Horizontal split-freeze history strip (versions.jsonl, newest last).
 * Each dot carries its short splits_sha256 + contamination verdict inline;
 * the current version is the ringed dot.
 */
export function VersionTimeline({ versions }: { versions: BenchmarkVersion[] }) {
  if (versions.length === 0) {
    return (
      <div className="rounded-md border border-rule bg-card p-4 text-sm text-ink-muted">
        No versions.jsonl next to benchmark.json — split-freeze history unavailable. One line per freeze:{" "}
        <code className="font-mono">{`{created_at, splits_sha256, contamination, note}`}</code>, newest last.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-rule bg-card p-5">
      <div className="relative flex min-w-fit items-start gap-0">
        {versions.map((v, i) => {
          const isCurrent = i === versions.length - 1;
          const date = v.created_at.slice(0, 10);
          return (
            <div key={i} className="group relative flex min-w-[170px] flex-1 flex-col items-start pr-6">
              {/* connector */}
              {i < versions.length - 1 && (
                <div className="absolute left-3 right-0 top-[5px] h-px bg-rule-strong" aria-hidden />
              )}
              {/* dot; current = ringed */}
              <span
                title={`${v.created_at}\nsplits_sha256: ${v.splits_sha256 ?? "null"}\ncontamination: ${v.contamination ?? "unknown"}${v.note ? "\n" + v.note : ""}`}
                className={cn(
                  "relative z-10 mb-2 inline-block h-[11px] w-[11px] rounded-full",
                  isCurrent ? "bg-stamp ring-2 ring-stamp/40 ring-offset-2 ring-offset-card" : "bg-ink-muted",
                )}
              />
              <span className="font-mono text-[11px] text-ink">{date}</span>
              <span className="font-mono text-[11px] text-ink-muted">{shortHash(v.splits_sha256)}</span>
              <span className={cn("font-mono text-[11px]", CONTAM_STYLE[v.contamination ?? "unknown"])}>
                {v.contamination ?? "unknown"}
              </span>
              {v.note && (
                <span className="mt-1 hidden max-w-[220px] text-[11px] leading-4 text-ink-muted group-hover:block">
                  {v.note}
                </span>
              )}
              {isCurrent && <span className="mt-1 font-mono text-[10px] uppercase tracking-wide text-stamp">current</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
