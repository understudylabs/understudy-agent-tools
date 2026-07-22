"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/badges";

type RunRequest = {
  run_id: string;
  models: string[];
  tasks: "all" | string[];
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: { completed: number; total: number };
  created_at: string;
  error?: { class: string; message: string } | null;
};

const STATUS_COLOR: Record<RunRequest["status"], string> = {
  queued: "var(--warn-ink)",
  running: "var(--live)",
  done: "var(--ok)",
  failed: "var(--bad)",
  cancelled: "var(--muted-foreground)",
};

/**
 * Rollout-lab-style "run this task" control for the Replay tab: pick a model
 * (cached gateway /v1/models), a rollout count, and queue a run scoped to
 * THIS task via POST /api/runs (tasks:[task_id]). The UI never orchestrates
 * execution — a local `understudy runs execute --watch` daemon picks the
 * request up; progress renders here from the queue files and the finished
 * arm lands as a selectable accumulation replay (onRowsLanded refetch).
 */
export function RunTaskControls({
  slug,
  taskId,
  stage,
  onRunFinished,
}: {
  slug: string;
  taskId: string;
  stage: "proposed" | "promoted";
  /** Called when a task-scoped run reaches a terminal state (rows landed). */
  onRunFinished: () => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState<string>("");
  const [rollouts, setRollouts] = useState(1);
  const [runs, setRuns] = useState<RunRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshRuns = useCallback(() => {
    fetch(`/api/runs?slug=${encodeURIComponent(slug)}`)
      .then((res) => (res.ok ? res.json() : { runs: [] }))
      .then((body: { runs?: RunRequest[] }) =>
        setRuns((body.runs ?? []).filter((r) => Array.isArray(r.tasks) && r.tasks.includes(taskId))),
      )
      .catch(() => {});
  }, [slug, taskId]);

  useEffect(() => {
    if (stage !== "promoted") return;
    fetch("/api/models")
      .then((res) => res.json())
      .then((body: { models?: string[]; error?: string | null }) => {
        setModels(body.models ?? []);
        setModelsError(body.error ?? null);
        if ((body.models ?? []).length > 0) setModel((body.models as string[])[0]);
      })
      .catch(() => setModelsError("could not load gateway models"));
    refreshRuns();
  }, [stage, refreshRuns]);

  // Poll while a task-scoped run is in flight; refetch the replay when it lands.
  const active = runs.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      const before = runs.filter((r) => r.status === "queued" || r.status === "running").map((r) => r.run_id);
      await new Promise<void>((done) => {
        fetch(`/api/runs?slug=${encodeURIComponent(slug)}`)
          .then((res) => (res.ok ? res.json() : { runs: [] }))
          .then((body: { runs?: RunRequest[] }) => {
            const mine = (body.runs ?? []).filter((r) => Array.isArray(r.tasks) && r.tasks.includes(taskId));
            setRuns(mine);
            if (before.some((id) => mine.find((r) => r.run_id === id && (r.status === "done" || r.status === "failed")))) {
              onRunFinished();
            }
          })
          .catch(() => {})
          .finally(done);
      });
    }, 4_000);
    return () => clearInterval(timer);
  }, [active, runs, slug, taskId, onRunFinished]);

  if (stage !== "promoted") {
    return (
      <button
        type="button"
        disabled
        className="u-tab mono"
        style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 12px", opacity: 0.5 }}
        title="proposed benchmarks cannot run yet"
      >
        Run this task — promote first
      </button>
    );
  }

  const queue = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, models: [model], split: "all", tasks: [taskId], rollouts_per_task: rollouts }),
      });
      const body = (await res.json()) as { error?: string; execute_hint?: string };
      setNotice(res.ok ? null : body.error ?? `queue failed (${res.status})`);
      refreshRuns();
    } catch {
      setNotice("queue request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="mono flex flex-col gap-1 text-[10px] uppercase tracking-wide text-ink-muted">
          model
          <select className="u-input mono" value={model} onChange={(e) => setModel(e.target.value)} style={{ padding: "4px 8px" }}>
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="mono flex flex-col gap-1 text-[10px] uppercase tracking-wide text-ink-muted">
          rollouts
          <input
            type="number"
            min={1}
            max={20}
            value={rollouts}
            onChange={(e) => setRollouts(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            className="u-input mono"
            style={{ width: 64, padding: "4px 8px" }}
          />
        </label>
        <button
          type="button"
          className="u-tab mono"
          disabled={busy || !model}
          onClick={queue}
          style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 14px", opacity: busy || !model ? 0.5 : 1 }}
        >
          {busy ? "queueing…" : "▶ Run this task"}
        </button>
      </div>
      {modelsError && <p className="mono text-xs text-warn">{modelsError}</p>}
      {notice && <p className="mono text-xs text-warn">{notice}</p>}
      {runs.length > 0 && (
        <div className="flex flex-col gap-1">
          {[...runs].reverse().slice(0, 5).map((r) => {
            const pct = r.progress.total > 0 ? Math.round((r.progress.completed / r.progress.total) * 100) : 0;
            return (
              <div key={r.run_id} className="mono flex flex-wrap items-center gap-2 text-[11px]">
                <span style={{ color: STATUS_COLOR[r.status] }}>{r.status}</span>
                <Badge>{r.models.join(", ")}</Badge>
                <span className="u-meter" style={{ width: 100 }} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <span className="u-meter-fill" style={{ width: `${pct}%`, background: STATUS_COLOR[r.status] }} />
                </span>
                <span className="text-ink-muted">
                  {r.progress.completed}/{r.progress.total}
                </span>
                {r.status === "queued" && <span className="text-faint">waiting for the executor daemon…</span>}
                {r.error && <span className="text-bad">{r.error.class}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
