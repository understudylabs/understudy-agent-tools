"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";

import {
  abandonedPatch,
  concludedPatch,
  sftVerdict,
  trainingExperimentInput,
  type ExperimentDataSelection,
  type ExperimentRecord,
} from "../lib/experiment-bridge.mjs";
import { BenchmarkLinkagePane } from "./BenchmarkLinkagePane";
import { ExperimentLineageCard } from "./ExperimentLineageCard";
import type { RemotePlan } from "./RemoteTrainingPanel";
import type { TrainingHaloVisual } from "./TrainingHalo";

type LocalSftPhaseEvent = {
  type: "phase";
  run_id: string;
  phase: "preparing" | "baseline" | "training" | "evaluating" | "saving";
  message: string;
  current?: number;
  total?: number;
};

type LocalSftResult = {
  schema_version: "understudy.local_sft.run.v1";
  run_id: string;
  outcome: "improved" | "no_improvement";
  recipe_id: string;
  evaluator: string;
  baseline: { examples: number; correct: number; score: number; heldout_sha256: string };
  heldout: { examples: number; correct: number; score: number; heldout_sha256: string };
  improvement: { correct_delta: number; absolute_score_delta: number; improved: boolean };
  cost: { actual_usd: 0; provider_spend_incurred: false };
  runtime: { elapsed_seconds: number; network_policy: "offline" };
  privacy: { provider_upload_performed: false; remote_job_created: false; telemetry_sent: false };
  promotion: { status: "promoted" | "needs_work" };
  manifest_path: string;
};

type Props = {
  plan: RemotePlan;
  modelName: string;
  onTrainRemote?: () => void;
  onActiveChange: (active: boolean) => void;
  onVisualChange: (visual: TrainingHaloVisual | null) => void;
};

