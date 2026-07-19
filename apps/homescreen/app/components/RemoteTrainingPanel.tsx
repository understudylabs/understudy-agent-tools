"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { TrainingHaloVisual } from "./TrainingHalo";

export type RemoteTrainingProvider = {
  id: "fake" | "managed";
  enabled: boolean;
  label: string;
  model_profiles: Array<{
    id: "understudy/auto" | "understudy/fast" | "understudy/balanced" | "understudy/quality";
    label: string;
    summary: string;
    recommended: boolean;
  }>;
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

export type RemotePlan = {
  schema_version: "understudy.remote_training.plan.v2";
  plan_id: string;
  task_kind: "text_classification" | "chat_sft";
  evaluator?: string | null;
  provider: "fake" | "managed";
  model_profile: RemoteTrainingProvider["model_profiles"][number]["id"];
  frontier_model: string;
  output_model_name: string;
  artifacts: RemoteArtifact[];
  epochs: number;
  maximum_spend_usd: number;
  maximum_runtime_seconds: number;
  preparation_duration_ms?: number;
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

type BackendCompatibility = {
  schema_version: "understudy.remote_training.backend_compatibility.v1";
  plan_sha256: string;
  split_hash: string;
  evaluator: string;
  local_only: true;
  provider_called: false;
  upload_performed: false;
  plan_preparation_duration_ms: number;
  compile_duration_ms: number;
  artifact_path: string;
  backends: Array<{
    id: string;
    compatible: boolean;
    execution_ready: boolean;
    recipe: string;
    evaluator: string;
    execution_gate: string;
  }>;
};

type CommonProps = {
  modelName: string;
  onActiveChange: (active: boolean) => void;
  onVisualChange: (visual: TrainingHaloVisual | null) => void;
};

type ClassificationProps = CommonProps & {
  datasetManifestPath: string;
  capabilities: RemoteTrainingCapabilities;
  onTrainLocal: () => void;
  preparedPlan?: never;
  onBack?: never;
};

type PreparedPlanProps = CommonProps & {
  preparedPlan: RemotePlan;
  onBack: () => void;
  datasetManifestPath?: never;
  capabilities?: never;
  onTrainLocal?: never;
};

type Props = ClassificationProps | PreparedPlanProps;

type Stage = "recovering" | "choice" | "preparing" | "confirm" | "starting" | "running" | "terminal" | "failed";

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function providerDefault(providers: RemoteTrainingProvider[]): RemoteTrainingProvider | undefined {
  return providers.find((provider) => provider.id === "managed") ?? providers[0];
}

function profileDefault(provider: RemoteTrainingProvider | undefined) {
  return provider?.model_profiles.find((profile) => profile.recommended)
    ?? provider?.model_profiles[0];
}

function visualPhase(phase: string): TrainingHaloVisual["phase"] {
  if (phase === "training") return "training";
  if (phase === "evaluation") return "evaluating";
  if (phase === "deployment" || phase === "cleanup") return "saving";
  return "preparing";
}

export function RemoteTrainingPanel(props: Props) {
  const preparedPlan = props.preparedPlan ?? null;
  const preparedMode = preparedPlan !== null;
  const datasetManifestPath = props.datasetManifestPath ?? null;
  const capabilities = props.capabilities ?? null;
  const { modelName, onActiveChange, onVisualChange } = props;
  const providers = useMemo(
    () => capabilities?.providers.filter((provider) => provider.enabled && provider.model_profiles.length > 0) ?? [],
    [capabilities],
  );
  const initialProvider = providerDefault(providers);
  const [providerId] = useState<RemoteTrainingProvider["id"]>(
    () => preparedPlan?.provider ?? initialProvider?.id ?? "fake",
  );
  const [profileId, setProfileId] = useState<RemoteTrainingProvider["model_profiles"][number]["id"]>(
    () => preparedPlan?.model_profile ?? profileDefault(initialProvider)?.id ?? "understudy/auto",
  );
  const [stage, setStage] = useState<Stage>("recovering");
  const [plan, setPlan] = useState<RemotePlan | null>(preparedPlan);
  const [run, setRun] = useState<RemoteRunReceipt | null>(null);
  const [events, setEvents] = useState<RemoteTrainingEvent[]>([]);
  const [uploadEvent, setUploadEvent] = useState<UploadEvent | null>(null);
  const [result, setResult] = useState<RemoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backendCompatibility, setBackendCompatibility] = useState<BackendCompatibility | null>(null);
  const [backendCompatibilityError, setBackendCompatibilityError] = useState<string | null>(null);
  const polling = useRef(false);
  const stopped = useRef(false);
  const provider = providers.find((candidate) => candidate.id === providerId) ?? providers[0];
  const profile = provider?.model_profiles.find((candidate) => candidate.id === profileId)
    ?? (provider ? profileDefault(provider) : undefined);
  const active = stage === "preparing" || stage === "starting" || stage === "running";
  const latestEvent = events.at(-1);
  const planPath = plan?.plan_path ?? null;

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
    setBackendCompatibility(null);
    setBackendCompatibilityError(null);
    if (!planPath) return () => { cancelled = true; };
    void invoke<BackendCompatibility>("compile_remote_training_backends", { planPath })
      .then((compiled) => {
        if (!cancelled) setBackendCompatibility(compiled);
      })
      .catch((cause) => {
        if (!cancelled) setBackendCompatibilityError(String(cause));
      });
    return () => { cancelled = true; };
  }, [planPath]);

  useEffect(() => {
    let cancelled = false;
    setStage("recovering");
    setPlan(preparedPlan);
    setRun(null);
    setEvents([]);
    setUploadEvent(null);
    setResult(null);
    setError(null);
    stopped.current = false;
    const recovery = preparedPlan
      ? invoke<RemoteRunReceipt | null>("existing_remote_training", {
          planPath: preparedPlan.plan_path,
        })
      : invoke<RemoteRunReceipt | null>("existing_remote_classification_training", {
          manifestPath: datasetManifestPath,
        });
    void recovery
      .then((receipt) => {
        if (cancelled) return;
        if (receipt) {
          setRun(receipt);
          setStage("running");
        } else {
          setStage(preparedPlan ? "confirm" : "choice");
        }
      })
      .catch(() => {
        if (!cancelled) setStage(preparedPlan ? "confirm" : "choice");
      });
    return () => {
      cancelled = true;
    };
  }, [datasetManifestPath, preparedPlan]);

  const prepare = useCallback(() => {
    if (!capabilities || !datasetManifestPath || !provider || stage !== "choice") return;
    setStage("preparing");
    setError(null);
    if (!profile) return;
    const maximumSpend = Math.min(provider.id === "fake" ? 1 : 500, capabilities.limits.max_budget_usd);
    void invoke<RemotePlan>("prepare_remote_classification_training", {
      manifestPath: datasetManifestPath,
      provider: provider.id,
      modelProfile: profile.id,
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
  }, [capabilities, datasetManifestPath, profile, provider, stage]);

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
    if (!plan || stage !== "confirm") return;
    setStage("starting");
    setError(null);
    setEvents([]);
    const channel = new Channel<UploadEvent>();
    channel.onmessage = setUploadEvent;
    void invoke<RemoteRunReceipt>("start_remote_training", {
      planPath: plan.plan_path,
      confirmUpload: true,
      confirmSpend: true,
      confirmTemporaryDeployment: true,
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

  const goBack = () => {
    if (preparedMode) {
      props.onBack?.();
    } else {
      setStage("choice");
    }
  };

  const resetRun = () => {
    setPlan(preparedPlan);
    setRun(null);
    setEvents([]);
    setUploadEvent(null);
    setResult(null);
    setError(null);
    setStage(preparedPlan ? "confirm" : "choice");
  };

  if (stage === "recovering") {
    return <div className="remote-training-state" aria-live="polite"><strong>Checking the last remote run</strong><small>Looking only at protected run evidence on this Mac.</small></div>;
  }

  if (stage === "choice" && !preparedMode) {
    return (
      <div className="remote-training-choice">
        <div>
          <span>Experimental cloud training</span>
          <strong>Train a larger model without tying up this Mac</strong>
          <small>Understudy prepares everything locally first. Nothing uploads until you review the exact artifacts and budget.</small>
        </div>
        {provider && provider.model_profiles.length > 1 && (
          <label>
            <span>Model</span>
            <select value={profile?.id} onChange={(event) => setProfileId(event.target.value as typeof profileId)}>
              {provider.model_profiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </select>
          </label>
        )}
        {profile && <small>{profile.summary}</small>}
        <div className="remote-training-actions">
          <button type="button" className="btn primary" onClick={prepare}>
            {provider?.id === "fake" ? "Try the no-spend cloud proof" : "Review remote training"}
          </button>
          <button type="button" className="btn ghost" onClick={props.onTrainLocal}>Train on this Mac</button>
        </div>
      </div>
    );
  }

  if (stage === "preparing") {
    return <div className="remote-training-state" aria-live="polite"><strong>Preparing locally</strong><small>Verifying split hashes and producing private upload artifacts. Nothing is leaving this Mac.</small></div>;
  }

  if (stage === "confirm" && plan) {
    const totalBytes = plan.artifacts.reduce((sum, artifact) => sum + artifact.size_bytes, 0);
    const noSpendProof = plan.provider === "fake";
    const localPreflightMs = backendCompatibility
      ? backendCompatibility.plan_preparation_duration_ms + backendCompatibility.compile_duration_ms
      : plan.preparation_duration_ms;
    return (
      <div className="remote-training-confirm">
        <div className="remote-training-confirm-heading">
          <div><span>Ready</span><strong>{noSpendProof ? "$0 proof" : modelName}</strong></div>
          <small>{plan.artifacts.reduce((sum, artifact) => sum + artifact.row_count, 0).toLocaleString()} examples</small>
        </div>
        {backendCompatibilityError && <p className="remote-training-warning">Portable backend check failed: {backendCompatibilityError}</p>}
        <p className="remote-training-consent-summary">
          Uploads {plan.artifacts.length} split files · {noSpendProof ? "no provider spend" : `$${plan.maximum_spend_usd.toFixed(2)} max`} · deletes the evaluation endpoint
        </p>
        <div className="remote-training-actions">
          <button type="button" className="btn primary" onClick={start}>{noSpendProof ? "Run proof" : `Train · max $${plan.maximum_spend_usd.toFixed(2)}`}</button>
          <button type="button" className="btn ghost" onClick={goBack}>Cancel</button>
        </div>
        <details className="remote-training-details">
          <summary>Details</summary>
          <small>
            {modelName} · {bytes(totalBytes)}
            {localPreflightMs !== undefined ? ` · ${(localPreflightMs / 1_000).toFixed(2)}s local` : ""}
          </small>
          {backendCompatibility && (
            <small aria-label="Portable backend recipe">
              {backendCompatibility.backends.map((backend) => `${backend.id} ${backend.execution_ready ? "ready" : "gated"}`).join(" · ")}
            </small>
          )}
        </details>
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
          <details className="remote-training-details"><summary>Details</summary><small>Eve chose to {latestEvent.eve.decision.replace("_", " ")} · {latestEvent.eve.reason_code}</small></details>
        )}
        {error && <p className="remote-training-warning">{error}</p>}
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
        <div><span>{terminalCopy.eyebrow}</span><strong>{terminalCopy.title}</strong><small>Reported training cost: ${result.spend_usd.toFixed(2)}</small></div>
        <div className="remote-training-metrics">
          {result.metrics.map((metric) => <article key={metric.id}><span>{metric.label}</span><strong>{metric.display_value}</strong><small>{metric.explanation}</small></article>)}
        </div>
        {result.failures.length > 0 && <div className="remote-training-failures"><strong>Where it still fails</strong>{result.failures.slice(0, 3).map((failure, index) => <p key={index}>{failure.expected} expected · {failure.actual} returned · {failure.input_summary}</p>)}</div>}
        {result.outcome === "promoted" && result.output_model && <div className="remote-training-endpoint"><span>Private trained model</span><code>{result.output_model}</code>{result.endpoint && <small>Serving is active through the authenticated Understudy endpoint.</small>}</div>}
        <div className="remote-training-actions"><button type="button" className="btn ghost" onClick={resetRun}>Start another run</button></div>
      </div>
    );
  }

  return (
    <div className="remote-training-state failed" role="alert">
      <div><strong>Remote training did not start</strong><small>{error ?? "The local dataset is intact and no further work will run."}</small></div>
      <div className="remote-training-actions">
        <button type="button" className="btn primary" onClick={resetRun}>Try again</button>
        {preparedMode
          ? <button type="button" className="btn ghost" onClick={props.onBack}>Back to recipe</button>
          : <button type="button" className="btn ghost" onClick={props.onTrainLocal}>Train on this Mac</button>}
      </div>
    </div>
  );
}
