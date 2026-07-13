"use client";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { StatusController, ServiceState, SlotView } from "../lib/useStatus";
import { ResidencyPanel } from "./ResidencyPanel";

type ToolStatus = {
  id: string;
  label: string;
  installed: boolean;
  update_available: boolean;
  command: string;
  detail: string;
};

type SnapshotModel = {
  id: string;
  short_name?: string | null;
  name: string;
  approx_gb: number;
  cached: boolean;
  incomplete: boolean;
  default_rung: boolean;
};

type BootstrapStatus = {
  uv: ToolStatus;
  understudy: ToolStatus;
  moraine: ToolStatus;
  moraine_mcp: ToolStatus;
  mlx: ToolStatus;
  account_connected: boolean;
  models_dir: string;
  snapshots: SnapshotModel[];
};

type DownloadProgress = {
  id: string;
  model_id: string;
  status: "running" | "done" | "error" | "cancelled";
  planned_files: number;
  files: Record<string, { downloaded: number; total?: number | null }>;
  downloaded_bytes: number;
  resumed_bytes: number;
  total_bytes?: number | null;
  error?: string | null;
  resumable: boolean;
  logs: string[];
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function downloadPct(row?: DownloadProgress) {
  return row?.total_bytes ? (row.downloaded_bytes / row.total_bytes) * 100 : null;
}

function downloadDetail(row: DownloadProgress | undefined, fallback: string, incomplete = false) {
  if (!row) return incomplete ? `Interrupted download · Resume keeps verified partial files · ${fallback}` : fallback;
  const pct = downloadPct(row);
  const progress = `${formatBytes(row.downloaded_bytes)}${row.total_bytes ? ` / ${formatBytes(row.total_bytes)}` : ""}`;
  if (row.status === "running") {
    const resumed = row.resumed_bytes > 0 ? ` · resumed ${formatBytes(row.resumed_bytes)}` : "";
    return `${progress}${pct == null ? "" : ` · ${pct.toFixed(0)}%`}${resumed}`;
  }
  if (row.status === "error") {
    return `Paused after an error · ${row.error || "Retry to continue"} · partial files are kept`;
  }
  if (row.status === "cancelled") return `Paused at ${progress} · Resume keeps partial files`;
  return `Downloaded ${row.planned_files || Object.keys(row.files).length} files`;
}

type SidekickRun = {
  id: number;
  session_id: string;
  mode: string;
  task: string;
  model?: string | null;
  content?: string | null;
  elapsed_ms?: number | null;
  tool_calls: number;
  session_messages: number;
  escalated: boolean;
  accepted?: boolean | null;
  consumed: boolean;
  run_at: string;
};

type SidekickDecision = {
  id: number;
  session_id: string;
  route: string;
  prompt_excerpt: string;
  eligible: boolean;
  reason: string;
  created_at: string;
};

type SidekickEvent = {
  id: number;
  session_id: string;
  mode: string;
  stage: string;
  detail: string;
  created_at: string;
};

type SidekickMetrics = {
  rows: number;
  parallel_rows: number;
  consumed_rows: number;
  escalated_rows: number;
  useful_rows: number;
  miss_rows: number;
  pending_feedback_rows: number;
  avg_elapsed_ms?: number | null;
  avg_tool_calls?: number | null;
  handoff_rate?: number | null;
  escalation_rate?: number | null;
  useful_rate?: number | null;
};

export function StatusPane({ status }: { status: StatusController }) {
  const { snap, busy, connect, disconnect } = status;
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadProgress[]>([]);
  const [bootErr, setBootErr] = useState<string | null>(null);
  const [parallelSidekick, setParallelSidekick] = useState(false);
  const [sidekickRuns, setSidekickRuns] = useState<SidekickRun[]>([]);
  const [sidekickDecisions, setSidekickDecisions] = useState<SidekickDecision[]>([]);
  const [sidekickEvents, setSidekickEvents] = useState<SidekickEvent[]>([]);
  const [sidekickMetrics, setSidekickMetrics] = useState<SidekickMetrics | null>(null);

  const refreshBootstrap = () => {
    invoke<BootstrapStatus>("bootstrap_status")
      .then((next) => {
        setBootstrap(next);
        setBootErr(null);
      })
      .catch((e) => setBootErr(String(e)));
  };

  const refreshDownloads = () => {
    invoke<DownloadProgress[]>("list_snapshot_downloads")
      .then(setDownloads)
      .catch((e) => setBootErr(String(e)));
  };

  useEffect(() => {
    refreshBootstrap();
    const timer = setInterval(refreshBootstrap, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    refreshDownloads();
    const timer = setInterval(refreshDownloads, 1000);
    return () => clearInterval(timer);
  }, []);

  const refreshSidekickRuns = () => {
    invoke<SidekickRun[]>("sidekick_runs", { limit: 5 })
      .then(setSidekickRuns)
      .catch(() => setSidekickRuns([]));
    invoke<SidekickDecision[]>("sidekick_decisions", { limit: 3 })
      .then(setSidekickDecisions)
      .catch(() => setSidekickDecisions([]));
    invoke<SidekickEvent[]>("sidekick_events", { limit: 4 })
      .then(setSidekickEvents)
      .catch(() => setSidekickEvents([]));
    invoke<SidekickMetrics>("sidekick_metrics", { limit: 100 })
      .then(setSidekickMetrics)
      .catch(() => setSidekickMetrics(null));
  };

  useEffect(() => {
    invoke<string | null>("get_setting", { key: "sidekick.parallel" })
      .then((value) => setParallelSidekick(value !== "off"))
      .catch(() => setParallelSidekick(true));
    refreshSidekickRuns();
    const timer = setInterval(refreshSidekickRuns, 5000);
    return () => clearInterval(timer);
  }, []);

  async function setParallelLane(next: boolean) {
    setParallelSidekick(next);
    try {
      await invoke("set_setting", { key: "sidekick.parallel", value: next ? "on" : "off" });
    } catch (e) {
      setParallelSidekick(!next);
      setBootErr(String(e));
    }
  }

  async function markSidekickRun(runId: number, accepted: boolean | null) {
    try {
      await invoke("set_sidekick_run_feedback", { runId, accepted });
      refreshSidekickRuns();
    } catch (e) {
      setBootErr(String(e));
    }
  }

  const model = useMemo(() => {
    const rows = bootstrap?.snapshots ?? [];
    return (
      rows.find((row) => row.id.endsWith("-understudy") && row.default_rung) ??
      rows.find((row) => row.id.endsWith("-understudy")) ??
      rows[0]
    );
  }, [bootstrap]);
  const sidekickModel = useMemo(() => {
    const rows = bootstrap?.snapshots ?? [];
    return (
      rows.find((row) => row.short_name === "understudy-small") ??
      rows.find((row) => row.id.includes("e2b") && row.id.endsWith("-understudy"))
    );
  }, [bootstrap]);
  const sidekickSlot = useMemo(() => {
    const slots = snap?.residency.slots ?? [];
    return slots.find((slot) => {
      const id = slot.model_id ?? "";
      return id.includes("understudy-small") || id.includes("e2b");
    });
  }, [snap]);
  const defaultDownload = model ? downloadFor(model.id) : undefined;
  const sidekickDownload = sidekickModel ? downloadFor(sidekickModel.id) : undefined;

  async function runInstall(id: "install_uv" | "install_moraine" | "install_mlx_runtime" | "install_understudy_agent_tools") {
    setAction(id);
    setBootErr(null);
    try {
      await invoke(id);
      refreshBootstrap();
      status.refresh();
    } catch (e) {
      setBootErr(String(e));
    } finally {
      setAction(null);
    }
  }

  function downloadFor(modelId: string) {
    return (
      downloads.find((row) => row.model_id === modelId && row.status === "running") ??
      downloads.find((row) => row.model_id === modelId)
    );
  }

  async function waitForDownload(downloadId: string): Promise<boolean> {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const row = await invoke<DownloadProgress>("snapshot_download_status", { downloadId });
      setDownloads((current) => [row, ...current.filter((item) => item.id !== row.id)]);
      if (row.status === "done") return true;
      if (row.status === "error") throw new Error(row.error || "Model download failed");
      if (row.status === "cancelled") throw new Error("Model download paused");
    }
  }

  async function downloadModel(modelId: string, wait = false): Promise<boolean> {
    setBootErr(null);
    try {
      const downloadId = await invoke<string>("start_snapshot_download", { modelId });
      refreshDownloads();
      if (wait) {
        await waitForDownload(downloadId);
        refreshBootstrap();
        status.refresh();
      }
      return true;
    } catch (e) {
      setBootErr(String(e));
      refreshDownloads();
      return false;
    }
  }

  async function cancelDownload(downloadId: string) {
    setBootErr(null);
    try {
      await invoke("cancel_snapshot_download", { downloadId });
      refreshDownloads();
      refreshBootstrap();
    } catch (e) {
      setBootErr(String(e));
    }
  }

  async function setupSidekick() {
    if (!sidekickModel) return;
    setAction("setup_sidekick");
    setBootErr(null);
    try {
      if (!sidekickModel.cached) {
        if (!(await downloadModel(sidekickModel.id, true))) return;
      }
      const slotId =
        sidekickSlot?.id ??
        (await invoke<number>("add_slot"));
      if (sidekickSlot?.model_id !== sidekickModel.id) {
        await invoke("assign_slot", { slotId, modelId: sidekickModel.id });
      }
      await invoke("warm_slot", { slotId });
      refreshBootstrap();
      status.refresh();
    } catch (e) {
      setBootErr(String(e));
    } finally {
      setAction(null);
    }
  }

  if (!snap) {
    return (
      <div className="empty-pane">
        <h2>Connecting</h2>
        <p>Connecting to serving runtime…</p>
      </div>
    );
  }

  const { machine, metrics, residency, services, connected } = snap;
  const memPct = metrics.mem_total_gb ? (metrics.mem_used_gb / metrics.mem_total_gb) * 100 : 0;
  const warm = residency.slots.filter((s) => s.state === "running");

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Status</h1>
        <p className="pane-sub">Serving sidecars, warm models, and resources.</p>
      </div>

      <div className="pane-body">
        <div className="card">
          <div className="hero">
            <div>
              <div className="card-title">{connected ? "Serving runtime online" : "Serving runtime offline"}</div>
              <div className="card-sub">Start the Moraine trace stack; warm models on the Models pane.</div>
            </div>
            <button
              className={"connect-btn" + (connected ? " connected" : "")}
              disabled={busy}
              onClick={() => (connected ? disconnect() : connect())}
            >
              <span className={"dot" + (connected ? " running" : "")} />
              {busy ? "…" : connected ? "Disconnect" : "Connect"}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-row">
            <div className="card-title">This Mac</div>
            <div className="metric">
              {machine.chip} · {machine.memory_gb} GB
            </div>
          </div>
          <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
            <Metric label="CPU" value={`${metrics.cpu_pct.toFixed(0)}%`} pct={metrics.cpu_pct} />
            <Metric
              label="Memory"
              value={`${metrics.mem_used_gb.toFixed(1)} / ${metrics.mem_total_gb.toFixed(0)} GB`}
              pct={memPct}
            />
          </div>
        </div>

        <ResidencyPanel status={status} />

        {sidekickModel && (
          <div className={"card sidekick-lane-card" + (sidekickSlot?.state === "running" ? " active" : "")}>
            <div className="card-row" style={{ marginBottom: 10 }}>
              <div>
                <div className="card-title">Sidekick lane</div>
                <div className="card-sub">Small local helper for delegated read-only subtasks.</div>
              </div>
              <span className="metric">{sidekickSlot?.port ? `:${sidekickSlot.port}` : sidekickSlot?.state ?? "not warm"}</span>
            </div>
            <SetupRow
              title={sidekickModel.short_name ?? sidekickModel.id}
              detail={
                sidekickDownload
                  ? downloadDetail(sidekickDownload, `${sidekickModel.name} · ${sidekickModel.approx_gb} GB`, sidekickModel.incomplete)
                  : sidekickSlot
                    ? `${sidekickSlot.state} · ${sidekickModel.name} · ${sidekickModel.approx_gb} GB`
                    : downloadDetail(undefined, `${sidekickModel.cached ? "cached" : "not cached"} · ${sidekickModel.name} · ${sidekickModel.approx_gb} GB`, sidekickModel.incomplete)
              }
              done={sidekickSlot?.state === "running"}
              busy={action === "setup_sidekick" || sidekickDownload?.status === "running" || sidekickSlot?.state === "loading"}
              action={sidekickSlot?.state === "running" ? undefined : setupSidekick}
              actionLabel={sidekickModel.cached || sidekickSlot ? "Warm" : sidekickModel.incomplete || sidekickDownload?.resumable ? "Resume + warm" : "Download + warm"}
              busyAction={sidekickDownload?.status === "running" ? () => cancelDownload(sidekickDownload.id) : undefined}
              busyActionLabel="Pause"
              pct={sidekickDownload?.status === "running" ? downloadPct(sidekickDownload) : undefined}
            />
            <ToggleRow
              title="Parallel sidekick"
              detail="Default background lane for eligible read-only checks; main keeps judgment and final review."
              on={parallelSidekick}
              disabled={sidekickSlot?.state !== "running"}
              onToggle={() => setParallelLane(!parallelSidekick)}
            />
            {sidekickDecisions[0] && (
              <div className="sidekick-policy-row">
                <span className={"dot " + (sidekickDecisions[0].eligible ? "running" : "stopped")} />
                <div>
                  <div className="svc-name">
                    Policy · {sidekickDecisions[0].eligible ? "delegated" : "kept main"}
                  </div>
                  <div className="svc-desc">
                    {sidekickDecisions[0].reason} · {sidekickDecisions[0].prompt_excerpt}
                  </div>
                </div>
              </div>
            )}
            {sidekickEvents.length > 0 && (
              <div className="sidekick-event-list">
                {sidekickEvents.map((event) => (
                  <div className="sidekick-event" key={event.id}>
                    <span className={"dot " + (event.stage === "finished" ? "running" : event.stage === "error" ? "stopped" : "loading")} />
                    <div>
                      <div className="svc-name">{event.mode} · {event.stage}</div>
                      <div className="svc-desc">{event.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {sidekickMetrics && sidekickMetrics.rows > 0 && (
              <div className="sidekick-policy-row">
                <span className="dot running" />
                <div>
                  <div className="svc-name">Metrics · {sidekickMetrics.rows} recent runs</div>
                  <div className="svc-desc">
                    {sidekickMetrics.handoff_rate == null ? "—" : `${Math.round(sidekickMetrics.handoff_rate * 100)}%`} handed off ·{" "}
                    {sidekickMetrics.useful_rate == null ? "no feedback" : `${Math.round(sidekickMetrics.useful_rate * 100)}% useful`} ·{" "}
                    {sidekickMetrics.escalation_rate == null ? "—" : `${Math.round(sidekickMetrics.escalation_rate * 100)}%`} escalated ·{" "}
                    {sidekickMetrics.avg_elapsed_ms == null ? "—" : `${(sidekickMetrics.avg_elapsed_ms / 1000).toFixed(1)}s`} avg ·{" "}
                    {sidekickMetrics.avg_tool_calls == null ? "—" : `${sidekickMetrics.avg_tool_calls.toFixed(1)}`} tools
                  </div>
                </div>
              </div>
            )}
            {sidekickRuns.length > 0 && (
              <div className="sidekick-run-list">
                {sidekickRuns.map((run, index) => (
                  <div className="sidekick-run" key={`${run.run_at}-${index}`}>
                    <div>
                      <div className="svc-name">
                        {run.mode}
                        {run.mode === "parallel" ? run.consumed ? " · handed off" : " · queued" : ""}
                        {run.escalated ? " · escalated" : ""}
                      </div>
                      <div className="svc-desc">{run.task}</div>
                    </div>
                    <div className="sidekick-run-meta">
                      <span className="svc-state">
                        {run.elapsed_ms ? `${(run.elapsed_ms / 1000).toFixed(1)}s` : "—"} · {run.tool_calls} tools
                        {run.accepted === true ? " · useful" : run.accepted === false ? " · miss" : ""}
                      </span>
                      <div className="run-feedback" aria-label="Sidekick run feedback">
                        <button
                          className={"mini-btn" + (run.accepted === true ? " active" : "")}
                          onClick={() => markSidekickRun(run.id, run.accepted === true ? null : true)}
                        >
                          Use
                        </button>
                        <button
                          className={"mini-btn" + (run.accepted === false ? " active" : "")}
                          onClick={() => markSidekickRun(run.id, run.accepted === false ? null : false)}
                        >
                          Miss
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {bootstrap && (
          <div className="card">
            <div className="card-row" style={{ marginBottom: 10 }}>
              <div>
                <div className="card-title">First-run setup</div>
                <div className="card-sub">Install the local tools, cache a model, then warm serving.</div>
              </div>
              <span className="metric">{bootstrap.models_dir}</span>
            </div>
            <SetupRow
              title="uv"
              detail={bootstrap.uv.installed ? bootstrap.uv.detail : "Required for JIT Python tool installs."}
              done={bootstrap.uv.installed}
              busy={action === "install_uv"}
              action={bootstrap.uv.installed ? undefined : () => runInstall("install_uv")}
              actionLabel="Install"
            />
            <SetupRow
              title="Understudy agent tools"
              detail={
                bootstrap.understudy.installed
                  ? bootstrap.understudy.detail || bootstrap.understudy.command
                  : "Installs the understudy CLI and public agent skills."
              }
              done={bootstrap.understudy.installed && !bootstrap.understudy.update_available}
              busy={action === "install_understudy_agent_tools"}
              action={bootstrap.understudy.installed && !bootstrap.understudy.update_available ? undefined : () => runInstall("install_understudy_agent_tools")}
              actionLabel={bootstrap.understudy.update_available ? "Update" : "Install"}
            />
            <SetupRow
              title="Moraine traces"
              detail={bootstrap.moraine.installed ? bootstrap.moraine.detail || bootstrap.moraine.command : "Trace search and MCP context."}
              done={bootstrap.moraine.installed}
              busy={action === "install_moraine"}
              action={bootstrap.moraine.installed ? undefined : () => runInstall("install_moraine")}
              actionLabel="Install"
            />
            <SetupRow
              title="MLX serving"
              detail={bootstrap.mlx.installed ? bootstrap.mlx.detail : "Installs mlx-vlm for mlx_vlm.server."}
              done={bootstrap.mlx.installed}
              busy={action === "install_mlx_runtime"}
              action={bootstrap.mlx.installed ? undefined : () => runInstall("install_mlx_runtime")}
              actionLabel="Install"
            />
            {model && (
              <SetupRow
                title={model.short_name ?? model.id}
                detail={
                  downloadDetail(defaultDownload, `${model.name} · ${model.approx_gb} GB`, model.incomplete)
                }
                done={model.cached}
                busy={defaultDownload?.status === "running"}
                action={model.cached ? undefined : () => downloadModel(model.id)}
                actionLabel={model.incomplete || defaultDownload?.resumable ? "Resume" : "Download"}
                busyAction={defaultDownload?.status === "running" ? () => cancelDownload(defaultDownload.id) : undefined}
                busyActionLabel="Pause"
                pct={defaultDownload?.status === "running" ? downloadPct(defaultDownload) : undefined}
              />
            )}
            <SetupRow
              title="Understudy account"
              detail={bootstrap.account_connected ? "Cloud/gateway credentials are available." : "Optional cloud fallback needs Account login."}
              done={bootstrap.account_connected}
            />
            {bootErr && <div className="error-text" style={{ marginTop: 12 }}>{bootErr}</div>}
          </div>
        )}

        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>Services</div>
          {services.map((s) => <ServiceRow key={s.id} svc={s} />)}
        </div>
      </div>
    </>
  );
}

function SetupRow({
  title,
  detail,
  done,
  busy,
  action,
  actionLabel,
  busyAction,
  busyActionLabel,
  pct,
}: {
  title: string;
  detail: string;
  done: boolean;
  busy?: boolean;
  action?: () => void;
  actionLabel?: string;
  busyAction?: () => void;
  busyActionLabel?: string;
  pct?: number | null;
}) {
  return (
    <div className="svc">
      <span className={"dot " + (done ? "running" : busy ? "loading" : "stopped")} />
      <div>
        <div className="svc-name">{title}</div>
        <div className="svc-desc">{detail}</div>
        {pct != null && (
          <div className="meter" style={{ marginTop: 8 }}>
            <i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
          </div>
        )}
      </div>
      {action ? (
        <button
          className="mini-btn"
          disabled={busy && !busyAction}
          onClick={busy && busyAction ? busyAction : action}
        >
          {busy ? busyActionLabel ?? "…" : actionLabel}
        </button>
      ) : (
        <span className="svc-state">{done ? "ready" : "pending"}</span>
      )}
    </div>
  );
}

function ToggleRow({
  title,
  detail,
  on,
  disabled,
  onToggle,
}: {
  title: string;
  detail: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={"svc" + (disabled ? " muted" : "")}>
      <span className={"dot " + (on ? "running" : "stopped")} />
      <div>
        <div className="svc-name">{title}</div>
        <div className="svc-desc">{detail}</div>
      </div>
      <button
        className={"toggle-pill" + (on ? " on" : "")}
        disabled={disabled}
        onClick={onToggle}
        type="button"
      >
        {on ? "On" : "Off"}
      </button>
    </div>
  );
}

function Metric({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div>
      <div className="card-row">
        <span style={{ color: "var(--text-2)", fontSize: 12 }}>{label}</span>
        <span className="metric">{value}</span>
      </div>
      <div className="meter">
        <i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
    </div>
  );
}

function SlotRow({ slot }: { slot: SlotView }) {
  return (
    <div className="svc">
      <span className={"dot " + slot.state} />
      <div>
        <div className="svc-name">{slot.model_id}</div>
        <div className="svc-desc">
          :{slot.port} · {slot.mem_gb.toFixed(1)} GB
          {slot.load_ms ? ` · loaded ${(slot.load_ms / 1000).toFixed(1)}s` : ""}
        </div>
      </div>
      <span className="svc-state">{slot.state}</span>
    </div>
  );
}

function ServiceRow({ svc }: { svc: ServiceState }) {
  return (
    <div className="svc">
      <span className={"dot " + svc.state} />
      <div>
        <div className="svc-name">{svc.name}</div>
        <div className="svc-desc">{svc.desc}</div>
      </div>
      <span className="svc-state">{svc.state}</span>
    </div>
  );
}
