"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  INITIAL_LOCAL_TRAINING_STATE,
  isLocalTrainingActive,
  localPredictionConfidence,
  localTrainingPhaseCopy,
  localTrainingProgress,
  localTrainingReducer,
  localTrainingTiming,
  localTrainingVerdict,
  type LocalTrainingEvent,
  type LocalTrainingState,
} from "../lib/local-training-state.mjs";
import { EvaluationRadar } from "./EvaluationRadar";
import {
  RemoteTrainingPanel,
  type RemoteTrainingCapabilities,
} from "./RemoteTrainingPanel";
import type { TrainingHaloVisual } from "./TrainingHalo";

const MODERN_BERT_MODEL = "answerdotai/ModernBERT-base";

type ClassificationTrainingRun = {
  schema_version: "understudy.capture_import.classification_run.v1";
  run_id: string;
  status: "completed";
  local_only: true;
  data_boundary: {
    dataset_uploaded: false;
    telemetry_sent: false;
    model_download_required: boolean;
  };
  dataset: { dataset_id: string };
  split_evidence: {
    policy: "deterministic-stratified-group-aware-v2";
    group_key: string;
    group_normalization: "casefold-reference-stripping-v1";
    no_group_overlap: true;
    verified_no_group_overlap: true;
  };
  model: {
    requested_id: string;
    resolved_id: string;
    path: string;
    size_bytes: number;
    labels: string[];
  };
  baseline: {
    name: "majority-class";
    label: string;
    accuracy: number;
    macro_f1: number;
  };
  linear_baseline: {
    name: "tfidf-logistic-regression";
    accuracy: number;
    macro_f1: number;
  };
  heldout: {
    row_count: number;
    accuracy: number;
    macro_f1: number;
    latency_ms_p50: number;
    failures: {
      example_id: string;
      group_id: string;
      text_sha256: string;
      expected_label: string;
      predicted_label: string;
    }[];
    failure_count: number;
    failures_truncated: boolean;
    weakest_classes: {
      label: string;
      recall: number;
      f1: number;
      support: number;
    }[];
  };
  verdict: {
    status: "not_better" | "improved_not_ready" | "promising";
    comparison_baseline: "tfidf-logistic-regression";
    one_run_only: true;
    reason: string;
  };
  timings_ms: { total: number };
  manifest_path: string;
};

type ClassificationPrediction = {
  schema_version: "understudy.capture_import.classification_prediction.v1";
  run_id: string;
  text_sha256: string;
  label: string;
  scores: { label: string; score: number }[];
  model_id: string;
  base_model_id: string;
  local_only: true;
};

type ClassificationTrainingPreview = {
  dataset_id: string;
  split: "train";
  row_count: number;
  local_only: true;
  verified_split_sha256: string;
  examples: {
    example_id: string;
    row_number: number;
    text: string;
    label: string;
    truncated: boolean;
  }[];
};

type FrontierComparison = {
  schema_version: "understudy.capture_import.frontier_classification.v1";
  comparison_id: string;
  status: "completed";
  run_id: string;
  requested_model: string;
  served_model: string;
  exact_same_holdout: true;
  holdout_sha256: string;
  row_count: number;
  data_boundary: {
    user_confirmed_remote_comparison: true;
    training_examples_uploaded: false;
    holdout_examples_uploaded: true;
    retention_expectation: string;
  };
  heldout: {
    accuracy: number;
    macro_f1: number;
    latency_ms_p50: number;
    failure_count: number;
    weakest_classes: {
      label: string;
      recall: number;
      f1: number;
      support: number;
    }[];
  };
  spend: {
    user_confirmed_spend: true;
    approved_budget_usd: number;
    estimated_max_cost_usd: number;
    attributed_cost_usd: number;
    pricing_source: string;
    pricing_checked_at: string;
  };
  artifact_path: string;
};

type FrontierComparisonEvent = {
  type: "phase";
  phase: "preparing" | "comparing" | "measuring" | "saving";
  current?: number;
  total?: number;
  message?: string;
};

type Props = {
  datasetManifestPath: string;
  modelName: string;
  autoStart?: boolean;
  onActiveChange?: (active: boolean) => void;
  onVisualChange?: (visual: TrainingHaloVisual | null) => void;
};