function displayScore(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

export function LocalSftTrainingPanel({ plan, modelName, onTrainRemote, onActiveChange, onVisualChange }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<LocalSftPhaseEvent | null>(null);
  const [result, setResult] = useState<LocalSftResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [experiment, setExperiment] = useState<ExperimentRecord | null>(null);
  const [lineageError, setLineageError] = useState<string | null>(null);
  const runId = useRef(crypto.randomUUID());
  const generation = useRef(0);
  const startedKey = useRef("");
  const lineage = useRef<{ dir: string; experimentId: string } | null>(null);

  /** Append the terminal status/verdict (+ produced adapter) to the record. */
  const concludeExperiment = useCallback(
    (currentGeneration: number, patch: Record<string, unknown>) => {
      const target = lineage.current;
      if (!target) return;
      void invoke<ExperimentRecord>("update_training_experiment", {
        lineageDir: target.dir,
        experimentId: target.experimentId,
        patch,
      })
        .then((record) => {
          if (generation.current === currentGeneration) setExperiment(record);
        })
        .catch((cause) => {
          if (generation.current === currentGeneration) setLineageError(String(cause));
        });
    },
    [],
  );

  const start = useCallback(() => {
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    runId.current = crypto.randomUUID();
    setPhase(null);
    setResult(null);
    setError(null);
    setRunning(true);
    // Experiment lineage from the prepared plan's own hashes (see
    // LocalTrainingPanel): evidence for local runs, never a gate.
    setExperiment(null);
    setLineageError(null);
    lineage.current = null;
    void invoke<{ lineage_dir: string; data_selection: ExperimentDataSelection }>(
      "plan_lineage_context",
      { planPath: plan.plan_path },
    )
      .then((context) =>
        invoke<ExperimentRecord>("record_training_experiment", {
          lineageDir: context.lineage_dir,
          input: trainingExperimentInput({
            method: "lora",
            baseModel: plan.recipe_id,
            provider: "local",
            dataSelection: context.data_selection,
            config: {
              task_kind: plan.task_kind,
              epochs: plan.epochs,
              output_model_name: plan.output_model_name,
              run_id: runId.current,
            },
          }),
        }).then((record) => {
          if (generation.current !== currentGeneration) return;
          lineage.current = { dir: context.lineage_dir, experimentId: record.experiment_id };
          setExperiment(record);
        }),
      )
      .catch((cause) => {
        if (generation.current === currentGeneration) setLineageError(String(cause));
      });
    const channel = new Channel<LocalSftPhaseEvent>();
    channel.onmessage = (event) => {
      if (generation.current === currentGeneration) setPhase(event);
    };
    void invoke<LocalSftResult>("start_local_sft_training", {
      planPath: plan.plan_path,
      runId: runId.current,
      onEvent: channel,
    })
      .then((receipt) => {
        if (generation.current !== currentGeneration) return;
        setResult(receipt);
        setRunning(false);
        // Attach the produced adapter (when complete evidence exists) so the
        // benchmark local arm and the experiment record cite the same artifact.
        void invoke<{ kind: string; ref: string; sha256: string }>("training_artifact_ref", {
          runManifestPath: receipt.manifest_path,
        })
          .catch(() => null)
          .then((artifact) => {
            const complete = artifact && artifact.ref && artifact.sha256 ? artifact : null;
            concludeExperiment(currentGeneration, concludedPatch(sftVerdict(receipt), complete));
          });
      })
      .catch((cause) => {
        if (generation.current !== currentGeneration) return;
        setError(String(cause));
        setRunning(false);
        concludeExperiment(currentGeneration, abandonedPatch(`local SFT run failed: ${String(cause)}`));
      });
  }, [concludeExperiment, plan.plan_path]);

  useEffect(() => {
    const key = `${plan.plan_path}:${attempt}`;
    if (startedKey.current === key) return;
    startedKey.current = key;
    start();
  }, [attempt, plan.plan_path, start]);

  useEffect(() => {
    void invoke("compile_remote_training_backends", { planPath: plan.plan_path })
      .catch((cause) => setError(`Backend compatibility check failed: ${String(cause)}`));
  }, [plan.plan_path]);

  useEffect(() => {
    onActiveChange(running);
    if (!running && !result) {
      onVisualChange(null);
      return;
    }
    const trainingFraction = phase?.phase === "training" && phase.total
      ? Math.min(1, (phase.current ?? 0) / phase.total)
      : null;
    const visualPhase = result
      ? "completed"
      : phase?.phase === "baseline" || phase?.phase === "evaluating"
        ? "evaluating"
        : phase?.phase === "saving"
          ? "saving"
          : phase?.phase === "training"
            ? "training"
            : "preparing";
    onVisualChange({
      phase: visualPhase,
      epochs: Math.max(1, plan.epochs),
      completedEpochs: result ? Math.max(1, plan.epochs) : 0,
      stepFraction: trainingFraction,
      modelId: `mlx-local.${plan.recipe_id}`,
      modelName,
      done: Boolean(result),
    });
  }, [modelName, onActiveChange, onVisualChange, phase, plan.epochs, plan.recipe_id, result, running]);

  useEffect(() => () => {
    onActiveChange(false);
    onVisualChange(null);
  }, [onActiveChange, onVisualChange]);

  const cancel = () => {
    void invoke("cancel_local_sft_training", { runId: runId.current })
      .catch((cause) => setError(String(cause)));
  };

  if (running) {
    const progress = phase?.total ? `${phase.current ?? 0}/${phase.total}` : null;
    return (
      <div className="remote-training-running" aria-live="polite" aria-busy="true">
        <div>
          <span className="local-training-pulse" aria-hidden="true" />
          <div>
            <strong>{phase?.phase === "evaluating" ? "Evaluating" : phase?.phase === "training" ? "Training locally · $0" : "Preparing locally · $0"}</strong>
            <small>{progress ?? phase?.message ?? "Verifying the recipe and held-out split."}</small>
          </div>
          <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div className={`remote-training-result ${result.outcome === "improved" ? "promoted" : ""}`}>
        <div>
          <span>{result.outcome === "improved" ? "Improved locally" : "Measured locally"}</span>
          <strong>{displayScore(result.baseline.score)} → {displayScore(result.heldout.score)}</strong>
          <small>{result.improvement.correct_delta >= 0 ? "+" : ""}{result.improvement.correct_delta} correct · $0 · {result.runtime.elapsed_seconds.toFixed(1)}s</small>
        </div>
        <details className="remote-training-details">
          <summary>Run details</summary>
          <small>{result.evaluator} · same heldout {result.heldout.heldout_sha256.slice(0, 12)}…</small>
          <small>Promotion: {result.promotion.status === "promoted" ? "ready" : "needs another run"}</small>
          <small>Offline · no upload · receipt {result.manifest_path}</small>
        </details>
        <ExperimentLineageCard experiment={experiment} error={lineageError} />
        {lineage.current && (
          <BenchmarkLinkagePane
            artifactRoot={lineage.current.dir}
            runManifestPath={result.manifest_path}
            lineageDir={lineage.current.dir}
            experimentId={lineage.current.experimentId}
            armLabel={plan.output_model_name}
          />
        )}
        <div className="remote-training-actions">
          {onTrainRemote && <button type="button" className="btn primary" onClick={onTrainRemote}>Try cloud</button>}
          <button type="button" className="btn ghost" onClick={() => setAttempt((value) => value + 1)}>Run again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="remote-training-state failed" role="alert">
      <div><strong>Local training stopped</strong><small>{error ?? "The immutable plan is intact."}</small></div>
      <div className="remote-training-actions">
        {onTrainRemote && <button type="button" className="btn primary" onClick={onTrainRemote}>Try cloud</button>}
        <button type="button" className="btn ghost" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
      </div>
    </div>
  );
}
