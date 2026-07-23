"use client";

// Reusable workload configuration form — the Configuration pane's controls
// (route editor + capture toggle) extracted so the Workloads pane can fold
// them into each workload card. Same data path as the old pane: loads via
// the `workload_config_load` Tauri command and mutates through
// `workload_routing_apply` / `workload_capture_set` (credentials stay
// native-side). WorkloadConfigPane wraps this for the deep-linkable
// "workload-config" pane id.

import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Button } from "@/app/components/base-ui/button";
import { Input } from "@/app/components/base-ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/base-ui/select";
import { Spinner } from "@/app/components/base-ui/spinner";
import {
  PRIMARY,
  afterSaveLabel,
  deriveOverrideState,
  initialTrafficPct,
  planRollback,
  planRouteSave,
  validateTrafficPct,
  type WorkloadRecord,
} from "../lib/workload-config.mjs";

type SupportedModel = { id: string; display_name: string };

export type WorkloadConfigData = {
  workload: WorkloadRecord;
  models: SupportedModel[];
  health: string;
};

export function WorkloadConfigInline({
  projectId,
  workloadId,
  onChanged,
}: {
  projectId: string;
  workloadId: string;
  /** Fires after any successful mutation so hosts can refresh their view. */
  onChanged?: () => void;
}) {
  const [data, setData] = useState<WorkloadConfigData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isTauri()) {
      setLoadError("workload configuration is only available in the desktop app");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const result = await invoke<WorkloadConfigData>("workload_config_load", {
        projectId,
        workloadId,
      });
      setData(result);
    } catch (error) {
      setData(null);
      setLoadError(String(error));
    } finally {
      setLoading(false);
    }
  }, [projectId, workloadId]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const saved = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  if (loadError) {
    return (
      <div className="sm-config">
        <p role="alert" className="sm-config-err">{loadError}</p>
        <div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="sm-config">
        <span className="sm-config-note" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Spinner className="size-3.5" /> loading configuration…
        </span>
      </div>
    );
  }

  const { workload, models } = data;

  return (
    <div className="sm-config">
      <CurrentState workload={workload} />
      <RouteEditor
        key={`${workload.id}:${workload.route_model_id ?? ""}:${workload.route_traffic_pct}`}
        projectId={projectId}
        workload={workload}
        models={models}
        onSaved={saved}
      />
      <CaptureControl
        projectId={projectId}
        workload={workload}
        onSaved={saved}
        pendingBlocked={loading}
      />
    </div>
  );
}

function CurrentState({ workload }: { workload: WorkloadRecord }) {
  const state = deriveOverrideState(workload);
  return (
    <div className="sm-config-section">
      <span className="sm-cap">now</span>
      <p className="sm-config-line">
        {state.kind === "primary" ? (
          <span className="sm-config-dim">primary — the model your code sends</span>
        ) : state.kind === "hold" ? (
          <>
            <code>{state.modelId}</code> held @ 0% — serving primary
          </>
        ) : state.kind === "split" ? (
          <>
            split — <code>{state.modelId}</code> @{" "}
            <span className="tabular-nums">{state.trafficPct}%</span> · primary @{" "}
            <span className="tabular-nums">{100 - state.trafficPct}%</span>
          </>
        ) : (
          <>
            override — <code>{state.modelId}</code> @ 100%
          </>
        )}
      </p>
      <p className="sm-config-line">
        <span className="sm-config-dim">capture </span>
        {workload.capture_enabled ? (
          <>
            on ·{" "}
            <span className="tabular-nums">
              {Math.round(workload.capture_sample_rate * 100)}%
            </span>{" "}
            sampled
          </>
        ) : (
          <span className="sm-config-dim">off</span>
        )}
      </p>
    </div>
  );
}

