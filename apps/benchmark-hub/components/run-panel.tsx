"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/badges";

type RunRequest = {
  run_id: string;
  models: string[];
  split: string;
  tasks: "all" | string[];
  rollouts_per_task: number;
  created_at: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: { completed: number; total: number };
  error?: { class: string; message: string } | null;
  live?: { journal: string; model: string; task_id: string | null } | null;
};

const SPLITS = ["holdout", "dev", "train", "all"] as const;

/** Rough spend estimate: tokens are guessed, never measured — labeled as such. */
const EST_PROMPT_TOKENS_PER_ROLLOUT = 6_000; // multi-turn agentic context
const EST_COMPLETION_TOKENS_PER_ROLLOUT = 1_200;
const EST_USD_PER_M_PROMPT = 0.5;
const EST_USD_PER_M_COMPLETION = 1.5;

const STATUS_COLOR: Record<RunRequest["status"], string> = {
  queued: "var(--warn-ink)",
  running: "var(--live)",
  done: "var(--ok)",
  failed: "var(--bad)",
  cancelled: "var(--muted-foreground)",
};

/**
 * The "Run" affordance on a PROMOTED benchmark page. This panel ONLY writes a
 * run request into the file-based queue via POST /api/runs and re-reads queue
 * state — execution always belongs to `understudy runs execute` (CLI/daemon).
 */
