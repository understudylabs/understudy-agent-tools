"use client";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StatusController } from "../lib/useStatus";

type Any = Record<string, unknown>;
type CacheHealth = {
  status: "unavailable" | "warming" | "healthy" | "regressed";
  alert: boolean;
  score_pct: number | null;
  baseline_score_pct: number | null;
  regression_points: number | null;
  comparable_turns: number;
  recent_comparable_turns: number;
  recent_missed_tokens: number;
  detail: string;
};

export function UsagePane({ status }: { status: StatusController }) {
  const [captures, setCaptures] = useState<Any | null>(null);
  const [cacheHealth, setCacheHealth] = useState<CacheHealth | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke<Any>("account_captures")
      .then(setCaptures)
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      invoke<CacheHealth>("runtime_cache_health")
        .then((health) => {
          if (!cancelled) setCacheHealth(health);
        })
        .catch(() => {
          if (!cancelled) setCacheHealth(null);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const snap = status.snap;
  const m = snap?.metrics;
  const res = snap?.residency;

  const ok = captures ? captures.ok !== false : true;
  const capErr = captures && typeof captures.error === "string" ? captures.error : null;
  const list = captures
    ? ((captures.captures as Any[]) ||
        (captures.data as Any[]) ||
        (Array.isArray(captures) ? (captures as Any[]) : null))
    : null;

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Usage</h1>
        <p className="pane-sub">Serving resource consumption and remote gateway activity.</p>
      </div>
      <div className="pane-body">
        <div className="card">
          <div className="card-title" style={{ marginBottom: 10 }}>Serving</div>
          <Metric label="CPU" value={m ? `${m.cpu_pct.toFixed(0)}%` : "…"} pct={m?.cpu_pct ?? 0} />
          <Metric label="Memory" value={m ? `${m.mem_used_gb.toFixed(1)} / ${m.mem_total_gb.toFixed(0)} GB` : "…"} pct={m && m.mem_total_gb ? (m.mem_used_gb / m.mem_total_gb) * 100 : 0} />
          <Metric label="Model memory (warm)" value={res ? `${res.used_gb.toFixed(1)} / ${res.usable_gb.toFixed(0)} GB` : "…"} pct={res && res.usable_gb > 0 ? (res.used_gb / res.usable_gb) * 100 : 0} />
          <CacheHealthMetric health={cacheHealth} />
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>Gateway captures</div>
          {err ? (
            <div className="chat-err">{err}</div>
          ) : !captures ? (
            <div className="card-sub">Loading…</div>
          ) : !ok ? (
            <div className="auth-drift">
              <div className="card-sub" style={{ color: "var(--text)", marginBottom: 6 }}>
                Captures unavailable — your active org isn’t authenticated.
              </div>
              <div className="svc-desc">{capErr}</div>
              <div className="svc-desc" style={{ marginTop: 8 }}>
                Re-run <code className="cmd" style={{ display: "inline", padding: "2px 6px" }}>understudy login</code> to authenticate the active org, or switch the active org/project.
              </div>
            </div>
          ) : list ? (
            <>
              <div className="card-sub" style={{ marginBottom: 6 }}>{list.length} capture(s)</div>
              {list.slice(0, 20).map((c, i) => (
                <div key={i} className="svc">
                  <span className="dot running" />
                  <div>
                    <div className="svc-name">{String(c.id ?? c.request_id ?? c.model ?? "capture")}</div>
                    <div className="svc-desc">{String(c.workload ?? c.route ?? c.created_at ?? "")}</div>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <pre className="tool-out">{JSON.stringify(captures, null, 2).slice(0, 800)}</pre>
          )}
        </div>
      </div>
    </>
  );
}

function CacheHealthMetric({ health }: { health: CacheHealth | null }) {
  const value = health?.score_pct == null ? "—" : `${health.score_pct.toFixed(0)}%`;
  const detail = health?.detail ?? "Cache evidence becomes available after supported Pi turns.";
  return (
    <div className={`cache-health${health?.alert ? " regressed" : ""}`}>
      <div className="card-row">
        <span className="cache-health-label">
          <i aria-hidden="true" />
          Cache health
        </span>
        <span className="metric">{value}</span>
      </div>
      <div className="cache-health-detail">{detail}</div>
    </div>
  );
}

function Metric({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="card-row">
        <span style={{ color: "var(--text-2)", fontSize: 12 }}>{label}</span>
        <span className="metric">{value}</span>
      </div>
      <div className="meter"><i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></div>
    </div>
  );
}
