"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { TrainingHaloVisual } from "./TrainingHalo";

export type RemoteTrainingProvider = {
  id: "fake" | "fireworks";
  enabled: boolean;
  label: string;
  base_models: string[];
};

export type RemoteTrainingCapabilities = {
  schema_version: "understudy-train-v1";
  service: "train.understudylabs.com";
  providers: RemoteTrainingProvider[];
  limits: {
    max_active_runs_per_org: 1;
    max_upload_bytes: number;
    max_budget_usd: number;
  };
  privacy: {
    private_uploads: true;
    raw_rows_in_telemetry: false;
    provider_upload_requires_explicit_consent: true;
  };
};

type RemoteArtifact = {
  artifact_role: "train" | "validation" | "heldout";
  file_name: string;
  row_count: number;
  sha256: string;
  size_bytes: number;
};

type RemotePlan = {
  schema_version: "understudy.remote_training.plan.v1";
  plan_id: string;
  provider: "fake" | "fireworks";
  base_model: string;
  frontier_model: string;
  output_model_name: string;
  artifacts: RemoteArtifact[];
  epochs: number;
  maximum_spend_usd: number;
  maximum_runtime_seconds: number;
  plan_path: string;
};

type RemoteRunReceipt = {
  schema_version: "understudy.remote_training.run.v1";
  run_id: string;
  run_manifest_path: string;
};

type RemoteTrainingEvent = {
  schema_version?: "understudy-train-v1";
  sequence?: number;
  type?: string;
  phase: "queued" | "upload" | "training" | "evaluation" | "deployment" | "cleanup" | "terminal" | string;
  message: string;
  progress?: {
    completed: number;
    total: number;
    unit: "steps" | "epochs" | "examples" | "seconds";
  };
  eve?: {
    decision: "observe" | "retry" | "wait" | "ask_user" | "stop";
    reason_code: string;
  };
};

type HumanMetric = {
  id: "correct_answers" | "coverage_across_categories" | "improvement_over_base" | "frontier_gap" | "speed";
  label: string;
  value: number;
  display_value: string;
  explanation: string;
};

type RemoteResult = {
  outcome: "promoted" | "needs_work" | "failed" | "cancelled";
  provider: "fake" | "fireworks";
  output_model?: string;
  endpoint?: string;
  spend_usd: number;
  metrics: HumanMetric[];
  failures: { input_summary: string; expected: string; actual: string }[];
};

type RemotePoll = {
  schema_version: "understudy.remote_training.poll.v1";
  run_id: string;
  events: RemoteTrainingEvent[];
  status: {
    workflow_status: "pending" | "running" | "completed" | "failed" | "cancelled" | "paused";
    result?: RemoteResult;
  };
  run_manifest_path: string;
};

type UploadEvent = {
  type: "phase";
  phase: "preparing" | "uploading";
  current: number;
  total: number;
  message: string;
};

type Props = {
  datasetManifestPath: string;
  modelName: string;
  capabilities: RemoteTrainingCapabilities;
  onTrainLocal: () => void;
  onActiveChange: (active: boolean) => void;
  onVisualChange: (visual: TrainingHaloVisual | null) => void;
};

type Stage = "recovering" | "choice" | "preparing" | "confirm" | "starting" | "running" | "terminal" | "failed";

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function providerDefault(providers: RemoteTrainingProvider[]): RemoteTrainingProvider {
  return providers.find((provider) => provider.id === "fireworks") ?? providers[0];
}

function baseModelDefault(provider: RemoteTrainingProvider): string {
  return provider.base_models.find((model) => model.endsWith("/gemma-4-26b-a4b-it"))
    ?? provider.base_models.find((model) => model.includes("/gemma-4-"))
    ?? provider.base_models[0];
}

function modelLabel(model: string): string {
  return model.split("/").at(-1)?.replaceAll("-", " ") ?? model;
}

function visualPhase(phase: string): TrainingHaloVisual["phase"] {
  if (phase === "training") return "training";
  if (phase === "evaluation") return "evaluating";
  if (phase === "deployment" || phase === "cleanup") return "saving";
  return "preparing";
}

