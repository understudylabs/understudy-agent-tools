"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  INITIAL_LOCAL_TRAINING_STATE,
  isLocalTrainingActive,
  localPredictionConfidence,
  localTrainingPhaseCopy,
  localTrainingProgress,
  localTrainingReducer,
  localTrainingVerdict,
  type LocalTrainingEvent,
  type LocalTrainingState,
} from "../lib/local-training-state.mjs";

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
  local_only: true;
};

type Props = {
  datasetManifestPath: string;
  onActiveChange?: (active: boolean) => void;
};

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function compactBytes(bytes: number): string {
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  if (bytes < 1_024 * 1_024 * 1_024) return `${(bytes / (1_024 * 1_024)).toFixed(0)} MB`;
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(1)} GB`;
}

function runId(): string {
  return `desktop-${crypto.randomUUID()}`;
}

export function LocalTrainingPanel({ datasetManifestPath, onActiveChange }: Props) {
  const [state, dispatch] = useReducer(
    localTrainingReducer<ClassificationTrainingRun>,
    INITIAL_LOCAL_TRAINING_STATE as LocalTrainingState<ClassificationTrainingRun>,
  );
  const [predictionText, setPredictionText] = useState("");
  const [prediction, setPrediction] = useState<ClassificationPrediction | null>(null);
  const [predictionError, setPredictionError] = useState<string | null>(null);
  const [predicting, setPredicting] = useState(false);
  const generation = useRef(0);
  const activeRunId = useRef<string | null>(null);
  const cancellationRequested = useRef(false);
  const active = isLocalTrainingActive(state);
  const phaseCopy = localTrainingPhaseCopy(state.phase);
  const measuredProgress = localTrainingProgress(state.event);

  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  useEffect(() => () => onActiveChange?.(false), [onActiveChange]);

  useEffect(() => {
    generation.current += 1;
    const run = activeRunId.current;
    activeRunId.current = null;
    cancellationRequested.current = false;
    if (run) void invoke("cancel_local_classification_training", { runId: run });
    dispatch({ type: "reset" });
    setPredictionText("");
    setPrediction(null);
    setPredictionError(null);
  }, [datasetManifestPath]);

  useEffect(() => () => {
    const run = activeRunId.current;
    if (run) void invoke("cancel_local_classification_training", { runId: run });
  }, []);

  const startTraining = () => {
    if (active) return;
    const id = runId();
    const requestGeneration = generation.current + 1;
    generation.current = requestGeneration;
    activeRunId.current = id;
    cancellationRequested.current = false;
    setPrediction(null);
    setPredictionError(null);
    dispatch({ type: "start", runId: id });
    const channel = new Channel<LocalTrainingEvent>();
    channel.onmessage = (event) => {
      if (generation.current === requestGeneration) dispatch({ type: "phase", event });
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
  };

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

  if (state.phase === "idle") {
    return (
      <div className="local-training-start">
        <button type="button" className="btn primary" onClick={startTraining}>
          Train a local model
        </button>
      </div>
    );
  }

  if (active && phaseCopy) {
    return (
      <div className="local-training-running" aria-live="polite" aria-busy="true">
        <span className="local-training-pulse" aria-hidden="true" />
        <div>
          <strong>{phaseCopy[0]}</strong>
          <small>{state.event?.message || phaseCopy[1]}</small>
          {measuredProgress && <code>{measuredProgress}</code>}
        </div>
        <button type="button" className="btn ghost" onClick={cancelTraining} disabled={state.phase === "cancelling"}>
          {state.phase === "cancelling" ? "Stopping…" : "Cancel"}
        </button>
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
          <strong>Local classifier evaluated</strong>
          <small>Held-out rows share no normalized {state.result.split_evidence.group_key} groups with training.</small>
        </div>
        <span>{(state.result.timings_ms.total / 1_000).toFixed(1)}s</span>
      </div>
      <div className={`local-training-verdict ${verdict.tone}`}>
        <strong>{verdict.title}</strong>
        <small>{verdict.detail}</small>
      </div>
      <div className="local-training-metrics" aria-label="Held-out evaluation">
        <div><span>Accuracy</span><b>{percent(state.result.heldout.accuracy)}</b><small>TF-IDF {percent(state.result.linear_baseline.accuracy)}</small></div>
        <div><span>Macro-F1</span><b>{percent(state.result.heldout.macro_f1)}</b><small>TF-IDF {percent(state.result.linear_baseline.macro_f1)}</small></div>
        <div><span>Latency</span><b>{state.result.heldout.latency_ms_p50.toFixed(1)} ms</b><small>median local inference</small></div>
        <div><span>Model</span><b>{compactBytes(state.result.model.size_bytes)}</b><small>{state.result.model.resolved_id}</small></div>
      </div>
      <div className="local-training-failures">
        <strong>Notable failures</strong>
        {state.result.heldout.failure_count === 0 ? (
          <small>No errors in {state.result.heldout.row_count} held-out rows.</small>
        ) : (
          <>
            {state.result.heldout.failures.slice(0, 3).map((failure) => (
              <span key={failure.example_id}>{failure.expected_label} → {failure.predicted_label}</span>
            ))}
            <small>
              {state.result.heldout.failure_count} of {state.result.heldout.row_count} held-out rows
              {state.result.heldout.failures_truncated ? " · showing a bounded sample" : ""}
            </small>
          </>
        )}
      </div>
      {state.result.heldout.weakest_classes.length > 0 && (
        <div className="local-training-weakest">
          <strong>Weakest categories</strong>
          {state.result.heldout.weakest_classes.slice(0, 3).map((category) => (
            <span key={category.label}>
              {category.label} · {percent(category.recall)} recall · {category.support} rows
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
        <label htmlFor={`expense-${state.result.run_id}`}>Try a new expense</label>
        <div>
          <input
            id={`expense-${state.result.run_id}`}
            value={predictionText}
            maxLength={4_000}
            onChange={(event) => {
              setPredictionText(event.target.value);
              setPrediction(null);
              setPredictionError(null);
            }}
            placeholder="e.g. ACME Coffee · client meeting · $18.40"
          />
          <button type="submit" className="btn primary" disabled={!predictionText.trim() || predicting}>
            {predicting ? "Classifying…" : "Classify"}
          </button>
        </div>
        {prediction && (
          <output>
            <strong>{prediction.label}</strong>
            {topScore && <span>{percent(topScore.score)} confidence</span>}
            <small>Predicted locally with {prediction.model_id}</small>
            {confidenceWarning && <em>{confidenceWarning}</em>}
          </output>
        )}
        {predictionError && <p role="alert">{predictionError}</p>}
      </form>
    </div>
  );
}