type RemoteCapabilitiesEnvelope = {
  schema_version: "understudy.remote_training.capabilities.v1";
  enabled: boolean;
  reason?: string;
  capabilities?: RemoteTrainingCapabilities;
};

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function runId(): string {
  return `desktop-${crypto.randomUUID()}`;
}

function compactDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function completionClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function LocalTrainingPanel({
  datasetManifestPath,
  modelName,
  autoStart = false,
  onActiveChange,
  onVisualChange,
}: Props) {
  const [state, dispatch] = useReducer(
    localTrainingReducer<ClassificationTrainingRun>,
    INITIAL_LOCAL_TRAINING_STATE as LocalTrainingState<ClassificationTrainingRun>,
  );
  const [predictionText, setPredictionText] = useState("");
  const [prediction, setPrediction] = useState<ClassificationPrediction | null>(null);
  const [predictionError, setPredictionError] = useState<string | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [frontierComparison, setFrontierComparison] = useState<FrontierComparison | null>(null);
  const [frontierEvent, setFrontierEvent] = useState<FrontierComparisonEvent | null>(null);
  const [frontierError, setFrontierError] = useState<string | null>(null);
  const [comparingFrontier, setComparingFrontier] = useState(false);
  const [trainingPreview, setTrainingPreview] = useState<ClassificationTrainingPreview | null>(null);
  const [trainingPreviewIndex, setTrainingPreviewIndex] = useState(0);
  const [previousTrainingPreviewIndex, setPreviousTrainingPreviewIndex] = useState<number | null>(null);
  const [haloProgress, setHaloProgress] = useState({ epochs: 3, completedEpochs: 0 });
  const [remoteCapabilityState, setRemoteCapabilityState] = useState<"checking" | "available" | "unavailable">("checking");
  const [remoteCapabilities, setRemoteCapabilities] = useState<RemoteTrainingCapabilities | null>(null);
  const [remoteActive, setRemoteActive] = useState(false);
  const [remoteVisual, setRemoteVisual] = useState<TrainingHaloVisual | null>(null);
  const [forceLocal, setForceLocal] = useState(false);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const generation = useRef(0);
  const activeRunId = useRef<string | null>(null);
  const cancellationRequested = useRef(false);
  const autoStartedManifest = useRef<string | null>(null);
  const trainingPreviewIndexRef = useRef(0);
  const previewFadeTimer = useRef<number | null>(null);
  const runStartedAt = useRef<number | null>(null);
  const trainingStartedAt = useRef<number | null>(null);
  const lastEpochCompletedAt = useRef<number | null>(null);
  const localActive = isLocalTrainingActive(state);
  const active = localActive || remoteActive;
  const phaseCopy = localTrainingPhaseCopy(state.phase);
  const measuredProgress = localTrainingProgress(state.event);
  const timing = localTrainingTiming({
    phase: state.phase,
    event: state.event,
    runStartedAt: runStartedAt.current,
    trainingStartedAt: trainingStartedAt.current,
    lastEpochCompletedAt: lastEpochCompletedAt.current,
    nowMs: clockMs,
  });

  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  useEffect(() => () => {
    onActiveChange?.(false);
    onVisualChange?.(null);
  }, [onActiveChange, onVisualChange]);

  useEffect(() => {
    if (remoteVisual) {
      onVisualChange?.(remoteVisual);
      return;
    }
    if (state.phase === "idle" || state.phase === "failed" || state.phase === "cancelled") {
      onVisualChange?.(null);
      return;
    }
    const phase = state.phase === "cancelling" ? "training" : state.phase;
    onVisualChange?.({
      phase,
      epochs: haloProgress.epochs,
      completedEpochs: state.phase === "completed" ? haloProgress.epochs : haloProgress.completedEpochs,
      stepFraction: null,
      modelId: `classifier.${state.runId}`,
      modelName,
      done: state.phase === "completed",
    });
  }, [haloProgress, modelName, onVisualChange, remoteVisual, state.phase, state.runId]);

  useEffect(() => {
    generation.current += 1;
    const run = activeRunId.current;
    activeRunId.current = null;
    cancellationRequested.current = false;
    autoStartedManifest.current = null;
    if (run) void invoke("cancel_local_classification_training", { runId: run });
    dispatch({ type: "reset" });
    setPredictionText("");
    setPrediction(null);
    setPredictionError(null);
    setFrontierComparison(null);
    setFrontierEvent(null);
    setFrontierError(null);
    setComparingFrontier(false);
    setTrainingPreview(null);
    setTrainingPreviewIndex(0);
    trainingPreviewIndexRef.current = 0;
    setPreviousTrainingPreviewIndex(null);
    setHaloProgress({ epochs: 3, completedEpochs: 0 });
    setRemoteActive(false);
    setRemoteVisual(null);
    setForceLocal(false);
    runStartedAt.current = null;
    trainingStartedAt.current = null;
    lastEpochCompletedAt.current = null;
    setClockMs(Date.now());
    if (previewFadeTimer.current !== null) window.clearTimeout(previewFadeTimer.current);
  }, [datasetManifestPath]);

  useEffect(() => {
    let cancelled = false;
    setRemoteCapabilityState("checking");
    setRemoteCapabilities(null);
    void invoke<RemoteCapabilitiesEnvelope>("remote_training_capabilities")
      .then((envelope) => {
        if (cancelled) return;
        const hasProvider = envelope.enabled && envelope.capabilities?.providers.some(
          (provider) => provider.enabled && provider.base_models.length > 0,
        );
        if (hasProvider && envelope.capabilities) {
          setRemoteCapabilities(envelope.capabilities);
          setRemoteCapabilityState("available");
        } else {
          setRemoteCapabilityState("unavailable");
        }
      })
      .catch(() => {
        if (!cancelled) setRemoteCapabilityState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [datasetManifestPath]);

  useEffect(() => () => {
    const run = activeRunId.current;
    if (run) void invoke("cancel_local_classification_training", { runId: run });
    if (previewFadeTimer.current !== null) window.clearTimeout(previewFadeTimer.current);
  }, []);

  useEffect(() => {
    if (!active) return;
    setClockMs(Date.now());
    const timer = window.setInterval(() => setClockMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active || state.phase === "cancelling" || (trainingPreview?.examples.length ?? 0) < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const interval = window.setInterval(() => {
      const current = trainingPreviewIndexRef.current;
      const next = (current + 1) % trainingPreview!.examples.length;
      setPreviousTrainingPreviewIndex(current);
      trainingPreviewIndexRef.current = next;
      setTrainingPreviewIndex(next);
      if (previewFadeTimer.current !== null) window.clearTimeout(previewFadeTimer.current);
      previewFadeTimer.current = window.setTimeout(() => {
        setPreviousTrainingPreviewIndex(null);
        previewFadeTimer.current = null;
      }, 1_100);
    }, 3_600);
    return () => {
      window.clearInterval(interval);
      if (previewFadeTimer.current !== null) {
        window.clearTimeout(previewFadeTimer.current);
        previewFadeTimer.current = null;
      }
    };
  }, [active, state.phase, trainingPreview]);

  const startTraining = useCallback(() => {
    if (active) return;
    const id = runId();
    const requestGeneration = generation.current + 1;
    generation.current = requestGeneration;
    activeRunId.current = id;
    cancellationRequested.current = false;
    setPrediction(null);
    setPredictionError(null);
    setFrontierComparison(null);
    setFrontierEvent(null);
    setFrontierError(null);
    setComparingFrontier(false);
    setTrainingPreview(null);
    setTrainingPreviewIndex(0);
    trainingPreviewIndexRef.current = 0;
    setPreviousTrainingPreviewIndex(null);
    setHaloProgress({ epochs: 3, completedEpochs: 0 });
    const startedAt = Date.now();
    runStartedAt.current = startedAt;
    trainingStartedAt.current = null;
    lastEpochCompletedAt.current = null;
    setClockMs(startedAt);
    dispatch({ type: "start", runId: id });
    void invoke<ClassificationTrainingPreview>("local_classification_training_examples", {
      manifestPath: datasetManifestPath,
    })
      .then((preview) => {
        if (generation.current === requestGeneration && preview.local_only && preview.split === "train") {
          setTrainingPreview(preview);
        }
      })
      .catch(() => {
        // A preview is supporting context, never a reason to block or misrepresent the real training run.
      });
    const channel = new Channel<LocalTrainingEvent>();
    channel.onmessage = (event) => {
      if (generation.current !== requestGeneration) return;
      const receivedAt = Date.now();
      if (event.phase === "training") {
        if (trainingStartedAt.current === null) trainingStartedAt.current = receivedAt;
        if (Number.isSafeInteger(event.current) && event.current! > 0) {
          lastEpochCompletedAt.current = receivedAt;
        }
      }
      setClockMs(receivedAt);
      if (
        event.phase === "training" &&
        Number.isSafeInteger(event.total) &&
        event.total! > 0 &&
        Number.isSafeInteger(event.current)
      ) {
        setHaloProgress({
          epochs: event.total!,
          completedEpochs: Math.min(event.total!, Math.max(0, event.current!)),
        });
      } else if (event.phase === "evaluating" || event.phase === "saving") {
        setHaloProgress((current) => ({ ...current, completedEpochs: current.epochs }));
      }
      dispatch({ type: "phase", event });
    };
    void invoke<ClassificationTrainingRun>("start_local_classification_training", {
      manifestPath: datasetManifestPath,
      runId: id,
      modelId: MODERN_BERT_MODEL,
      onEvent: channel,
    })
      .then((result) => {
        if (generation.current !== requestGeneration) return;
        activeRunId.current = null;
        dispatch(cancellationRequested.current
          ? { type: "cancelled" }
          : { type: "succeeded", result });
      })
      .catch((error) => {
        if (generation.current !== requestGeneration) return;
        activeRunId.current = null;
        const message = String(error);
        dispatch(cancellationRequested.current || message.toLowerCase().includes("cancel")
          ? { type: "cancelled" }
          : { type: "failed", error: message });
      });
  }, [active, datasetManifestPath]);

  useEffect(() => {
    if (
      !autoStart ||
      state.phase !== "idle" ||
      remoteCapabilityState === "checking" ||
      (remoteCapabilityState === "available" && !forceLocal) ||
      autoStartedManifest.current === datasetManifestPath
    ) return;
    const timer = window.setTimeout(() => {
      autoStartedManifest.current = datasetManifestPath;
      startTraining();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoStart, datasetManifestPath, forceLocal, remoteCapabilityState, startTraining, state.phase]);

  const cancelTraining = () => {
    if (!activeRunId.current || !active) return;
    cancellationRequested.current = true;
    dispatch({ type: "cancel_requested" });
    void invoke("cancel_local_classification_training", { runId: activeRunId.current });
  };

  const predict = () => {
    if (!state.result || !predictionText.trim() || predicting) return;
    setPredicting(true);
    setPrediction(null);
    setPredictionError(null);
    void invoke<ClassificationPrediction>("predict_local_classification", {
      runManifestPath: state.result.manifest_path,
      text: predictionText.trim(),
    })
      .then(setPrediction)
      .catch((error) => setPredictionError(String(error)))
      .finally(() => setPredicting(false));
  };

  const compareWithFrontier = () => {
    if (!state.result || comparingFrontier) return;
    const requestGeneration = generation.current;
    const localRunId = state.result.run_id;
    setComparingFrontier(true);
    setFrontierComparison(null);
    setFrontierError(null);
    setFrontierEvent({
      type: "phase",
      phase: "preparing",
      message: "Verifying the exact held-out examples used for the local score.",
    });
    const channel = new Channel<FrontierComparisonEvent>();
    channel.onmessage = (event) => {
      if (generation.current === requestGeneration) setFrontierEvent(event);
    };
    void invoke<FrontierComparison>("compare_local_classification_with_frontier", {
      runManifestPath: state.result.manifest_path,
      modelId: "glm-5.2",
      confirmRemote: true,
      confirmSpend: true,
      budgetUsd: 1,
      onEvent: channel,
    })
      .then((result) => {
        if (generation.current !== requestGeneration) return;
        if (result.run_id !== localRunId || !result.exact_same_holdout) {
          throw new Error("The frontier result did not match this local run.");
        }
        setFrontierComparison(result);
        setFrontierEvent(null);
      })
      .catch((error) => {
        if (generation.current === requestGeneration) setFrontierError(String(error));
      })
      .finally(() => {
        if (generation.current === requestGeneration) setComparingFrontier(false);
      });
  };

  if (state.phase === "idle") {
    if (remoteCapabilityState === "checking" && autoStart) return null;
    if (remoteCapabilityState === "available" && remoteCapabilities && !forceLocal) {
      return (
        <RemoteTrainingPanel
          datasetManifestPath={datasetManifestPath}
          modelName={modelName}
          capabilities={remoteCapabilities}
          onTrainLocal={() => {
            setForceLocal(true);
            startTraining();
          }}
          onActiveChange={setRemoteActive}
          onVisualChange={setRemoteVisual}
        />
      );
    }
    if (autoStart) return null;
    return (
      <div className="local-training-start">
        <button type="button" className="btn primary" onClick={startTraining}>
          Train a local model
        </button>
      </div>
    );
  }

  if (active && phaseCopy) {
    const trainingExample = trainingPreview && trainingPreview.examples.length > 0
      ? trainingPreview.examples[trainingPreviewIndex % trainingPreview.examples.length]
      : null;
    const previousTrainingExample = trainingPreview && previousTrainingPreviewIndex !== null
      ? trainingPreview.examples[previousTrainingPreviewIndex % trainingPreview.examples.length]
      : null;
    const renderedExamples = [
      ...(previousTrainingExample ? [{ example: previousTrainingExample, leaving: true }] : []),
      ...(trainingExample ? [{ example: trainingExample, leaving: false }] : []),
    ];
    return (
      <div className="local-training-running" aria-live="polite" aria-busy="true">
        <div className="local-training-status">
          <span className="local-training-pulse" aria-hidden="true" />
          <div className="local-training-status-copy">
            <strong>{phaseCopy[0]}</strong>
            <small>{state.event?.message || phaseCopy[1]}</small>
            {measuredProgress && <code>{measuredProgress}</code>}
            {timing && (
              <div className="local-training-timing" aria-label="Measured training timing">
                <span>Elapsed <b>{compactDuration(timing.elapsedMs)}</b></span>
                {state.phase === "training" && timing.measuring && (
                  <span>ETA <b>measuring first epoch</b></span>
                )}
                {state.phase === "training" && timing.paceMs !== null && timing.remainingMs !== null && timing.completionAt !== null && (
                  <>
                    <span>Pace <b>{compactDuration(timing.paceMs)} / epoch</b></span>
                    <span>Training left <b>about {compactDuration(timing.remainingMs)}</b></span>
                    <span>Training done <b>about {completionClock(timing.completionAt)}</b></span>
                  </>
                )}
              </div>
            )}
          </div>
          <button type="button" className="btn ghost" onClick={cancelTraining} disabled={state.phase === "cancelling"}>
            {state.phase === "cancelling" ? "Stopping…" : "Cancel"}
          </button>
        </div>
        {renderedExamples.length > 0 && trainingPreview && (
          <div
            className="local-training-example-stream"
            aria-label="Verified local training example"
            aria-live="off"
          >
            {renderedExamples.map(({ example, leaving }) => (
              <div
                key={`${state.runId}:${example.example_id}:${leaving ? "out" : "in"}`}
                className={`local-training-example${leaving ? " is-leaving" : " is-entering"}`}
              >
                <span>
                  Verified training example · split row {example.row_number.toLocaleString()}
                </span>
                <p>{example.text}</p>
                <div>
                  <small>Target</small>
                  <strong>{example.label}</strong>
                </div>
                <small>Verified training split · stays on this Mac</small>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (state.phase === "failed" || state.phase === "cancelled") {
    return (
      <div className={`local-training-terminal ${state.phase}`} role="status">
        <div>
          <strong>{state.phase === "cancelled" ? "Training stopped" : "Training did not finish"}</strong>
          <small>
            {state.phase === "cancelled"
              ? "Your prepared dataset is intact. Start again whenever you’re ready."
              : state.error || "The prepared dataset is intact. Repair the runtime if prompted, then retry."}
          </small>
        </div>
        <button type="button" className="btn primary" onClick={startTraining}>Try again</button>
      </div>
    );
  }

  if (!state.result) return null;
  const topScore = prediction?.scores.find((score) => score.label === prediction.label);
  const verdict = localTrainingVerdict(state.result);
  const confidenceWarning = localPredictionConfidence(topScore?.score);
  return (
    <div className="local-training-result">
      <div className="local-training-result-heading">
        <div>
          <strong>Your model is ready to review</strong>
          <small>Test examples were kept separate from training examples.</small>
        </div>
        <span>{(state.result.timings_ms.total / 1_000).toFixed(1)}s</span>
      </div>
      <div className={`local-training-verdict ${verdict.tone}`}>
        <strong>{verdict.title}</strong>
        <small>{verdict.detail}</small>
      </div>
      {!frontierComparison && (
        <div className="frontier-comparison-prompt" aria-live="polite" aria-busy={comparingFrontier}>
          <div>
            <span>Frontier reference</span>
            <strong>Compare with GLM 5.2 on the same {state.result.heldout.row_count.toLocaleString()} test examples</strong>
            <small>
              Only held-out test examples are sent through Understudy; training examples stay on this Mac. Fireworks publishes zero data retention for GLM 5.2. Maximum approved spend: $1.00.
            </small>
            {frontierEvent?.message && <p>{frontierEvent.message}</p>}
            {frontierEvent?.current !== undefined && frontierEvent.total !== undefined && (
              <code>{frontierEvent.current} of {frontierEvent.total} comparison batches</code>
            )}
            {frontierError && <em>{frontierError}</em>}
          </div>
          <button type="button" className="btn primary" onClick={compareWithFrontier} disabled={comparingFrontier}>
            {comparingFrontier ? "Comparing…" : frontierError ? "Try frontier again · max $1" : "Compare with GLM 5.2 · max $1"}
          </button>
        </div>
      )}
      {frontierComparison && frontierComparison.heldout.weakest_classes[0] && state.result.heldout.weakest_classes[0] && (
        <EvaluationRadar
          accuracy={state.result.heldout.accuracy}
          macroF1={state.result.heldout.macro_f1}
          baselineAccuracy={state.result.linear_baseline.accuracy}
          baselineMacroF1={state.result.linear_baseline.macro_f1}
          weakestClass={state.result.heldout.weakest_classes[0]}
          latencyMs={state.result.heldout.latency_ms_p50}
          modelSizeBytes={state.result.model.size_bytes}
          failureCount={state.result.heldout.failure_count}
          rowCount={state.result.heldout.row_count}
          completedRuns={1}
          requiredRuns={2}
          frontier={{
            name: "GLM 5.2",
            accuracy: frontierComparison.heldout.accuracy,
            macroF1: frontierComparison.heldout.macro_f1,
            weakestClass: frontierComparison.heldout.weakest_classes[0],
            latencyMs: frontierComparison.heldout.latency_ms_p50,
            failureCount: frontierComparison.heldout.failure_count,
            rowCount: frontierComparison.row_count,
            costUsd: frontierComparison.spend.attributed_cost_usd,
          }}
        />
      )}
      <div className="local-training-failures">
        <strong>Notable failures</strong>
        {state.result.heldout.failure_count === 0 ? (
          <small>No mistakes in {state.result.heldout.row_count} test examples.</small>
        ) : (
          <>
            {state.result.heldout.failures.slice(0, 3).map((failure) => (
              <span key={failure.example_id}>{failure.expected_label} → {failure.predicted_label}</span>
            ))}
            <small>
              {state.result.heldout.failure_count} mistakes in {state.result.heldout.row_count} test examples
              {state.result.heldout.failures_truncated ? " · showing a bounded sample" : ""}
            </small>
          </>
        )}
      </div>
      {state.result.heldout.weakest_classes.length > 0 && (
        <div className="local-training-weakest">
          <strong>Hardest categories</strong>
          {state.result.heldout.weakest_classes.slice(0, 3).map((category) => (
            <span key={category.label}>
              {category.label} · found {percent(category.recall)} · {category.support} test examples
            </span>
          ))}
        </div>
      )}
      <form
        className="local-training-predict"
        onSubmit={(event) => {
          event.preventDefault();
          predict();
        }}
      >
        <label htmlFor={`example-${state.result.run_id}`}>Try a new example</label>
        <div>
          <input
            id={`example-${state.result.run_id}`}
            value={predictionText}
            maxLength={4_000}
            onChange={(event) => {
              setPredictionText(event.target.value);
              setPrediction(null);
              setPredictionError(null);
            }}
            placeholder="Enter new text for this classifier"
          />
          <button type="submit" className="btn primary" disabled={!predictionText.trim() || predicting}>
            {predicting ? "Classifying…" : "Classify"}
          </button>
        </div>
        {prediction && (
          <output>
            <strong>{prediction.label}</strong>
            {topScore && <span>{percent(topScore.score)} confidence</span>}
            <small>Predicted locally with {modelName}</small>
            {confidenceWarning && <em>{confidenceWarning}</em>}
          </output>
        )}
        {predictionError && <p role="alert">{predictionError}</p>}
      </form>
    </div>
  );
}