export function RemoteTrainingPanel({
  datasetManifestPath,
  modelName,
  capabilities,
  onTrainLocal,
  onActiveChange,
  onVisualChange,
}: Props) {
  const providers = useMemo(
    () => capabilities.providers.filter((provider) => provider.enabled && provider.base_models.length > 0),
    [capabilities.providers],
  );
  const [providerId, setProviderId] = useState<RemoteTrainingProvider["id"]>(() => providerDefault(providers).id);
  const [stage, setStage] = useState<Stage>("recovering");
  const [plan, setPlan] = useState<RemotePlan | null>(null);
  const [run, setRun] = useState<RemoteRunReceipt | null>(null);
  const [events, setEvents] = useState<RemoteTrainingEvent[]>([]);
  const [uploadEvent, setUploadEvent] = useState<UploadEvent | null>(null);
  const [result, setResult] = useState<RemoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmUpload, setConfirmUpload] = useState(false);
  const [confirmSpend, setConfirmSpend] = useState(false);
  const [confirmDeployment, setConfirmDeployment] = useState(false);
  const polling = useRef(false);
  const stopped = useRef(false);
  const provider = providers.find((candidate) => candidate.id === providerId) ?? providers[0];
  const baseModel = provider ? baseModelDefault(provider) : "";
  const active = stage === "preparing" || stage === "starting" || stage === "running";
  const latestEvent = events.at(-1);

  useEffect(() => {
    onActiveChange(active);
  }, [active, onActiveChange]);

  useEffect(() => {
    if (!active && !(stage === "terminal" && result?.outcome === "promoted")) {
      onVisualChange(null);
      return;
    }
    const eventPhase = latestEvent?.phase ?? (stage === "starting" ? "upload" : "queued");
    const epochProgress = latestEvent?.progress?.unit === "epochs" ? latestEvent.progress : null;
    const done = stage === "terminal" && result?.outcome === "promoted";
    onVisualChange({
      phase: done ? "completed" : visualPhase(eventPhase),
      epochs: Math.max(1, plan?.epochs ?? 3),
      completedEpochs: done
        ? Math.max(1, plan?.epochs ?? 3)
        : epochProgress
          ? Math.min(epochProgress.total, epochProgress.completed)
          : eventPhase === "evaluation" || eventPhase === "deployment" || eventPhase === "cleanup"
            ? Math.max(1, plan?.epochs ?? 3)
            : 0,
      stepFraction: null,
      modelId: plan?.output_model_name ?? `remote.${providerId}`,
      modelName,
      done,
    });
  }, [active, latestEvent, modelName, onVisualChange, plan, providerId, result, stage]);

  useEffect(() => () => {
    stopped.current = true;
    onActiveChange(false);
    onVisualChange(null);
  }, [onActiveChange, onVisualChange]);

  useEffect(() => {
    let cancelled = false;
    setStage("recovering");
    setPlan(null);
    setRun(null);
    setEvents([]);
    setUploadEvent(null);
    setResult(null);
    setError(null);
    setConfirmUpload(false);
    setConfirmSpend(false);
    setConfirmDeployment(false);
    stopped.current = false;
    void invoke<RemoteRunReceipt | null>("existing_remote_classification_training", {
      manifestPath: datasetManifestPath,
    })
      .then((receipt) => {
        if (cancelled) return;
        if (receipt) {
          setRun(receipt);
          setStage("running");
        } else {
          setStage("choice");
        }
      })
      .catch(() => {
        if (!cancelled) setStage("choice");
      });
    return () => {
      cancelled = true;
    };
  }, [datasetManifestPath]);

  const prepare = useCallback(() => {
    if (!provider || stage !== "choice") return;
    setStage("preparing");
    setError(null);
    const maximumSpend = Math.min(provider.id === "fake" ? 1 : 3, capabilities.limits.max_budget_usd);
    void invoke<RemotePlan>("prepare_remote_classification_training", {
      manifestPath: datasetManifestPath,
      provider: provider.id,
      baseModel,
      frontierModel: "glm-5.2",
      maximumSpendUsd: maximumSpend,
    })
      .then((prepared) => {
        setPlan(prepared);
        setStage("confirm");
      })
      .catch((cause) => {
        setError(String(cause));
        setStage("failed");
      });
  }, [baseModel, capabilities.limits.max_budget_usd, datasetManifestPath, provider, stage]);

  const poll = useCallback(async (receipt: RemoteRunReceipt) => {
    if (polling.current || stopped.current) return;
    polling.current = true;
    try {
      const update = await invoke<RemotePoll>("remote_training_poll", {
        runManifestPath: receipt.run_manifest_path,
      });
      if (update.events.length > 0) {
        setEvents((current) => [...current, ...update.events].slice(-100));
      }
      if (update.status.workflow_status === "completed" && update.status.result) {
        setResult(update.status.result);
        setStage("terminal");
      } else if (update.status.workflow_status === "failed" || update.status.workflow_status === "cancelled") {
        setResult(update.status.result ?? null);
        setError(update.status.workflow_status === "cancelled" ? "Remote training stopped safely." : "The remote workflow did not finish.");
        setStage(update.status.workflow_status === "cancelled" ? "terminal" : "failed");
      }
    } catch (cause) {
      setError(`Connection interrupted: ${String(cause)}. The durable job is still safe; retrying.`);
    } finally {
      polling.current = false;
    }
  }, []);

  useEffect(() => {
    if (stage !== "running" || !run) return;
    void poll(run);
    const timer = window.setInterval(() => void poll(run), 1_500);
    return () => window.clearInterval(timer);
  }, [poll, run, stage]);

  const start = () => {
    if (!plan || stage !== "confirm" || !confirmUpload || !confirmSpend || !confirmDeployment) return;
    setStage("starting");
    setError(null);
    setEvents([]);
    const channel = new Channel<UploadEvent>();
    channel.onmessage = setUploadEvent;
    void invoke<RemoteRunReceipt>("start_remote_classification_training", {
      planPath: plan.plan_path,
      confirmUpload,
      confirmSpend,
      confirmTemporaryDeployment: confirmDeployment,
      onEvent: channel,
    })
      .then((receipt) => {
        setRun(receipt);
        setUploadEvent(null);
        setStage("running");
      })
      .catch((cause) => {
        setError(String(cause));
        setStage("failed");
      });
  };

  const cancel = () => {
    if (!run) return;
    void invoke("cancel_remote_training", { runManifestPath: run.run_manifest_path })
      .then(() => setError("Stop requested. Eve is preserving cleanup before the run ends."))
      .catch((cause) => setError(String(cause)));
  };

  if (stage === "recovering") {
    return <div className="remote-training-state" aria-live="polite"><strong>Checking the last remote run</strong><small>Looking only at protected run evidence on this Mac.</small></div>;
  }

  if (stage === "choice") {
    return (
      <div className="remote-training-choice">
        <div>
          <span>Experimental cloud training</span>
          <strong>Train a larger model without tying up this Mac</strong>
          <small>Understudy prepares everything locally first. Nothing uploads until you review the exact artifacts and budget.</small>
        </div>
        {providers.length > 1 && (
          <label>
            <span>Provider</span>
            <select value={providerId} onChange={(event) => setProviderId(event.target.value as RemoteTrainingProvider["id"])}>
              {providers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </select>
          </label>
        )}
        {provider && <small>Selected model · {modelLabel(baseModel)}</small>}
        <div className="remote-training-actions">
          <button type="button" className="btn primary" onClick={prepare}>
            {provider?.id === "fake" ? "Try the no-spend cloud proof" : "Review remote training"}
          </button>
          <button type="button" className="btn ghost" onClick={onTrainLocal}>Train on this Mac</button>
        </div>
      </div>
    );
  }

  if (stage === "preparing") {
    return <div className="remote-training-state" aria-live="polite"><strong>Preparing locally</strong><small>Verifying split hashes and producing private upload artifacts. Nothing is leaving this Mac.</small></div>;
  }

  if (stage === "confirm" && plan) {
    const totalBytes = plan.artifacts.reduce((sum, artifact) => sum + artifact.size_bytes, 0);
    return (
      <div className="remote-training-confirm">
        <div className="remote-training-confirm-heading">
          <div><span>Ready for consent</span><strong>{plan.output_model_name}</strong></div>
          <small>{plan.artifacts.reduce((sum, artifact) => sum + artifact.row_count, 0).toLocaleString()} split rows · {bytes(totalBytes)}</small>
        </div>
        <div className="remote-training-artifacts">
          {plan.artifacts.map((artifact) => (
            <div key={artifact.artifact_role}>
              <strong>{artifact.artifact_role}</strong>
              <span>{artifact.row_count.toLocaleString()} rows · {bytes(artifact.size_bytes)}</span>
              <code>{artifact.sha256.slice(0, 12)}</code>
            </div>
          ))}
        </div>
        <div className="remote-training-consent">
          <label><input type="checkbox" checked={confirmUpload} onChange={(event) => setConfirmUpload(event.target.checked)} /><span>Upload only these three private split artifacts.</span></label>
          <label><input type="checkbox" checked={confirmSpend} onChange={(event) => setConfirmSpend(event.target.checked)} /><span>Train with {provider?.label}; stop when its reported estimate reaches ${plan.maximum_spend_usd.toFixed(2)}.</span></label>
          <label><input type="checkbox" checked={confirmDeployment} onChange={(event) => setConfirmDeployment(event.target.checked)} /><span>Create a temporary endpoint for held-out comparison, then always remove it.</span></label>
        </div>
        <div className="remote-training-actions">
          <button type="button" className="btn primary" disabled={!confirmUpload || !confirmSpend || !confirmDeployment} onClick={start}>Upload & train · max ${plan.maximum_spend_usd.toFixed(2)}</button>
          <button type="button" className="btn ghost" onClick={() => setStage("choice")}>Back</button>
        </div>
      </div>
    );
  }

  if (stage === "starting" || stage === "running") {
    const status = uploadEvent?.message ?? latestEvent?.message ?? "The durable training workflow is starting.";
    const progress = uploadEvent
      ? `${uploadEvent.current} of ${uploadEvent.total} approved artifacts`
      : latestEvent?.progress
        ? `${latestEvent.progress.completed} of ${latestEvent.progress.total} ${latestEvent.progress.unit}`
        : null;
    return (
      <div className="remote-training-running" aria-live="polite" aria-busy="true">
        <div>
          <span className="local-training-pulse" aria-hidden="true" />
          <div><strong>{latestEvent?.phase === "training" ? "Training remotely" : latestEvent?.phase === "evaluation" ? "Proving the model" : "Starting remote training"}</strong><small>{status}</small>{progress && <code>{progress}</code>}</div>
          {run && <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>}
        </div>
        {latestEvent?.eve && latestEvent.eve.decision !== "observe" && (
          <p>Eve chose to {latestEvent.eve.decision.replace("_", " ")} · {latestEvent.eve.reason_code}</p>
        )}
        {error && <p className="remote-training-warning">{error}</p>}
        <ol>
          {events.slice(-4).map((event, index) => <li key={`${event.sequence ?? index}:${event.type ?? event.phase}`}>{event.message}</li>)}
        </ol>
      </div>
    );
  }

  if (stage === "terminal" && result) {
    const terminalCopy = result.outcome === "promoted"
      ? { eyebrow: "Ready to use", title: "This model earned promotion" }
      : result.outcome === "needs_work"
        ? { eyebrow: "Review complete", title: "This model needs another pass" }
        : result.outcome === "cancelled"
          ? { eyebrow: "Stopped safely", title: "Remote training was cancelled" }
          : { eyebrow: "Run ended", title: "Remote training did not complete" };
    return (
      <div className={`remote-training-result ${result.outcome}`}>
        <div><span>{terminalCopy.eyebrow}</span><strong>{terminalCopy.title}</strong><small>Provider-reported training cost: ${result.spend_usd.toFixed(2)}</small></div>
        <div className="remote-training-metrics">
          {result.metrics.map((metric) => <article key={metric.id}><span>{metric.label}</span><strong>{metric.display_value}</strong><small>{metric.explanation}</small></article>)}
        </div>
        {result.failures.length > 0 && <div className="remote-training-failures"><strong>Where it still fails</strong>{result.failures.slice(0, 3).map((failure, index) => <p key={index}>{failure.expected} expected · {failure.actual} returned · {failure.input_summary}</p>)}</div>}
        {result.outcome === "promoted" && result.output_model && <div className="remote-training-endpoint"><span>Private trained model</span><code>{result.output_model}</code>{result.endpoint && <small>Serving is active through the authenticated Understudy endpoint.</small>}</div>}
        <div className="remote-training-actions"><button type="button" className="btn ghost" onClick={() => { setPlan(null); setRun(null); setEvents([]); setResult(null); setError(null); setStage("choice"); }}>Start another run</button></div>
      </div>
    );
  }

  return (
    <div className="remote-training-state failed" role="alert">
      <div><strong>Remote training did not start</strong><small>{error ?? "The local dataset is intact and no further work will run."}</small></div>
      <div className="remote-training-actions"><button type="button" className="btn primary" onClick={() => setStage("choice")}>Try again</button><button type="button" className="btn ghost" onClick={onTrainLocal}>Train on this Mac</button></div>
    </div>
  );
}
