"use client";
import type { StatusController, ServiceState, SlotView } from "../lib/useStatus";
import { ResidencyPanel } from "./ResidencyPanel";

export function StatusPane({ status }: { status: StatusController }) {
  const { snap, busy, connect, disconnect } = status;

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

        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>Services</div>
          {services.map((s) => <ServiceRow key={s.id} svc={s} />)}
        </div>
      </div>
    </>
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
