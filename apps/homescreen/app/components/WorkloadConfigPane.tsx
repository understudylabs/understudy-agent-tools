"use client";

import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Badge } from "@/app/components/base-ui/badge";
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
import type { Scope } from "../lib/nav";
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
import {
  WorkloadHealthBadge,
  type WorkloadHealthStatus,
} from "./WorkloadHealthBadge";

type SupportedModel = { id: string; display_name: string };

type ConfigData = {
  workload: WorkloadRecord;
  models: SupportedModel[];
  health: string;
};

/**
 * Workload Configuration — the production-enabling action, ported from
 * apps/web .../workloads/[workload_id]/WorkloadConfigClient.tsx. Choose an
 * Understudy catalog model + traffic %, save (full or split override), or
 * roll back to primary. Capture is a separate toggle. The web server
 * actions become the `workload_routing_apply` / `workload_capture_set`
 * Tauri commands (credentials stay native-side).
 */
export function WorkloadConfigPane({ scope }: { scope: Scope }) {
  const [data, setData] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!scope.projectId || !scope.workloadId) return;
    if (!isTauri()) {
      setLoadError("Workload configuration is only available in the desktop app.");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const result = await invoke<ConfigData>("workload_config_load", {
        projectId: scope.projectId,
        workloadId: scope.workloadId,
      });
      setData(result);
    } catch (error) {
      setData(null);
      setLoadError(String(error));
    } finally {
      setLoading(false);
    }
  }, [scope.projectId, scope.workloadId]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  if (!scope.projectId || !scope.workloadId) {
    return (
      <>
        <PaneHead title="Configuration" sub="Route and capture for a workload." />
        <div className="pane-body">
          <div className="card">
            <div className="card-sub">
              Select a workload in the sidebar to configure its route and capture.
            </div>
          </div>
        </div>
      </>
    );
  }

  if (loadError) {
    return (
      <>
        <PaneHead title="Configuration" sub="Workload configuration could not be loaded." />
        <div className="pane-body">
          <div className="card">
            <div className="chat-err" role="alert">{loadError}</div>
            <div style={{ marginTop: 10 }}>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PaneHead title="Configuration" sub="Route and capture for this workload." />
        <div className="pane-body">
          <div className="card">
            <div className="card-sub" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Spinner className="size-3.5" /> Loading workload…
            </div>
          </div>
        </div>
      </>
    );
  }

  const { workload, models } = data;

  return (
    <>
      <PaneHead
        title={`${workload.name} · Configuration`}
        sub="Route and capture for this workload. Set an override to send it to production, or roll back to primary at any time."
        action={<WorkloadHealthBadge status={data.health as WorkloadHealthStatus} />}
      />
      <div className="pane-body">
        <CurrentStateCard workload={workload} />
        <RouteEditor
          key={`${workload.id}:${workload.route_model_id ?? ""}:${workload.route_traffic_pct}`}
          projectId={scope.projectId}
          workload={workload}
          models={models}
          onSaved={load}
        />
        <CaptureCard
          projectId={scope.projectId}
          workload={workload}
          onSaved={load}
          pendingBlocked={loading}
        />
      </div>
    </>
  );
}

function PaneHead({
  title,
  sub,
  action,
}: {
  title: string;
  sub: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="pane-head" style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 className="pane-title">{title}</h1>
        <p className="pane-sub">{sub}</p>
      </div>
      {action}
    </div>
  );
}

function CurrentStateCard({ workload }: { workload: WorkloadRecord }) {
  const state = deriveOverrideState(workload);
  return (
    <div className="card">
      <div className="card-title">Now</div>
      <div className="card-sub" style={{ marginBottom: 10 }}>
        The configured route and capture for this workload. Until you set a
        route, it rides the primary route — the model your code sends.
      </div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <div className="rounded-md border border-[var(--color-rule)] bg-[var(--color-card)] p-3">
          <p className="text-[0.62rem] font-medium uppercase tracking-[0.16em] text-[var(--color-ink-muted)]">
            route
          </p>
          <p className="mt-2 text-sm">
            {state.kind === "primary" ? (
              <span className="text-[var(--color-ink-muted)]">
                primary — the model your code sends
              </span>
            ) : state.kind === "hold" ? (
              <>
                <code className="font-mono">{state.modelId}</code> held @ 0% — serving primary
              </>
            ) : state.kind === "split" ? (
              <>
                split — <code className="font-mono">{state.modelId}</code> @{" "}
                <span className="tabular-nums">{state.trafficPct}%</span> · primary @{" "}
                <span className="tabular-nums">{100 - state.trafficPct}%</span>
              </>
            ) : (
              <>
                override — <code className="font-mono">{state.modelId}</code> @ 100%
              </>
            )}
          </p>
        </div>
        <div className="rounded-md border border-[var(--color-rule)] bg-[var(--color-card)] p-3">
          <p className="text-[0.62rem] font-medium uppercase tracking-[0.16em] text-[var(--color-ink-muted)]">
            capture
          </p>
          <p className="mt-2 text-sm">
            {workload.capture_enabled ? (
              <>
                on ·{" "}
                <span className="tabular-nums">
                  {Math.round(workload.capture_sample_rate * 100)}%
                </span>{" "}
                sampled
              </>
            ) : (
              <span className="text-[var(--color-ink-muted)]">off</span>
            )}
          </p>
        </div>
      </div>
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
    <div className="card">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card-title">Route</div>
          <div className="card-sub" style={{ marginBottom: 12 }}>
            Split or override the primary route with an Understudy-served model.
            A full override (100%) is the go-to-production move; a split ramps a
            slice while the rest stays on your provider.
          </div>
        </div>
        <Badge variant="outline" className="uppercase tracking-[0.14em]">
          {routed ? "configured" : "primary"}
        </Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(12rem,1fr)_minmax(10rem,1fr)] sm:items-end">
        <div className="grid gap-2">
          <label className="text-[0.62rem] font-medium uppercase tracking-[0.16em] text-[var(--color-ink-muted)]">
            model
          </label>
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
          <label className="text-[0.62rem] font-medium uppercase tracking-[0.16em] text-[var(--color-ink-muted)]">
            traffic to this route
          </label>
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
            <span className="whitespace-nowrap text-xs text-[var(--color-ink-muted)]">
              % · 0 primary-only · 100 full override
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-md border border-[var(--color-rule)] bg-[var(--color-card)] p-3 text-sm">
        <p className="text-[0.62rem] font-medium uppercase tracking-[0.16em] text-[var(--color-ink-muted)]">
          after save
        </p>
        <p className="mt-1.5">
          {targetIsPrimary
            ? "primary — the model your code sends"
            : afterSaveLabel(selectedModel, pctResult.ok ? parsedPct : 100)}
        </p>
        {!targetIsPrimary && pctResult.ok && parsedPct > 0 && parsedPct < 100 ? (
          <p className="mt-1 text-xs leading-5 text-[var(--color-ink-muted)]">
            Retries land on the same arm (deterministic by request id).
          </p>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} disabled={!canSave}>
          {pending ? "Saving" : "Save route"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={rollBack}
          disabled={pending || (!routed && targetIsPrimary)}
        >
          Roll back to primary
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-[var(--color-bad)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CaptureCard({
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
    <div className="card">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card-title">Capture</div>
          <div className="card-sub">
            Record this workload&apos;s traffic for training and evals. Capturing
            at{" "}
            <span className="tabular-nums">
              {Math.round(workload.capture_sample_rate * 100)}%
            </span>{" "}
            sample rate when on. New workloads start on at 100%.
          </div>
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
        <p role="alert" className="mt-3 text-sm text-[var(--color-bad)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
