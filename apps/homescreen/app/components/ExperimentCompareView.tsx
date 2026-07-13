"use client";

import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import {
  comparisonNextAction,
  listMatchedComparisons,
} from "../lib/experiment-comparison.mjs";

type BenchmarkCandidate = {
  id: string;
  label: string;
  route: string;
  model_hint: string;
  description: string;
};

type BenchmarkSuite = {
  id: string;
  label: string;
  description: string;
  task_ids: string[];
};

type BenchmarkMatrix = {
  schema_version: string;
  suites: BenchmarkSuite[];
  candidates: BenchmarkCandidate[];
};

type PlanRow = {
  task_id: string;
  mode: string;
  model: string;
  ready: boolean;
  reason: string;
};

type MatrixRun = {
  run_id: string;
  suite: string;
  dry_run: boolean;
  rows: number;
  candidates: Array<{ candidate: string; run: { rows: PlanRow[] } }>;
};

type BenchmarkRow = {
  id: number;
  run_id: string;
  capture_run_id?: string | null;
  runtime_backend: string;
  task_id: string;
  mode: string;
  model: string;
  elapsed_ms?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  score?: number | null;
  status: string;
  cost_usd?: number | null;
  harness_sha256?: string | null;
  split_sha256?: string | null;
};

type ComparisonCandidate = {
  candidate_id: string;
  label: string;
  run_id: string;
  rows: number;
  executed: number;
  ok_rows: number;
  error_rows: number;
  skipped_rows: number;
  terminal_rows: number;
  score_coverage: number;
  capture_coverage: number;
  avg_score: number | null;
  avg_latency_ms: number | null;
  avg_tokens: number | null;
  cost_usd: number | null;
  models: string[];
  task_mode_keys: string[];
  runtime_backends: string[];
};

type MatchedComparison = {
  parent_run_id: string;
  newest_id: number;
  candidates: ComparisonCandidate[];
  matched_slice: boolean;
  harness_sha256: string | null;
  split_sha256: string | null;
  promotion_ready: boolean;
  blockers: string[];
  winner_id: string | null;
};

type BenchmarkEvent =
  | { type: "RunStarted"; run_id: string; rows: number }
  | { type: "RowStarted"; task_id: string; candidate: string }
  | { type: "RowFinished"; task_id: string; candidate: string; status: string }
  | { type: "RunFinished"; run_id: string; rows: number }
  | { type: "Error"; message: string };

const LOCAL_CANDIDATES = ["local-main", "local-fast"];
const DIRECT_MODE = ["main-only"];
const VISIBLE_SUITES = new Set(["local-fusion-smoke", "local-comparison"]);

