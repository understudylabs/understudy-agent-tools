"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { TrainingHaloVisual } from "./TrainingHalo";

export type RemoteTrainingProvider = {
  id: "managed";
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
  service: "understudy-train-api";
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

export function maximumManagedTrainingSpend(capabilities: RemoteTrainingCapabilities): number {
  const maximumSpend = capabilities.limits.max_budget_usd;
  if (!Number.isFinite(maximumSpend) || maximumSpend <= 0) {
    throw new Error("Cloud training did not advertise a valid spend limit.");
  }
  return maximumSpend;
}

export function recommendedManagedTrainingSpend(capabilities: RemoteTrainingCapabilities): number {
  return maximumManagedTrainingSpend(capabilities);
}

type RemoteArtifact = {
  artifact_role: "train" | "validation" | "heldout";
  file_name: string;
  row_count: number;
  sha256: string;
  size_bytes: number;
};

export type RemotePlan = {
  schema_version: "understudy.training.plan.v1";
  plan_id: string;
  recipe_id: string;
  task_kind: "text_classification" | "chat_sft";
  evaluator?: string | null;
  model_profile: RemoteTrainingProvider["model_profiles"][number]["id"];
  frontier_model?: string | null;
  output_model_name: string;
  artifacts: RemoteArtifact[];
  epochs: number;
  maximum_spend_usd: number;
  maximum_runtime_seconds: number;
  preparation_duration_ms?: number;
  plan_path: string;
};

export function remoteTrainingArtifactLimitError(
  plan: RemotePlan,
  capabilities: RemoteTrainingCapabilities,
): string | null {
  const oversized = plan.artifacts
    .filter((artifact) => artifact.size_bytes > capabilities.limits.max_upload_bytes)
    .sort((left, right) => right.size_bytes - left.size_bytes)[0];
  if (!oversized) return null;
  const formatMiB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${oversized.artifact_role} split is ${formatMiB(oversized.size_bytes)}; cloud training currently accepts ${formatMiB(capabilities.limits.max_upload_bytes)} per split.`;
}

type RemoteRunReceipt = {
  schema_version: "understudy.remote_training.run.v1";
  run_id: string;
  run_manifest_path: string;
};

type RemoteTrainingEvent = {
  schema_version?: "understudy-train-v1";
  sequence?: number;
  type?: string;
  occurred_at?: string;
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

type RemoteTrainingExampleSet = {
  schema_version: "understudy.remote_training.example_stream.v1";
  total: number;
  truncated: boolean;
  examples: Array<{ input: string; target: string | null }>;
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
  estimated_spend_usd?: number;
  reserved_spend_usd?: number;
  reconciled_spend_usd?: number | null;
  provider_error?: {
    phase: "upload" | "training" | "deployment" | "adapter" | "evaluation";
    resource_id: string;
    resource: string;
    status: string;
    code?: string;
    message?: string;
  };
  terminal_error?: {
    phase: "queued" | "upload" | "training" | "deployment" | "adapter" | "evaluation" | "cleanup";
    code: string;
    message: string;
  };
  cleanup_attempts?: Array<{
    resource_kind: "training_job" | "adapter" | "deployment" | "model" | "datasets" | "uploads";
    resource_id: string;
    attempts: number;
    outcome: "removed_or_absent" | "pending";
    error?: string;
  }>;
  cleanup_pending?: Array<"training_job" | "adapter" | "deployment" | "model" | "datasets" | "uploads">;
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
    adapter_implemented: boolean;
    execution_ready: boolean;
    transport: string;
    command: string;
    recipe: string;
    evaluator: string;
    execution_gate: string;
  }>;
};

type CommonProps = {
  modelName: string;
  onActiveChange: (active: boolean) => void;
  onVisualChange: (visual: TrainingHaloVisual | null) => void;
  onRunViewChange?: (engaged: boolean) => void;
  trainingExamples?: Array<{ input: string; target: string | null }>;
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
  onBack?: () => void;
  datasetManifestPath?: never;
  capabilities?: never;
  onTrainLocal?: never;
};

type Props = ClassificationProps | PreparedPlanProps;

type Stage = "recovering" | "choice" | "preparing" | "confirm" | "starting" | "running" | "terminal" | "failed";

function RunElapsed({ startedAt }: { startedAt: number | null }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (startedAt === null) {
      setElapsedSeconds(0);
      return;
    }
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return startedAt === null ? null : <> · {elapsedSeconds}s elapsed</>;
}

function compactSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function CopyableSha({ sha256 }: { sha256: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded border border-transparent bg-transparent p-0 font-mono text-[11px] text-muted-foreground hover:underline"
      title={`Copy full sha256: ${sha256}`}
      aria-label={`Copy full sha256 ${sha256}`}
      onClick={() => {
        void navigator.clipboard?.writeText(sha256).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_600);
        });
      }}
    >
      <code>{sha256.slice(0, 12)}…</code>
      <span aria-hidden="true">{copied ? "copied" : "copy"}</span>
    </button>
  );
}

/**
 * Consent receipts: exactly what leaves this Mac if the user approves.
 * Everything rendered here comes from the already-prepared local plan —
 * no additional backend calls.
 */
function ConsentReceipts({ plan }: { plan: RemotePlan }) {
  const totalBytes = plan.artifacts.reduce((sum, artifact) => sum + artifact.size_bytes, 0);
  return (
    <div className="remote-training-consent-receipts w-full text-left text-[12px]" aria-label="Exactly what leaves this Mac">
      <strong className="block">What leaves this Mac if you approve</strong>
      <ul className="m-0 mt-1 grid list-none gap-1 p-0">
        {plan.artifacts.map((artifact) => (
          <li key={artifact.file_name} className="flex flex-wrap items-baseline gap-x-2">
            <code className="font-mono text-[11px]">{artifact.file_name}</code>
            <span className="text-muted-foreground">
              {artifact.artifact_role} · {artifact.row_count.toLocaleString()} rows · {compactSize(artifact.size_bytes)}
            </span>
            <CopyableSha sha256={artifact.sha256} />
          </li>
        ))}
      </ul>
      <ul className="m-0 mt-2 grid list-none gap-0.5 p-0 text-muted-foreground">
        <li>{compactSize(totalBytes)} total upload · heldout targets are never uploaded</li>
        <li>
          Max spend {plan.maximum_spend_usd.toLocaleString(undefined, { style: "currency", currency: "USD" })} · hard cap enforced server-side
        </li>
        <li>
          Output model · <code className="font-mono text-[11px]">{plan.output_model_name}</code>
        </li>
      </ul>
    </div>
  );
}

function providerDefault(providers: RemoteTrainingProvider[]): RemoteTrainingProvider | undefined {
  return providers.find((provider) => provider.id === "managed");
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
  const { modelName, onActiveChange, onRunViewChange, onVisualChange } = props;
  const providers = useMemo(
    () => capabilities?.providers.filter(
      (provider) => provider.id === "managed" && provider.enabled && provider.model_profiles.length > 0,
    ) ?? [],
    [capabilities],
  );
  const initialProvider = providerDefault(providers);
  const [providerId] = useState<RemoteTrainingProvider["id"]>(
    () => initialProvider?.id ?? "managed",
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
  const [runExamples, setRunExamples] = useState<RemoteTrainingExampleSet | null>(null);
  const [runExampleCursor, setRunExampleCursor] = useState(0);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [, setBackendCompatibility] = useState<BackendCompatibility | null>(null);
  const [backendCompatibilityError, setBackendCompatibilityError] = useState<string | null>(null);
  const polling = useRef(false);
  const stopped = useRef(false);
  const provider = providers.find((candidate) => candidate.id === providerId) ?? providers[0];
  const profile = provider?.model_profiles.find((candidate) => candidate.id === profileId)
    ?? (provider ? profileDefault(provider) : undefined);
  const active = stage === "preparing" || stage === "starting" || stage === "running";
  const runViewEngaged = submitted && (stage === "starting" || stage === "running" || stage === "terminal" || stage === "failed");
  const latestEvent = events.at(-1);
  const planPath = plan?.plan_path ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!runViewEngaged || !planPath) {
      setRunExamples(null);
      setRunExampleCursor(0);
      return () => { cancelled = true; };
    }
    void invoke<RemoteTrainingExampleSet>("remote_training_examples", { planPath })
      .then((stream) => {
        if (!cancelled) {
          setRunExamples(stream);
          setRunExampleCursor(0);
        }
      })
      .catch(() => {
        if (!cancelled) setRunExamples(null);
      });
    return () => { cancelled = true; };
  }, [planPath, runViewEngaged]);

  useEffect(() => {
    const count = runExamples?.examples.length ?? 0;
    if ((stage !== "starting" && stage !== "running") || count <= 6) return;
    const timer = window.setInterval(() => {
      setRunExampleCursor((cursor) => cursor + 6 >= count ? 0 : cursor + 6);
    }, 1_600);
    return () => window.clearInterval(timer);
  }, [runExamples, stage]);

  useEffect(() => {
    onActiveChange(active);
  }, [active, onActiveChange]);

  useEffect(() => {
    onRunViewChange?.(runViewEngaged);
  }, [onRunViewChange, runViewEngaged]);

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
    onRunViewChange?.(false);
    onVisualChange(null);
  }, [onActiveChange, onRunViewChange, onVisualChange]);

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
    setRunStartedAt(null);
    setError(null);
    setSubmitted(false);
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
          setSubmitted(true);
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
    const maximumSpend = recommendedManagedTrainingSpend(capabilities);
    void invoke<RemotePlan>("prepare_remote_classification_training", {
      manifestPath: datasetManifestPath,
      modelProfile: profile.id,
      maximumSpendUsd: maximumSpend,
    })
      .then((prepared) => {
        const artifactLimitError = remoteTrainingArtifactLimitError(prepared, capabilities);
        if (artifactLimitError) {
          setError(artifactLimitError);
          setStage("failed");
          return;
        }
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
    onRunViewChange?.(true);
    setSubmitted(true);
    setRunStartedAt(Date.now());
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
      .then(() => setError("Stop requested. Understudy is preserving cleanup before the run ends."))
      .catch((cause) => setError(String(cause)));
  };

  const resetRun = () => {
    onRunViewChange?.(false);
    setSubmitted(false);
    setPlan(preparedPlan);
    setRun(null);
    setEvents([]);
    setUploadEvent(null);
    setResult(null);
    setRunStartedAt(null);
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
            Review remote training
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
    return (
      <div className="remote-training-confirm">
        {backendCompatibilityError && <p className="remote-training-warning">Portable backend check failed: {backendCompatibilityError}</p>}
        <ConsentReceipts plan={plan} />
        <div className="remote-training-actions" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn primary" onClick={start}>Upload & train</button>
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
    const phaseTitle = latestEvent?.phase === "training"
      ? "Training"
      : latestEvent?.phase === "evaluation"
        ? "Evaluating"
        : latestEvent?.phase === "deployment"
          ? "Preparing your model"
          : latestEvent?.phase === "cleanup"
            ? "Finishing safely"
            : "Starting";
    const fallbackExamples = props.trainingExamples?.filter((example) => example.input.trim()).slice(0, 6) ?? [];
    const sourceExamples = runExamples?.examples.length ? runExamples.examples : fallbackExamples;
    const examples = sourceExamples.slice(runExampleCursor, runExampleCursor + 6);
    const streamStart = sourceExamples.length > 0 ? Math.min(runExampleCursor + 1, sourceExamples.length) : 0;
    const streamEnd = sourceExamples.length > 0 ? Math.min(runExampleCursor + examples.length, sourceExamples.length) : 0;
    return (
      <div className="remote-training-running remote-training-run-view" aria-live="polite" aria-busy="true">
        <header>
          <span className="local-training-pulse" aria-hidden="true" />
          <div>
            <span>Remote training</span>
            <strong>{phaseTitle}</strong>
            <small>{progress ?? status}<RunElapsed startedAt={runStartedAt} /></small>
          </div>
          {run && <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>}
        </header>
        {examples.length > 0 && (
          <div className="remote-training-example-window" aria-label="Actual prepared training examples">
            <header>
              <span>Actual train split · {streamStart.toLocaleString()}–{streamEnd.toLocaleString()} of {(runExamples?.total ?? sourceExamples.length).toLocaleString()}</span>
              <small>Local display order; the provider may shuffle batches</small>
            </header>
            <div className="remote-training-example-track" key={runExampleCursor}>
              {examples.map((example, index) => (
                <article key={`${runExampleCursor + index}-${example.input.slice(0, 32)}`}>
                  <span>Training example {(runExampleCursor + index + 1).toLocaleString()}</span>
                  <p>{example.input}</p>
                  {example.target && <small>Expected · {example.target}</small>}
                </article>
              ))}
            </div>
          </div>
        )}
        {error && <p className="remote-training-warning">{error}</p>}
      </div>
    );
  }

  if (stage === "terminal" && result) {
    const primaryMetric = result.metrics.find((metric) => metric.id === "improvement_over_base")
      ?? result.metrics.find((metric) => metric.id === "correct_answers")
      ?? result.metrics[0];
    const secondaryMetrics = result.metrics.filter((metric) => metric !== primaryMetric);
    const terminalCopy = result.outcome === "promoted"
      ? { eyebrow: "Ready to use", title: "This model earned promotion" }
      : result.outcome === "needs_work"
        ? { eyebrow: "Review complete", title: "This model needs another pass" }
        : result.outcome === "cancelled"
          ? { eyebrow: "Stopped safely", title: "Remote training was cancelled" }
          : { eyebrow: "Run ended", title: "Remote training did not complete" };
    const diagnostic = result.provider_error
      ? {
          title: `${result.provider_error.phase} failed · ${result.provider_error.code ?? result.provider_error.status}`,
          message: result.provider_error.message ?? result.terminal_error?.message ?? "The provider stopped this resource.",
        }
      : result.terminal_error
        ? { title: `${result.terminal_error.phase} failed · ${result.terminal_error.code}`, message: result.terminal_error.message }
        : result.outcome === "failed"
          ? { title: "No detailed diagnostic", message: "This run predates detailed failure receipts. New runs preserve the provider error here and on this Mac." }
          : null;
    const hasSpendBreakdown = result.estimated_spend_usd !== undefined
      || result.reserved_spend_usd !== undefined
      || result.reconciled_spend_usd !== undefined;
    const hasCleanupDetails = (result.cleanup_attempts?.length ?? 0) > 0 || (result.cleanup_pending?.length ?? 0) > 0;
    return (
      <div className={`remote-training-result ${result.outcome}`}>
        <div><span>{terminalCopy.eyebrow}</span><strong>{terminalCopy.title}</strong><small>{result.reconciled_spend_usd != null ? "Provider spend" : "Budget accounted"}: ${result.spend_usd.toFixed(2)}</small></div>
        {diagnostic && <p className="remote-training-diagnostic"><strong>{diagnostic.title}</strong><small>{diagnostic.message}</small></p>}
        {primaryMetric && <div className="remote-training-metrics"><article><span>{primaryMetric.label}</span><strong>{primaryMetric.display_value}</strong></article></div>}
        {(secondaryMetrics.length > 0 || result.failures.length > 0 || result.output_model || result.provider_error || hasSpendBreakdown || hasCleanupDetails) && (
          <details className="remote-training-details">
            <summary>Run details</summary>
            {hasSpendBreakdown && <small>Estimate ${result.estimated_spend_usd?.toFixed(2) ?? "—"} · reserve ${result.reserved_spend_usd?.toFixed(2) ?? "—"} · reconciled {result.reconciled_spend_usd == null ? "pending" : `$${result.reconciled_spend_usd.toFixed(2)}`}</small>}
            {result.provider_error && <small>Provider {result.provider_error.status} · {result.provider_error.resource_id}</small>}
            {hasCleanupDetails && <small>{result.cleanup_pending?.length ? `Cleanup pending: ${result.cleanup_pending.join(", ")}` : "Cleanup complete"}</small>}
            {secondaryMetrics.length > 0 && <div className="remote-training-metrics">{secondaryMetrics.map((metric) => <article key={metric.id}><span>{metric.label}</span><strong>{metric.display_value}</strong><small>{metric.explanation}</small></article>)}</div>}
            {result.failures.length > 0 && <div className="remote-training-failures"><strong>Where it still fails</strong>{result.failures.slice(0, 3).map((failure, index) => <p key={index}>{failure.expected} expected · {failure.actual} returned · {failure.input_summary}</p>)}</div>}
            {result.output_model && <div className="remote-training-endpoint"><span>Private trained model</span><code>{result.output_model}</code>{result.endpoint && <small>Serving is active through the authenticated Understudy endpoint.</small>}</div>}
          </details>
        )}
        <div className="remote-training-actions"><button type="button" className="btn ghost" onClick={resetRun}>Start another run</button></div>
      </div>
    );
  }

  return (
    <div className="remote-training-state failed" role="alert">
      <div><strong>Remote training did not start</strong><small>{error ?? "The local dataset is intact and no further work will run."}</small></div>
      <div className="remote-training-actions">
        <button type="button" className="btn primary" onClick={resetRun}>Try again</button>
        {preparedMode && props.onBack
          ? <button type="button" className="btn ghost" onClick={props.onBack}>Back to recipe</button>
          : preparedMode
            ? null
          : <button type="button" className="btn ghost" onClick={props.onTrainLocal}>Train on this Mac</button>}
      </div>
    </div>
  );
}
