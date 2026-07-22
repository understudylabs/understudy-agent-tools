"use client";

import { useState } from "react";
import type { BenchmarkVersion } from "@/lib/types";

const CONTAM_LABEL: Record<string, string> = {
  clean: "clean",
  contaminated: "CONTAMINATED",
  unknown: "contamination unknown",
};

function shortHash(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "no hash";
}

/**
 * LiveBench-style release-timeline card over versions.jsonl (newest last).
 * Blue dots = past freezes, green-ringed dot = current freeze; clicking a
 * dot inspects that freeze. Reused as the split-freeze evidence strip.
 */
export function VersionTimeline({
  versions,
  label = "release",
}: {
  versions: BenchmarkVersion[];
  label?: string;
}) {
  const [sel, setSel] = useState<number | null>(null);
  if (versions.length === 0) {
    return (
      <div className="u-tl">
        <div className="u-tl-head">
          <span className="lab">{label}</span>
        </div>
        <div className="u-tl-note">
          No versions.jsonl next to benchmark.json — split-freeze history unavailable. One line per freeze:{" "}
          <code className="mono">{`{created_at, splits_sha256, contamination, note}`}</code>, newest last.
        </div>
      </div>
    );
  }
  const latest = versions.length - 1;
  const i = sel ?? latest;
  const v = versions[i];
  const date = (idx: number) => versions[idx].created_at.slice(0, 10);
  const pos = (idx: number) => (versions.length === 1 ? 100 : (idx / latest) * 100);

  return (
    <div className="u-tl">
      <div className="u-tl-head">
        <span className="lab">{label}</span>
        <span className="date">{date(i)}</span>
      </div>
      <div className="u-tl-rail">
        <div className="u-tl-rail-line" aria-hidden />
        <div className="u-tl-rail-prog" style={{ width: `${pos(i)}%` }} aria-hidden />
        {versions.map((ver, idx) => (
          <button
            key={idx}
            className={`u-dot ${idx === latest ? "active" : idx <= i ? "done" : ""}`}
            style={{ left: `${pos(idx)}%` }}
            onClick={() => setSel(idx === latest ? null : idx)}
            title={`${ver.created_at}\nsplits_sha256: ${ver.splits_sha256 ?? "null"}\ncontamination: ${ver.contamination ?? "unknown"}${ver.note ? "\n" + ver.note : ""}`}
            aria-label={`Freeze ${date(idx)}`}
          />
        ))}
      </div>
      <div className="u-tl-ends">
        <span>{date(0)}</span>
        <span>{date(latest)}</span>
      </div>
      <div className="u-tl-note mono">
        Showing <b>{date(i)}</b>
        {i === latest ? (
          <>
            {" "}
            — the latest freeze. <span className="u-live-dot" aria-hidden /> live
          </>
        ) : (
          " — a past freeze."
        )}{" "}
        · splits {shortHash(v.splits_sha256)} · {CONTAM_LABEL[v.contamination ?? "unknown"] ?? v.contamination}
        {v.note ? <> · {v.note}</> : null}
      </div>
    </div>
  );
}