export function RunPanel({
  slug,
  dir,
  readOnly,
  taskCountBySplit,
}: {
  slug: string;
  dir: string;
  readOnly: boolean;
  /** Manifest task counts keyed by split, plus "all". */
  taskCountBySplit: Record<string, number>;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [split, setSplit] = useState<string>("holdout");
  const [rollouts, setRollouts] = useState(1);
  const [runs, setRuns] = useState<RunRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshRuns = useCallback(() => {
    fetch(`/api/runs?slug=${encodeURIComponent(slug)}`)
      .then((res) => (res.ok ? res.json() : { runs: [] }))
      .then((body: { runs?: RunRequest[] }) => setRuns(body.runs ?? []))
      .catch(() => {});
  }, [slug]);

  useEffect(() => {
    fetch("/api/models")
      .then((res) => res.json())
      .then((body: { models?: string[]; error?: string | null }) => {
        setModels(body.models ?? []);
        setModelsError(body.error ?? null);
      })
      .catch(() => setModelsError("could not load gateway models"));
    refreshRuns();
  }, [refreshRuns]);

  // Live status: re-read the queue files while anything is queued/running.
  const active = runs.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(refreshRuns, 5_000);
    return () => clearInterval(timer);
  }, [active, refreshRuns]);

  const taskCount = taskCountBySplit[split] ?? 0;
  const totalRollouts = taskCount * Math.max(selected.length, 0) * rollouts;
  const estUsd = useMemo(
    () =>
      (totalRollouts *
        (EST_PROMPT_TOKENS_PER_ROLLOUT * EST_USD_PER_M_PROMPT + EST_COMPLETION_TOKENS_PER_ROLLOUT * EST_USD_PER_M_COMPLETION)) /
      1_000_000,
    [totalRollouts],
  );

  const toggleModel = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((m) => m !== id) : [...current, id]));

  const queue = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, models: selected, split, tasks: "all", rollouts_per_task: rollouts }),
      });
      const body = (await res.json()) as { error?: string; execute_hint?: string };
      setNotice(res.ok ? `queued — start the executor: ${body.execute_hint}` : body.error ?? `queue failed (${res.status})`);
      refreshRuns();
    } catch {
      setNotice("queue request failed");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (runId: string) => {
    await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, action: "cancel", run_id: runId }),
    }).catch(() => {});
    refreshRuns();
  };

  if (readOnly) {
    return <p className="mono text-xs text-faint">read-only source — runs cannot be queued here</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="u-card" style={{ padding: "14px 16px" }}>
        <h3>Queue a run</h3>
        <p className="mono mt-1 text-[10px] text-faint">
          the UI only writes a run request file — execution is `understudy runs execute --benchmark {dir} --watch`
        </p>
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <span className="mono text-[10px] uppercase tracking-wide text-ink-muted">models (gateway /v1/models)</span>
            {modelsError && <p className="mono mt-1 text-xs text-warn">{modelsError}</p>}
            <div className="mt-1 flex flex-wrap gap-1.5">
              {models.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={selected.includes(id)}
                  className={"u-tab mono" + (selected.includes(id) ? " on" : "")}
                  style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "3px 8px", fontSize: 11 }}
                  onClick={() => toggleModel(id)}
                >
                  {id}
                </button>
              ))}
              {models.length === 0 && !modelsError && <span className="mono text-xs text-faint">loading models…</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <label className="mono flex flex-col gap-1 text-[10px] uppercase tracking-wide text-ink-muted">
              split
              <select className="u-input mono" value={split} onChange={(e) => setSplit(e.target.value)} style={{ padding: "4px 8px" }}>
                {SPLITS.map((s) => (
                  <option key={s} value={s}>
                    {s} ({taskCountBySplit[s] ?? 0} tasks)
                  </option>
                ))}
              </select>
            </label>
            <label className="mono flex flex-col gap-1 text-[10px] uppercase tracking-wide text-ink-muted">
              rollouts / task
              <input
                type="number"
                min={1}
                max={20}
                value={rollouts}
                onChange={(e) => setRollouts(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                className="u-input mono"
                style={{ width: 70, padding: "4px 8px" }}
              />
            </label>
            <div className="mono text-xs text-ink-muted">
              {taskCount} tasks × {selected.length || 0} models × {rollouts} = <b>{totalRollouts}</b> rollouts
              <br />
              <span className="text-faint">rough spend estimate ≈ ${estUsd.toFixed(2)} (guessed tokens, not a quote)</span>
            </div>
            <button type="button" className="u-btn mono" disabled={busy || selected.length === 0 || taskCount === 0} onClick={queue}
              style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 14px", opacity: busy || selected.length === 0 ? 0.5 : 1 }}>
              {busy ? "queueing…" : "Queue run"}
            </button>
          </div>
          {notice && <p className="mono text-xs text-ink-muted" style={{ overflowWrap: "anywhere" }}>{notice}</p>}
        </div>
      </div>

      <div className="u-card" style={{ padding: "14px 16px" }}>
        <h3>Run queue</h3>
        {runs.length === 0 && <p className="mono mt-2 text-xs text-faint">no run requests yet</p>}
        <div className="mt-2 flex flex-col gap-2">
          {[...runs].reverse().map((r) => {
            const pct = r.progress.total > 0 ? Math.round((r.progress.completed / r.progress.total) * 100) : 0;
            return (
              <div key={r.run_id} className="flex flex-wrap items-center gap-2 border-b border-border/40 pb-2">
                <span className="mono text-xs" style={{ color: STATUS_COLOR[r.status] }}>
                  {r.status}
                </span>
                <Badge className="text-ink-bright">{r.run_id}</Badge>
                <span className="mono text-[11px] text-ink-muted">
                  {r.models.join(", ")} · {r.split} · ×{r.rollouts_per_task}
                </span>
                <span className="u-meter" style={{ width: 120 }} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <span className="u-meter-fill" style={{ width: `${pct}%`, background: STATUS_COLOR[r.status] }} />
                </span>
                <span className="mono text-[11px] text-ink-muted">
                  {r.progress.completed}/{r.progress.total}
                </span>
                {r.status === "running" && r.live && (
                  <span className="mono text-[11px]" style={{ color: "var(--live)" }}>
                    ● live: {r.live.model}{r.live.task_id ? ` · ${r.live.task_id}` : ""}
                  </span>
                )}
                {(r.status === "queued" || r.status === "running") && (
                  <button type="button" className="mono text-[11px] text-bad" onClick={() => cancel(r.run_id)}>
                    cancel
                  </button>
                )}
                {r.error && (
                  <span className="mono text-[11px] text-bad" style={{ overflowWrap: "anywhere" }}>
                    {r.error.class}: {r.error.message}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
