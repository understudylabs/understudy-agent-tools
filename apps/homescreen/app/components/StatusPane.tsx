"use client";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { StatusController, ServiceState, SlotView } from "../lib/useStatus";
import { ResidencyPanel } from "./ResidencyPanel";

type ToolStatus = {
  id: string;
  label: string;
  installed: boolean;
  command: string;
  detail: string;
};

type SnapshotModel = {
  id: string;
  short_name?: string | null;
  name: string;
  approx_gb: number;
  cached: boolean;
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

type DownloadEvent =
  | { type: "Log"; message: string }
  | { type: "File"; name: string; downloaded: number; total?: number | null }
  | { type: "Done"; dest: string; files: number }
  | { type: "Error"; message: string };

export function StatusPane({ status }: { status: StatusController }) {
  const { snap, busy, connect, disconnect } = status;
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [download, setDownload] = useState<{ model: string; label: string; pct: number | null } | null>(null);
  const [bootErr, setBootErr] = useState<string | null>(null);

  const refreshBootstrap = () => {
    invoke<BootstrapStatus>("bootstrap_status")
      .then((next) => {
        setBootstrap(next);
        setBootErr(null);
      })
      .catch((e) => setBootErr(String(e)));
  };

  useEffect(() => {
    refreshBootstrap();
    const timer = setInterval(refreshBootstrap, 5000);
    return () => clearInterval(timer);
  }, []);

  const model = useMemo(() => {
    const rows = bootstrap?.snapshots ?? [];
    return (
      rows.find((row) => row.id.endsWith("-understudy") && row.default_rung) ??
      rows.find((row) => row.id.endsWith("-understudy")) ??
      rows[0]
    );
  }, [bootstrap]);

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

  async function downloadModel(modelId: string) {
    const ch = new Channel<DownloadEvent>();
    setDownload({ model: modelId, label: "Starting download", pct: null });
    setBootErr(null);
    ch.onmessage = (msg) => {
      if (msg.type === "Log") setDownload((prev) => prev && { ...prev, label: msg.message });
      if (msg.type === "File") {
        const pct = msg.total ? (msg.downloaded / msg.total) * 100 : null;
        setDownload({ model: modelId, label: msg.name, pct });
      }
      if (msg.type === "Done") {
        setDownload({ model: modelId, label: `Downloaded ${msg.files} files`, pct: 100 });
        refreshBootstrap();
        status.refresh();
        setTimeout(() => setDownload(null), 1800);
      }
      if (msg.type === "Error") {
        setBootErr(msg.message);
        setDownload(null);
      }
    };
    try {
      await invoke("download_snapshot_model", { modelId, onEvent: ch });
    } catch (e) {
      setBootErr(String(e));
      setDownload(null);
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
              done={bootstrap.understudy.installed}
              busy={action === "install_understudy_agent_tools"}
              action={bootstrap.understudy.installed ? undefined : () => runInstall("install_understudy_agent_tools")}
              actionLabel="Install"
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
                  download?.model === model.id
                    ? `${download.label}${download.pct == null ? "" : ` · ${download.pct.toFixed(0)}%`}`
                    : `${model.name} · ${model.approx_gb} GB`
                }
                done={model.cached}
                busy={download?.model === model.id}
                action={model.cached ? undefined : () => downloadModel(model.id)}
                actionLabel="Download"
                pct={download?.model === model.id ? download.pct : undefined}
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
  pct,
}: {
  title: string;
  detail: string;
  done: boolean;
  busy?: boolean;
  action?: () => void;
  actionLabel?: string;
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
        <button className="mini-btn" disabled={busy} onClick={action}>
          {busy ? "…" : actionLabel}
        </button>
      ) : (
        <span className="svc-state">{done ? "ready" : "pending"}</span>
      )}
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