function RouteEditor({
  projectId,
  workload,
  models,
  onSaved,
}: {
  projectId: string;
  workload: WorkloadRecord;
  models: SupportedModel[];
  onSaved: () => Promise<void> | void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const routed = workload.route_model_id !== null;
  const [selectedModel, setSelectedModel] = useState<string>(
    workload.route_model_id ?? PRIMARY,
  );
  // New routes default to a full cutover (100%); match the route endpoint's
  // own default rather than the D1 column default of 5.
  const [trafficPct, setTrafficPct] = useState<string>(
    String(initialTrafficPct(workload)),
  );

  const targetIsPrimary = selectedModel === PRIMARY;
  const pctResult = validateTrafficPct(trafficPct);
  const parsedPct = pctResult.ok ? pctResult.pct : NaN;

  const plan = planRouteSave({ workload, selectedModel, trafficPct });
  const canSave = plan.ok && plan.dirty && !pending;

  const apply = async (body: Record<string, unknown>, resetToPrimary: boolean) => {
    setError(null);
    setPending(true);
    try {
      await invoke("workload_routing_apply", {
        projectId,
        workloadId: workload.id,
        body,
      });
      if (resetToPrimary) setSelectedModel(PRIMARY);
      await onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  };

  const save = () => {
    if (!plan.ok) {
      setError(plan.error);
      return;
    }
    if (!plan.dirty) return;
    void apply(plan.body, false);
  };

  const rollBack = () => {
    void apply(planRollback(), true);
  };

  return (
    <div className="sm-config-section">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="sm-cap">route</span>
        <span className="sm-spacer" />
        <span className="sm-chip">{routed ? "configured" : "primary"}</span>
      </div>
      <div className="sm-config-grid">
        <div className="grid gap-2">
          <label className="sm-cap">model</label>
          <Select
            value={selectedModel}
            onValueChange={(value) => {
              setSelectedModel(value);
              setError(null);
              if (value !== PRIMARY && !workload.route_model_id) {
                setTrafficPct("100");
              }
            }}
            disabled={pending}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PRIMARY}>primary (no override)</SelectItem>
              {models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <label className="sm-cap">traffic to this route</label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={100}
              step={1}
              inputMode="numeric"
              value={trafficPct}
              onChange={(event) => setTrafficPct(event.target.value)}
              disabled={pending || targetIsPrimary}
              aria-label="Traffic percentage"
              aria-invalid={!targetIsPrimary && !pctResult.ok}
              className="tabular-nums"
            />
            <span className="sm-config-note" style={{ whiteSpace: "nowrap" }}>
              % · 0 primary-only · 100 full override
            </span>
          </div>
        </div>
      </div>

      <div>
        <span className="sm-cap">after save</span>
        <p className="sm-config-line">
          {targetIsPrimary
            ? "primary — the model your code sends"
            : afterSaveLabel(selectedModel, pctResult.ok ? parsedPct : 100)}
        </p>
        {!targetIsPrimary && pctResult.ok && parsedPct > 0 && parsedPct < 100 ? (
          <p className="sm-config-note">
            retries land on the same arm (deterministic by request id)
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={save} disabled={!canSave}>
          {pending ? "Saving" : "Save route"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={rollBack}
          disabled={pending || (!routed && targetIsPrimary)}
        >
          Roll back to primary
        </Button>
      </div>
      {error ? (
        <p role="alert" className="sm-config-err">{error}</p>
      ) : null}
    </div>
  );
}

function CaptureControl({
  projectId,
  workload,
  onSaved,
  pendingBlocked,
}: {
  projectId: string;
  workload: WorkloadRecord;
  onSaved: () => Promise<void> | void;
  pendingBlocked: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = workload.capture_enabled;

  const toggle = async () => {
    setError(null);
    setPending(true);
    try {
      await invoke("workload_capture_set", {
        projectId,
        workloadId: workload.id,
        captureEnabled: !enabled,
      });
      await onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="sm-config-section">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 4 }}>
          <span className="sm-cap">capture</span>
          <p className="sm-config-note">
            record this workload&apos;s traffic for training and evals ·{" "}
            <span className="tabular-nums">
              {Math.round(workload.capture_sample_rate * 100)}%
            </span>{" "}
            sample rate when on
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={pending || pendingBlocked}
          onClick={() => void toggle()}
          className={`inline-flex h-7 w-16 items-center border border-[var(--color-rule)] p-1 text-[0.62rem] font-medium uppercase tracking-[0.12em] transition-colors disabled:opacity-50 ${
            enabled
              ? "justify-end bg-[color-mix(in_srgb,var(--color-card)_72%,var(--model-mint)_28%)] text-[var(--color-ink)]"
              : "justify-start bg-[var(--color-card)] text-[var(--color-ink-muted)]"
          }`}
        >
          {pending ? "..." : enabled ? "on" : "off"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="sm-config-err">{error}</p>
      ) : null}
    </div>
  );
}
