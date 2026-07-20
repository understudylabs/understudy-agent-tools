"use client";

import { useEffect, useMemo, useState } from "react";
import TreemapField from "./TreemapField";
import SidePanel from "./SidePanel";
import { CANDIDATE_MODELS, LeaderboardPayload, MODEL_COLORS } from "./types";

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

export default function LeaderboardView() {
  const [data, setData] = useState<LeaderboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/leaderboard")
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
        return r.json() as Promise<LeaderboardPayload>;
      })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(
    () => data?.clusters.find((c) => c.id === selectedId) ?? null,
    [data, selectedId],
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--field)" }}>
      {/* header strip */}
      <header
        className="mono"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          display: "flex",
          alignItems: "baseline",
          gap: 24,
          padding: "16px 20px",
          fontSize: 12,
          borderBottom: "1px solid var(--rule)",
          background: "rgba(0,0,0,0.7)",
          backdropFilter: "blur(6px)",
        }}
      >
        <span style={{ color: "var(--ink-bright)" }}>leaderboard</span>
        <span style={{ color: "var(--ink-muted)" }}>
          these are your tasks; this is what you could own.
        </span>
        <span style={{ flex: 1 }} />
        {data && (
          <>
            <span style={{ color: "var(--ink-muted)" }}>
              sessions <span style={{ color: "var(--ink)" }}>{fmt(data.totals.sessions)}</span>
            </span>
            <span style={{ color: "var(--ink-muted)" }}>
              events <span style={{ color: "var(--ink)" }}>{fmt(data.totals.events)}</span>
            </span>
            <span style={{ color: "var(--ink-muted)" }}>
              tokens <span style={{ color: "var(--ink)" }}>{fmt(data.totals.tokens)}</span>
            </span>
            <span style={{ color: "var(--ink-muted)" }}>
              est. spend{" "}
              <span style={{ color: "var(--ink)" }}>
                ${data.totals.estSpendUsd.toLocaleString()}
              </span>
            </span>
          </>
        )}
      </header>

      {/* field */}
      <div style={{ position: "absolute", inset: 0, paddingTop: 0 }}>
        {data && (
          <TreemapField
            clusters={data.clusters}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
        {!data && !error && (
          <div
            className="mono breath"
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              color: "var(--ink-muted)",
              fontSize: 12,
            }}
          >
            deriving task clusters from your events…
          </div>
        )}
        {error && (
          <div
            className="mono"
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              color: "var(--state-bad, #f85149)",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}
      </div>

      {/* legend + honesty footer */}
      <footer
        className="mono"
        style={{
          position: "absolute",
          left: 20,
          bottom: 16,
          zIndex: 10,
          fontSize: 11,
          color: "var(--ink-muted)",
          lineHeight: 2,
        }}
      >
        {CANDIDATE_MODELS.map((m) => (
          <span key={m} style={{ marginRight: 16 }}>
            <span style={{ color: MODEL_COLORS[m] }}>●</span> {m}
          </span>
        ))}
        <br />
        <span style={{ color: "var(--state-promoted)" }}>◌</span> promotable at &gt;10x cheaper ·{" "}
        {data?.clusters.some((c) => c.benchmarks.some((b) => b.measured))
          ? "measured (plan-quality, opus judge) + synthetic — execution evals land with verifiers compile"
          : "clusters real, benchmark scores synthetic — personal benchmarks land in Stage 4/5"}
      </footer>

      {selected && <SidePanel cluster={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
