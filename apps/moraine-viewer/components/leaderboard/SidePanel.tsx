"use client";

import { ClusterDatum, modelColor, PROMOTED_GREEN, QUALITY_FLOOR } from "./types";

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div
      style={{
        height: 4,
        width: 72,
        background: "rgba(255,255,255,0.06)",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${Math.min(100, (value / max) * 100)}%`,
          background: color,
          borderRadius: 2,
        }}
      />
    </div>
  );
}

export default function SidePanel({
  cluster,
  onClose,
}: {
  cluster: ClusterDatum;
  onClose: () => void;
}) {
  // measured rows first, each group sorted by quality-per-cost
  const rows = [...cluster.benchmarks].sort(
    (a, b) =>
      Number(b.measured ?? false) - Number(a.measured ?? false) ||
      b.quality / b.costMult - a.quality / a.costMult,
  );
  const maxLatency = Math.max(...rows.map((r) => r.latencyMs));
  const maxCost = Math.max(...rows.map((r) => r.costMult));

  return (
    <aside
      className="mono"
      style={{
        position: "absolute",
        top: 76,
        right: 16,
        bottom: 16,
        width: 380,
        background: "rgba(11,12,14,0.94)",
        border: "1px solid var(--rule)",
        borderRadius: "var(--radius-panel)",
        padding: 20,
        overflowY: "auto",
        fontSize: 12,
        backdropFilter: "blur(6px)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div style={{ color: "var(--ink-bright)", fontSize: 14 }}>{cluster.label}</div>
          <div style={{ color: "var(--ink-muted)", marginTop: 2 }}>
            {cluster.harness} · dominant tool: {cluster.dominantTool}
          </div>
        </div>
        <button
          onClick={onClose}
          className="mono"
          style={{
            background: "none",
            border: "1px solid var(--rule)",
            borderRadius: "var(--radius-control)",
            color: "var(--ink-muted)",
            padding: "2px 8px",
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </div>

      <div style={{ color: "var(--ink-muted)", marginTop: 10, lineHeight: 1.7 }}>
        {fmt(cluster.events)} events · {fmt(cluster.sessions)} sessions · {fmt(cluster.tokens)}{" "}
        tokens
      </div>

      {cluster.promoted && (
        <div style={{ color: PROMOTED_GREEN, marginTop: 8 }}>
          ● promotable — {cluster.winner} clears the quality floor at{" "}
          {(1 / cluster.winnerCostMult).toFixed(0)}x cheaper
        </div>
      )}

      <table style={{ width: "100%", marginTop: 16, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ color: "var(--ink-muted)", textAlign: "left" }}>
            <th style={{ fontWeight: 400, paddingBottom: 8 }}>model</th>
            <th style={{ fontWeight: 400, paddingBottom: 8 }}>quality</th>
            <th style={{ fontWeight: 400, paddingBottom: 8 }}>cost</th>
            <th style={{ fontWeight: 400, paddingBottom: 8 }}>latency</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const color = modelColor(r.model);
            const isWinner = r.model === cluster.winner;
            return (
              <tr
                key={r.model}
                style={{
                  borderTop: "1px solid var(--rule)",
                  color: isWinner ? "var(--ink-bright)" : "var(--ink-muted)",
                }}
              >
                <td style={{ padding: "8px 8px 8px 0" }}>
                  <span style={{ color }}>●</span> {r.model}
                  {isWinner && <span style={{ color: PROMOTED_GREEN }}> ✓</span>}
                  {r.measured && (
                    <span
                      title={`real ${r.measuredKind ?? "measured"} eval, n=${r.measuredN ?? "?"}${r.measuredJudge ? `, judge: ${r.measuredJudge}` : ""}`}
                      style={{
                        marginLeft: 6,
                        padding: "0 5px",
                        border: `1px solid ${PROMOTED_GREEN}`,
                        borderRadius: 3,
                        color: PROMOTED_GREEN,
                        fontSize: 10,
                      }}
                    >
                      measured
                    </span>
                  )}
                </td>
                <td style={{ padding: "8px 8px 8px 0" }}>
                  <div>{(r.quality * 100).toFixed(0)}%</div>
                  <Bar value={r.quality} max={1.05} color={r.qualified ? color : "#555"} />
                </td>
                <td style={{ padding: "8px 8px 8px 0" }}>
                  <div>{(1 / r.costMult).toFixed(0)}x↓</div>
                  <Bar value={r.costMult} max={maxCost} color={color} />
                </td>
                <td style={{ padding: "8px 0" }}>
                  <div>{r.latencyMs}ms</div>
                  <Bar value={r.latencyMs} max={maxLatency} color={color} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ color: "var(--ink-muted)", marginTop: 14, lineHeight: 1.7 }}>
        quality = fraction of frontier-baseline score · floor {(QUALITY_FLOOR * 100).toFixed(0)}% ·
        winner = best quality-per-cost above the floor
      </div>

      <div
        style={{
          marginTop: 16,
          padding: "10px 12px",
          border: "1px dashed var(--rule)",
          borderRadius: "var(--radius-control)",
          color: "var(--state-warn, #d29922)",
          lineHeight: 1.7,
        }}
      >
        {cluster.benchmarks.some((b) => b.measured)
          ? "measured (plan-quality, opus judge) + synthetic — execution evals land with verifiers compile. Rows tagged “measured” are real scores; the rest are deterministic placeholders."
          : "synthetic benchmark data — personal benchmarks land in Stage 4/5. Clusters are real (your events since 2026-06-01); scores are deterministic placeholders."}
      </div>
    </aside>
  );
}
