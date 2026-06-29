"use client";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StatusController, SlotView } from "../lib/useStatus";
import { modelShortName, type SnapshotAlias } from "../lib/model-aliases";

type ModelInfo = { id: string; path: string; size_gb: number };

/** Warm-slot residency manager. Lives in Status; controls the local model fleet. */
export function ResidencyPanel({ status }: { status: StatusController }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotAlias[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const res = status.snap?.residency;

  useEffect(() => {
    invoke<ModelInfo[]>("list_models").then(setModels).catch((e) => setErr(String(e)));
    invoke<SnapshotAlias[]>("list_snapshot_models").then(setSnapshots).catch(() => {});
  }, []);

  const usedPct = res && res.usable_gb > 0 ? (res.used_gb / res.usable_gb) * 100 : 0;
  const call = async (fn: string, args?: Record<string, unknown>) => {
    setErr(null);
    try {
      await invoke(fn, args);
    } catch (e) {
      setErr(String(e));
    }
  };

  if (!res) return null;
  return (
    <div className="card">
      <div className="card-row" style={{ marginBottom: 8 }}>
        <div className="card-title">Residency · warm slots</div>
        <button className="btn" onClick={() => call("add_slot")}>+ Add slot</button>
      </div>
      <div className="card-row">
        <span style={{ color: "var(--color-ink-muted)", fontSize: 12 }}>Model memory</span>
        <span className="metric">
          {res.used_gb.toFixed(1)} / {res.usable_gb.toFixed(0)} GB
        </span>
      </div>
      <div className="meter" style={{ margin: "8px 0 12px" }}>
        <i style={{ width: `${Math.min(100, usedPct)}%` }} />
      </div>

      {err && <div className="chat-err" style={{ marginBottom: 8 }}>{err}</div>}

      {res.slots.length > 0 ? (
        <div className="model-list">
          {res.slots.map((s) => (
            <SlotCard key={s.id} slot={s} models={models} snapshots={snapshots} call={call} />
          ))}
        </div>
      ) : (
        <div className="card-sub">No slots — add one and assign a model to serve it locally.</div>
      )}
    </div>
  );
}

function SlotCard({
  slot,
  models,
  snapshots,
  call,
}: {
  slot: SlotView;
  models: ModelInfo[] | null;
  snapshots: SnapshotAlias[];
  call: (fn: string, args?: Record<string, unknown>) => Promise<void>;
}) {
  const isWarm = slot.state === "running";
  const isLoading = slot.state === "loading";
  return (
    <div className="model-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 8, padding: "12px 0" }}>
      <div style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span className={"dot " + slot.state} />
          <div>
            <div className="model-id">{modelShortName(slot.model_id, snapshots) ?? "Empty slot"}</div>
            <div className="metric model-size">
              {slot.model_id
                ? `${slot.model_id} · ${slot.mem_gb.toFixed(1)} GB${slot.port ? ` · :${slot.port}` : ""}${slot.load_ms ? ` · loaded ${(slot.load_ms / 1000).toFixed(1)}s` : ""}`
                : "unassigned"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {slot.model_id && (
            <button
              className={"btn" + (isWarm ? " ghost" : " primary")}
              disabled={isLoading}
              onClick={() => call(isWarm ? "cool_slot" : "warm_slot", { slotId: slot.id })}
            >
              {isLoading ? "Warming…" : isWarm ? "Cool" : "Warm"}
            </button>
          )}
          <button className="btn ghost" onClick={() => call("remove_slot", { slotId: slot.id })}>Remove</button>
        </div>
      </div>
      <select
        className="assign-select"
        value={slot.model_id ?? ""}
        onChange={(e) => e.target.value && call("assign_slot", { slotId: slot.id, modelId: e.target.value })}
      >
        <option value="" disabled>{slot.model_id ? "Change model…" : "Assign a model…"}</option>
        {models?.map((m) => (
          <option key={m.id} value={m.id}>{modelShortName(m.id, snapshots)} ({m.size_gb.toFixed(1)} GB)</option>
        ))}
      </select>
    </div>
  );
}