function fmtPercent(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function fmtNumber(value: number | null, suffix = "") {
  return value == null ? "—" : `${Math.round(value).toLocaleString()}${suffix}`;
}

function shortModel(value: string | undefined) {
  if (!value) return "not recorded";
  const tail = value.split("/").at(-1) ?? value;
  return tail.length > 30 ? `${tail.slice(0, 29)}…` : tail;
}

function comparisonStatus(comparison: MatchedComparison | null) {
  if (!comparison) return "no evidence";
  if (comparison.promotion_ready) return "promotion-grade";
  if (comparison.matched_slice) return "directional";
  return "not comparable";
}

export function ExperimentCompareView({ onReview }: { onReview: () => void }) {
  const [matrix, setMatrix] = useState<BenchmarkMatrix | null>(null);
  const [rows, setRows] = useState<BenchmarkRow[]>([]);
  const [suite, setSuite] = useState("local-fusion-smoke");
  const [phase, setPhase] = useState<"idle" | "preflight" | "running" | "exporting">("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: "" });
  const [exportPath, setExportPath] = useState<string | null>(null);

  const localCandidateRows = useMemo(
    () => matrix?.candidates.filter((candidate) => LOCAL_CANDIDATES.includes(candidate.id)) ?? [],
    [matrix],
  );
  const comparisons = useMemo(
    () => listMatchedComparisons(rows, localCandidateRows) as MatchedComparison[],
    [rows, localCandidateRows],
  );
  const latest = comparisons[0] ?? null;
  const next = comparisonNextAction(latest) as { title: string; body: string };
  const visibleSuites = matrix?.suites.filter((item) => VISIBLE_SUITES.has(item.id)) ?? [];

  const refresh = async () => {
    const [nextMatrix, nextRows] = await Promise.all([
      invoke<BenchmarkMatrix>("fusion_benchmark_matrix"),
      invoke<BenchmarkRow[]>("fusion_benchmark_results", { limit: 500 }),
    ]);
    setMatrix(nextMatrix);
    setRows(nextRows);
  };

  useEffect(() => {
    void refresh().catch((cause) => setError(String(cause)));
  }, []);

  const runComparison = async () => {
    if (phase !== "idle") return;
    setPhase("preflight");
    setError(null);
    setExportPath(null);
    setProgress({ done: 0, total: 0, label: "Checking both local models…" });
    const request = {
      suite,
      candidates: LOCAL_CANDIDATES,
      modes: DIRECT_MODE,
      dry_run: true,
      record_skips: false,
    };
    try {
      const plan = await invoke<MatrixRun>("run_fusion_benchmark_matrix", { request });
      const planRows = plan.candidates.flatMap((candidate) => candidate.run.rows);
      const blockers = [...new Set(planRows.filter((row) => !row.ready).map((row) => row.reason))];
      if (blockers.length) {
        throw new Error(`Load distinct main and fast local models first (${blockers.join(", ")}).`);
      }
      const models = plan.candidates.map((candidate) => ({
        candidate: candidate.candidate,
        models: [...new Set(candidate.run.rows.map((row) => row.model))],
      }));
      const mainModel = models.find((row) => row.candidate === "local-main")?.models[0];
      const fastModel = models.find((row) => row.candidate === "local-fast")?.models[0];
      if (!mainModel || !fastModel || mainModel === fastModel) {
        throw new Error("Load a distinct fast model; this plan would compare the same model twice.");
      }

      setPhase("running");
      const channel = new Channel<BenchmarkEvent>();
      channel.onmessage = (event) => {
        if (event.type === "RunStarted") {
          setProgress({ done: 0, total: event.rows, label: "Running the same frozen slice…" });
        } else if (event.type === "RowStarted") {
          setProgress((current) => ({ ...current, label: `${event.candidate} · ${event.task_id}` }));
        } else if (event.type === "RowFinished") {
          setProgress((current) => ({ ...current, done: Math.min(current.total, current.done + 1) }));
        } else if (event.type === "Error") {
          setError(event.message);
        }
      };
      await invoke<MatrixRun>("run_fusion_benchmark_matrix_live", {
        request: { ...request, dry_run: false, record_skips: true },
        onEvent: channel,
      });
      await refresh();
      setProgress((current) => ({ ...current, done: current.total, label: "Comparison captured." }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPhase("idle");
    }
  };

  const exportEvidence = async () => {
    if (phase !== "idle") return;
    setPhase("exporting");
    setError(null);
    try {
      const result = await invoke<{ path: string }>("export_fusion_benchmark_comparison", {
        request: { limit: 500, output_path: null },
      });
      setExportPath(result.path);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPhase("idle");
    }
  };

  const progressPercent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <main className="experiment-compare">
      <header className="experiment-compare-topbar">
        <div>
          <span>Experiments</span>
          <strong>Model comparison</strong>
        </div>
        <div className="experiment-loop" aria-label="Experiment loop">
          <button type="button" onClick={onReview}>1 · Review</button>
          <b>2 · Compare</b>
          <span>3 · Improve</span>
        </div>
        <nav>
          <button type="button" onClick={onReview}>Review decisions</button>
          <button type="button" disabled={!latest || phase !== "idle"} onClick={() => void exportEvidence()}>
            {phase === "exporting" ? "Exporting…" : "Export evidence"}
          </button>
        </nav>
      </header>

      <section className="experiment-compare-body">
        <article className="experiment-run-card">
          <div className="experiment-kicker">One fair question</div>
          <h2>Can the fast local model replace the main model?</h2>
          <p>Same frozen tasks, direct model calls, no cloud traffic, and one shared run identity.</p>
          <label>
            <span>Difficulty</span>
            <select value={suite} onChange={(event) => setSuite(event.target.value)} disabled={phase !== "idle"}>
              {visibleSuites.map((item) => (
                <option value={item.id} key={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <button className="experiment-run-primary" type="button" disabled={phase !== "idle" || !matrix} onClick={() => void runComparison()}>
            {phase === "preflight" ? "Checking models…" : phase === "running" ? "Comparing…" : "Compare local models"}
          </button>
          <small>Preflight fails closed if the models are missing, identical, or not warm.</small>

          {(phase === "running" || progress.total > 0) && (
            <div className="experiment-live-progress">
              <div><span>{progress.label}</span><em>{progress.done}/{progress.total}</em></div>
              <i><b style={{ width: `${progressPercent}%` }} /></i>
            </div>
          )}

          <div className="experiment-ledger">
            <div><strong>Recent matched runs</strong><span>{comparisons.length}</span></div>
            {comparisons.slice(0, 3).map((comparison) => (
              <div className="experiment-ledger-row" key={comparison.parent_run_id}>
                <span>{comparison.parent_run_id}</span>
                <em>{comparisonStatus(comparison)}</em>
              </div>
            ))}
            {!comparisons.length && <p>No comparison evidence yet.</p>}
          </div>
        </article>

        <article className="experiment-result-card">
          <header>
            <div>
              <span>Latest evidence</span>
              <strong>{latest?.parent_run_id ?? "No matched run yet"}</strong>
            </div>
            <em className={latest?.promotion_ready ? "ready" : latest?.matched_slice ? "directional" : "blocked"}>
              {comparisonStatus(latest)}
            </em>
          </header>

          {latest ? (
            <>
              <div className="experiment-candidates">
                {latest.candidates.map((candidate) => (
                  <section className={candidate.candidate_id === latest.winner_id ? "winner" : ""} key={candidate.candidate_id}>
                    <header>
                      <div><span>{candidate.candidate_id === "local-fast" ? "Candidate" : "Baseline"}</span><strong>{candidate.label}</strong></div>
                      {candidate.candidate_id === latest.winner_id && <em>best on slice</em>}
                    </header>
                    <code>{shortModel(candidate.models[0])}</code>
                    <dl>
                      <div><dt>Quality</dt><dd>{fmtPercent(candidate.avg_score)}</dd></div>
                      <div><dt>Latency</dt><dd>{fmtNumber(candidate.avg_latency_ms, " ms")}</dd></div>
                      <div><dt>Tokens</dt><dd>{fmtNumber(candidate.avg_tokens)}</dd></div>
                      <div><dt>Captured</dt><dd>{fmtPercent(candidate.capture_coverage)}</dd></div>
                    </dl>
                    <small>{candidate.ok_rows} ok · {candidate.error_rows} errors · {candidate.skipped_rows} skipped</small>
                  </section>
                ))}
              </div>
              <div className="experiment-evidence-gate">
                <div><span>Same task + mode slice</span><strong>{latest.matched_slice ? "yes" : "no"}</strong></div>
                <div><span>Canonical capture coverage</span><strong>{latest.candidates.every((candidate) => candidate.capture_coverage === 1) ? "100%" : "incomplete"}</strong></div>
                <div><span>Matching immutable hashes</span><strong>{latest.harness_sha256 && latest.split_sha256 ? "yes" : "missing"}</strong></div>
              </div>
              {latest.blockers.length > 0 && <p className="experiment-directional-note">{latest.blockers[0]}</p>}
            </>
          ) : (
            <div className="experiment-empty-result">
              <strong>Start with the local smoke.</strong>
              <p>Four direct rows answer the first question without uploading data or contacting a cloud model.</p>
            </div>
          )}
        </article>
      </section>

      <footer className="experiment-next-action">
        <div><span>Next</span><strong>{next.title}</strong><p>{next.body}</p></div>
        <span className={latest?.promotion_ready ? "ready" : "closed"}>
          {latest?.promotion_ready ? "ready for improvement handoff" : "promotion gate closed"}
        </span>
      </footer>

      {(error || exportPath) && (
        <div className={`experiment-notice${error ? " error" : ""}`} role={error ? "alert" : "status"}>
          {error ?? `Evidence exported to ${exportPath}`}
        </div>
      )}
    </main>
  );
}
