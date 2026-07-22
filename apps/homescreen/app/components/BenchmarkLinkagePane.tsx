"use client";

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  benchmarkLinkageState,
  relevantRunRequest,
  type BenchmarkBridgeStatus,
} from "../lib/experiment-bridge.mjs";

type ArtifactRef = { kind: string; ref: string; sha256: string };

type Props = {
  /** The dropped workload's artifact root (owns <root>/benchmark by convention). */
  artifactRoot: string;
  /** Completed training run manifest — the source of the local-arm artifact. */
  runManifestPath: string;
  /** Where the experiment record lives (dataset/plan dir), for run linkage. */
  lineageDir: string | null;
  experimentId: string | null;
  /** Incumbent gateway model for the calibration arm. */
  incumbentModel?: string;
  armLabel: string;
};

/**
 * Benchmark linkage for a completed training run. Feature-detected end to
 * end: if `<artifactRoot>/benchmark` exists, "Compare on benchmark" queues a
 * run request (trained artifact as a local arm + the incumbent + the
 * majority-class floor) through the existing file queue and shows its status;
 * if the CLI has grown `benchmarks from-dataset`, the benchmark can be built
 * right here; otherwise this renders the honest entrance-landing state. The
 * app never executes benchmark runs — `understudy runs execute --watch` does.
 */
export function BenchmarkLinkagePane({
  artifactRoot,
  runManifestPath,
  lineageDir,
  experimentId,
  incumbentModel = "glm-5.2",
  armLabel,
}: Props) {
  const [bridge, setBridge] = useState<BenchmarkBridgeStatus | null>(null);
  const [artifact, setArtifact] = useState<ArtifactRef | null>(null);
  const [probeDone, setProbeDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queuedRun, setQueuedRun] = useState<Record<string, unknown> | null>(null);
  const [runStatus, setRunStatus] = useState<Record<string, unknown> | null>(null);

  const probe = useCallback(() => {
    let cancelled = false;
    void Promise.allSettled([
      invoke<BenchmarkBridgeStatus>("benchmark_bridge_status", { artifactRoot }),
      invoke<ArtifactRef>("training_artifact_ref", { runManifestPath }),
    ]).then(([bridgeResult, artifactResult]) => {
      if (cancelled) return;
      setBridge(bridgeResult.status === "fulfilled" ? bridgeResult.value : null);
      setArtifact(artifactResult.status === "fulfilled" ? artifactResult.value : null);
      setProbeDone(true);
    });
    return () => {
      cancelled = true;
    };
  }, [artifactRoot, runManifestPath]);

  useEffect(() => probe(), [probe]);

  // Poll the queue-file status while a run request is in flight.
  useEffect(() => {
    if (!queuedRun || !bridge?.benchmark_dir) return;
    const runId = String(queuedRun.run_id ?? "");
    const read = () => {
      void invoke<Record<string, unknown>[]>("benchmark_run_requests", {
        benchmarkDir: bridge.benchmark_dir,
      })
        .then((requests) => {
          const mine = (Array.isArray(requests) ? requests : []).find(
            (request) => request.run_id === runId,
          );
          setRunStatus(mine ?? relevantRunRequest(requests, experimentId));
        })
        .catch(() => {
          // Status is read-only context; the queued request file still stands.
        });
    };
    read();
    const timer = window.setInterval(read, 5_000);
    return () => window.clearInterval(timer);
  }, [bridge, experimentId, queuedRun]);

  const buildBenchmark = () => {
    setBusy(true);
    setError(null);
    void invoke("create_benchmark_from_dataset", { artifactRoot })
      .then(() => probe())
      .catch((cause) => setError(String(cause)))
      .finally(() => setBusy(false));
  };

  const queueComparison = () => {
    if (!bridge?.benchmark_dir || !artifact) return;
    setBusy(true);
    setError(null);
    void invoke<Record<string, unknown>>("queue_benchmark_comparison_run", {
      benchmarkDir: bridge.benchmark_dir,
      localArmLabel: armLabel,
      localArmRef: artifact.ref,
      incumbentModel,
      experimentId,
      lineageDir,
    })
      .then(setQueuedRun)
      .catch((cause) => setError(String(cause)))
      .finally(() => setBusy(false));
  };

  if (!probeDone) return null;
  const state = benchmarkLinkageState(bridge, artifact);

  if (queuedRun) {
    const status = String(runStatus?.status ?? queuedRun.status ?? "queued");
    return (
      <div className="benchmark-linkage" aria-live="polite">
        <header>
          <span>Benchmark comparison</span>
          <strong>Run {String(queuedRun.run_id ?? "")} · {status}</strong>
        </header>
        <small>
          Arms: {armLabel} (your trained model, served locally) vs {incumbentModel} (incumbent) vs the
          majority-class floor. Execute with <code>understudy runs execute --benchmark {bridge?.benchmark_dir} --watch</code>.
        </small>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  }

  if (state.kind === "ready") {
    return (
      <div className="benchmark-linkage">
        <header>
          <span>Benchmark</span>
          <strong>Compare this model where it counts</strong>
        </header>
        <small>
          Queues your trained model as a local arm next to {incumbentModel} and the majority-class
          floor on this dataset&apos;s benchmark. Nothing runs in the app; the request lands in the
          benchmark&apos;s file queue.
        </small>
        <div className="remote-training-actions">
          <button type="button" className="btn primary" onClick={queueComparison} disabled={busy}>
            {busy ? "Queueing…" : "Compare on benchmark"}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  }

  if (state.kind === "no_artifact") {
    return (
      <div className="benchmark-linkage is-landing">
        <header>
          <span>Benchmark</span>
          <strong>This run can&apos;t take a benchmark arm yet</strong>
        </header>
        <small>
          A benchmark exists for this dataset, but this training run produced no locally servable
          model artifact. Local SFT runs (LoRA adapters) can enter as an arm.
        </small>
      </div>
    );
  }

  if (state.kind === "buildable") {
    return (
      <div className="benchmark-linkage is-landing">
        <header>
          <span>Benchmark</span>
          <strong>No benchmark for this dataset yet</strong>
        </header>
        <small>Your CLI can build one from the prepared dataset — frozen splits and all.</small>
        <div className="remote-training-actions">
          <button type="button" className="btn secondary" onClick={buildBenchmark} disabled={busy}>
            {busy ? "Building…" : "Build benchmark from this dataset"}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div className="benchmark-linkage is-landing">
      <header>
        <span>Benchmark</span>
        <strong>No benchmark for this dataset yet</strong>
      </header>
      <small>
        When this dataset gets a benchmark (an upcoming <code>understudy benchmarks from-dataset</code>{" "}
        can build one), trained models will be comparable here against the incumbent and a
        majority-class floor — same splits, same scoring.
      </small>
    </div>
  );
}
