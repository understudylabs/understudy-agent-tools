"use client";

import { useEffect, useMemo, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { PaneId } from "./Sidebar";

export type TrainingPaneId = Extract<
  PaneId,
  "training-evals" | "training-optimization" | "training-datasets" | "training-finetuning" | "training-rl" | "training-jobs"
>;

const TRAINING_PANES = new Set<PaneId>([
  "training-evals",
  "training-optimization",
  "training-datasets",
  "training-finetuning",
  "training-rl",
  "training-jobs",
]);

export function isTrainingPane(id: PaneId): id is TrainingPaneId {
  return TRAINING_PANES.has(id);
}

type Step = {
  title: string;
  body: string;
  state?: "ready" | "idle" | "blocked";
};

type FusionTask = {
  id: string;
  category: string;
  prompt: string;
  expected_signal: string;
};

type FusionSuite = {
  id: string;
  label: string;
  description: string;
  modes: string[];
  task_ids: string[];
};

type FusionCandidate = {
  id: string;
  label: string;
  route: string;
  model_hint: string;
  description: string;
};

type FusionMatrix = {
  schema_version: string;
  suites: FusionSuite[];
  candidates: FusionCandidate[];
  tasks: FusionTask[];
};

type FusionPlanRow = {
  route: string;
  task_id: string;
  mode: string;
  model: string;
  ready: boolean;
  reason: string;
};

type FusionMatrixRun = {
  run_id: string;
  suite: string;
  dry_run: boolean;
  rows: number;
  recorded_skips: number;
  candidates: { candidate: string; run: { rows: FusionPlanRow[] } }[];
};

type FusionRunModeSummary = {
  mode: string;
  rows: number;
  ok_rows: number;
  error_rows: number;
  skipped_rows: number;
  gateway_rows: number;
  local_rows: number;
  avg_score: number | null;
  avg_elapsed_ms: number | null;
  avg_total_tokens: number | null;
  avg_sidekick_runs: number;
  avg_sidekick_tool_calls: number;
  avg_local_mem_gb: number | null;
};

type FusionRunSummary = {
  runs: {
    run_id: string;
    rows: number;
    ok_rows: number;
    error_rows: number;
    skipped_rows: number;
    avg_score: number | null;
    best_mode: string | null;
    modes: FusionRunModeSummary[];
  }[];
};

type FusionRouteDecision = {
  id: number;
  prompt_excerpt: string;
  recommended_route: string;
  use_sidekick: boolean;
  escalate_gateway: boolean;
  upgrade_sidekick: boolean;
  reason: string;
  policy_class: string;
  main_model: string | null;
  sidekick_model: string | null;
  gateway_model: string | null;
  created_at: string;
};

type FusionLiveRow = {
  key: string;
  run_id: string;
  candidate: string;
  task_id: string;
  mode: string;
  route: string;
  model: string;
  prompt: string;
  expected_signal: string;
  status: "queued" | "running" | "ok" | "error" | "skipped" | "planned";
  score: number | null;
  elapsed_ms: number | null;
  sidekick_runs: number;
  sidekick_tool_calls: number;
  output: string;
  reason: string;
};

type FusionEvalEvent =
  | { type: "RunStarted"; run_id: string; suite: string; candidates: string[]; rows: number }
  | { type: "CandidateStarted"; run_id: string; candidate: string }
  | {
      type: "RowStarted";
      run_id: string;
      candidate: string;
      task_id: string;
      mode: string;
      route: string;
      model: string;
      prompt: string;
      expected_signal: string;
    }
  | {
      type: "RowFinished";
      run_id: string;
      candidate: string;
      task_id: string;
      mode: string;
      route: string;
      model: string;
      status: string;
      score: number | null;
      elapsed_ms: number | null;
      sidekick_runs: number;
      sidekick_tool_calls: number;
      output: string;
      reason: string;
    }
  | { type: "CandidateFinished"; run_id: string; candidate: string; rows: number }
  | { type: "RunFinished"; run_id: string; suite: string; rows: number; recorded_skips: number; avg_score: number | null }
  | { type: "Error"; run_id: string; message: string };

const SECTIONS: Record<TrainingPaneId, {
  title: string;
  sub: string;
  status: string;
  leadTitle: string;
  leadBody: string;
  steps: Step[];
}> = {
  "training-evals": {
    title: "Evals",
    sub: "Head-to-heads, local ladders, benchmark boards, and acceptance gates.",
    status: "first gate",
    leadTitle: "Compare before spending",
    leadBody: "Use evals to prove whether a candidate route, prompt, adapter, or RL policy actually beats the incumbent on the workload.",
    steps: [
      { title: "Local ladder", body: "Run base route, local candidate, and cloud fallback on the same split.", state: "ready" },
      { title: "Head-to-head", body: "Compare responses pairwise with a stable rubric and a held-out judge set.", state: "ready" },
      { title: "Promotion gate", body: "Lock the success metric, regression guard, latency target, and cost ceiling before routing traffic.", state: "idle" },
    ],
  },
  "training-optimization": {
    title: "Optimization",
    sub: "GEPA, prompt/program search, routing policies, and cheap improvement loops.",
    status: "cheap first",
    leadTitle: "Optimize the workflow before the weights",
    leadBody: "GEPA-style prompt and program optimization should be the default first move when traces already show a fixable policy gap.",
    steps: [
      { title: "GEPA candidate", body: "Mutate prompts, policies, or tool instructions against the eval split.", state: "ready" },
      { title: "Route policy", body: "Tune fallback, confidence, and best-of-N policy before committing to training.", state: "idle" },
      { title: "Proof packet", body: "Save candidate config, eval result, and regression notes as the promotion artifact.", state: "idle" },
    ],
  },
  "training-datasets": {
    title: "Datasets",
    sub: "Captured traces, filtered examples, reward data, preference pairs, and train/dev/test splits.",
    status: "artifact source",
    leadTitle: "Make examples reusable",
    leadBody: "Training only compounds if the traces are sanitized, split, versioned, and tied back to the eval gate they are meant to improve.",
    steps: [
      { title: "Capture", body: "Collect task traces, inputs, outputs, tool calls, and outcomes without secrets.", state: "ready" },
      { title: "Filter", body: "Remove bad labels, leaked data, duplicate prompts, and examples that teach the wrong behavior.", state: "idle" },
      { title: "Split", body: "Create train/dev/test or preference/reward splits with a stable manifest.", state: "idle" },
    ],
  },
  "training-finetuning": {
    title: "Fine-tuning",
    sub: "SFT, LoRA, adapter jobs, distillation, and supervised repair runs.",
    status: "after evals",
    leadTitle: "Train adapters when prompting plateaus",
    leadBody: "SFT belongs after evals show a repeatable gap and the dataset has enough clean examples to teach the missing behavior.",
    steps: [
      { title: "SFT packet", body: "Pick base model, adapter recipe, train/dev split, and budget fuse.", state: "blocked" },
      { title: "Small adapter", body: "Run the smallest LoRA job that can disprove the hypothesis.", state: "idle" },
      { title: "Regression board", body: "Compare adapter, base, and prompt-only candidate on the same gate.", state: "idle" },
    ],
  },
  "training-rl": {
    title: "RL",
    sub: "GRPO, RLVR, verifier-backed environments, reward modeling, and policy promotion.",
    status: "last rung",
    leadTitle: "Only run RL when the reward is real",
    leadBody: "RL needs a verifiable environment, a reward that cannot be gamed trivially, a baseline board, and explicit stop rules before spend.",
    steps: [
      { title: "Rewardability", body: "Confirm the task has objective checks, stable rubrics, or a verifier environment.", state: "blocked" },
      { title: "Environment package", body: "Freeze tools, data, scorer, and rollout protocol for reproducible training.", state: "idle" },
      { title: "Policy run", body: "Run a bounded GRPO/RLVR experiment and compare against SFT plus GEPA baselines.", state: "idle" },
    ],
  },
  "training-jobs": {
    title: "Jobs",
    sub: "Active and historical optimization, fine-tuning, RL, export, and evaluation jobs.",
    status: "idle",
    leadTitle: "No active jobs",
    leadBody: "Start with a captured workload, pick an eval gate, then move through optimization, dataset prep, and training only when needed.",
    steps: [
      { title: "Queued", body: "No local or hosted jobs are queued.", state: "idle" },
      { title: "Recent", body: "Completed jobs will show their proof packet, output artifact, and next recommended gate.", state: "idle" },
      { title: "Export", body: "Adapter, dataset, and verifier handoff packages will be staged here.", state: "idle" },
    ],
  },
};

export function TrainingPane({ section }: { section: TrainingPaneId }) {
  if (section === "training-evals") return <FusionEvaluationPane />;

  const current = SECTIONS[section];
  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">{current.title}</h1>
        <p className="pane-sub">{current.sub}</p>
      </div>

      <div className="pane-body">
        <div className="card">
          <div className="card-row">
            <div>
              <div className="card-title">{current.leadTitle}</div>
              <div className="card-sub">{current.leadBody}</div>
            </div>
            <span className="svc-state">{current.status}</span>
          </div>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 10 }}>Workflow</div>
          {current.steps.map((step) => (
            <TrainingStep key={step.title} title={step.title} body={step.body} state={step.state ?? "idle"} />
          ))}
        </div>
      </div>
    </>
  );
}

function FusionEvaluationPane() {
  const [matrix, setMatrix] = useState<FusionMatrix | null>(null);
  const [runSummary, setRunSummary] = useState<FusionRunSummary | null>(null);
  const [decisions, setDecisions] = useState<FusionRouteDecision[]>([]);
  const [plan, setPlan] = useState<FusionMatrixRun | null>(null);
  const [suite, setSuite] = useState("local-fusion-smoke");
  const [candidate, setCandidate] = useState("local-fast");
  const [busy, setBusy] = useState<"plan" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [liveSuite, setLiveSuite] = useState<string | null>(null);
  const [liveRows, setLiveRows] = useState<FusionLiveRow[]>([]);
  const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
  const [finishedScore, setFinishedScore] = useState<number | null>(null);

  const refresh = async () => {
    const [nextMatrix, nextSummary, nextDecisions] = await Promise.all([
      invoke<FusionMatrix>("fusion_benchmark_matrix"),
      invoke<FusionRunSummary>("fusion_benchmark_run_summary", { limit: 80 }),
      invoke<FusionRouteDecision[]>("fusion_route_decisions", { limit: 8 }),
    ]);
    setMatrix(nextMatrix);
    setRunSummary(nextSummary);
    setDecisions(nextDecisions);
  };

  useEffect(() => {
    refresh().catch((err) => setError(String(err)));
  }, []);

  const currentSuite = useMemo(
    () => matrix?.suites.find((item) => item.id === suite),
    [matrix, suite],
  );
  const environmentRows = useMemo(
    () => [
      {
        name: "Fusion local harness",
        state: "ready",
        desc: "Local questions, repeated attempts, route policy, sidekick telemetry, and persisted result rows.",
      },
      {
        name: "Prime Intellect verifiers",
        state: "standard",
        desc: "Verifier-backed environment family for objective tasks and scheduled larger runs.",
      },
      {
        name: "AutomationBench",
        state: "paused",
        desc: "Full public workflow benchmark. Resume after local rollout behavior is easy to inspect.",
      },
    ],
    [],
  );

  const invokeRun = async (dryRun: boolean) => {
    setBusy(dryRun ? "plan" : "run");
    setError(null);
    try {
      if (!dryRun) {
        const ch = new Channel<FusionEvalEvent>();
        ch.onmessage = (event) => {
          if (event.type === "RunStarted") {
            setLiveRunId(event.run_id);
            setLiveSuite(event.suite);
            setFinishedScore(null);
            setLiveRows([]);
            setActiveRowKey(null);
            return;
          }
          if (event.type === "RowStarted") {
            const key = `${event.candidate}:${event.task_id}:${event.mode}`;
            setActiveRowKey(key);
            setLiveRows((rows) => {
              const nextRow: FusionLiveRow = {
                key,
                run_id: event.run_id,
                candidate: event.candidate,
                task_id: event.task_id,
                mode: event.mode,
                route: event.route,
                model: event.model,
                prompt: event.prompt,
                expected_signal: event.expected_signal,
                status: "running",
                score: null,
                elapsed_ms: null,
                sidekick_runs: 0,
                sidekick_tool_calls: 0,
                output: "",
                reason: "",
              };
              const existing = rows.findIndex((row) => row.key === key);
              if (existing === -1) return [...rows, nextRow];
              return rows.map((row, index) => index === existing ? { ...row, ...nextRow } : row);
            });
            return;
          }
          if (event.type === "RowFinished") {
            const key = `${event.candidate}:${event.task_id}:${event.mode}`;
            setActiveRowKey(key);
            setLiveRows((rows) =>
              rows.map((row) =>
                row.key === key
                  ? {
                      ...row,
                      status: normalizeRowStatus(event.status),
                      score: event.score,
                      elapsed_ms: event.elapsed_ms,
                      sidekick_runs: event.sidekick_runs,
                      sidekick_tool_calls: event.sidekick_tool_calls,
                      output: event.output,
                      reason: event.reason,
                    }
                  : row,
              ),
            );
            return;
          }
          if (event.type === "RunFinished") {
            setFinishedScore(event.avg_score);
            setActiveRowKey(null);
            return;
          }
          if (event.type === "Error") {
            setError(event.message);
          }
        };
        const result = await invoke<FusionMatrixRun>("run_fusion_benchmark_matrix_live", {
          request: {
            suite,
            candidates: [candidate],
            dry_run: false,
            record_skips: true,
          },
          onEvent: ch,
        });
        setPlan(result);
        await refresh();
        return;
      }

      const result = await invoke<FusionMatrixRun>("run_fusion_benchmark_matrix", {
        request: {
          suite,
          candidates: [candidate],
          dry_run: dryRun,
          record_skips: !dryRun,
        },
      });
      setPlan(result);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };
  const activeRow = liveRows.find((row) => row.key === activeRowKey) ?? liveRows.at(-1) ?? null;
  const completedRows = liveRows.filter((row) => ["ok", "error", "skipped"].includes(row.status));
  const visibleScore =
    finishedScore ??
    (completedRows.length
      ? completedRows.reduce((sum, row) => sum + (row.score ?? 0), 0) / completedRows.length
      : null);

  return (
    <>
      <div className="pane-head">
        <h1 className="pane-title">Evals</h1>
        <p className="pane-sub">Verifier environments, local rollout runs, model comparisons, and failure analysis.</p>
      </div>

      <div className="pane-body evals-grid">
        <div className="card evals-hero">
          <div>
            <div className="card-title">Evaluation environments</div>
            <div className="card-sub">Run specific questions across candidates, persist attempts, and inspect where each model is strong or weak.</div>
          </div>
          <div className="evals-actions">
            <button className="btn" type="button" onClick={() => invokeRun(true)} disabled={busy !== null}>
              {busy === "plan" ? "Planning..." : "Plan run"}
            </button>
            <button className="btn primary" type="button" onClick={() => invokeRun(false)} disabled={busy !== null}>
              {busy === "run" ? "Running..." : "Run"}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Environment</div>
          <div className="env-list">
            {environmentRows.map((row) => (
              <div className="svc" key={row.name}>
                <span className={"dot " + (row.state === "ready" ? "running" : row.state === "paused" ? "loading" : "stopped")} />
                <div>
                  <div className="svc-name">{row.name}</div>
                  <div className="svc-desc">{row.desc}</div>
                </div>
                <span className="svc-state">{row.state}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-row">
            <div>
              <div className="card-title">Run setup</div>
              <div className="card-sub">{currentSuite?.description ?? "Choose a suite and candidate."}</div>
            </div>
            <span className="svc-state">{currentSuite?.task_ids.length || matrix?.tasks.length || 0} questions</span>
          </div>
          <div className="eval-controls">
            <label>
              Suite
              <select value={suite} onChange={(event) => setSuite(event.target.value)}>
                {matrix?.suites.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
            <label>
              Model
              <select value={candidate} onChange={(event) => setCandidate(event.target.value)}>
                {matrix?.candidates.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
          </div>
          {error && <div className="eval-error">{error}</div>}
        </div>

        {(busy === "run" || liveRows.length > 0) && (
          <div className="card evals-wide rollout-live">
            <div className="card-row">
              <div>
                <div className="card-title">Live rollout</div>
                <div className="card-sub">
                  {liveRunId ?? "Starting"} · {completedRows.length}/{liveRows.length || currentSuite?.task_ids.length || 0} rows
                </div>
              </div>
              <span className="score-pill">{visibleScore == null ? "scoring" : visibleScore.toFixed(2)}</span>
            </div>
            <div className="rollout-progress">
              <span style={{ width: `${progressPct(completedRows.length, liveRows.length || currentSuite?.task_ids.length || 1)}%` }} />
            </div>
            <div className="rollout-grid">
              <div className="rollout-queue">
                {liveRows.length ? liveRows.map((row) => (
                  <button
                    type="button"
                    className={"rollout-row " + row.status + (row.key === activeRow?.key ? " active" : "")}
                    key={row.key}
                    onClick={() => setActiveRowKey(row.key)}
                  >
                    <span>{row.task_id}</span>
                    <span>{row.mode}</span>
                    <strong>{row.score == null ? row.status : row.score.toFixed(2)}</strong>
                  </button>
                )) : (
                  <div className="svc-desc">Waiting for first row...</div>
                )}
              </div>
              <div className="rollout-detail">
                {activeRow ? (
                  <>
                    <div className="rollout-meta">
                      <span>{activeRow.candidate}</span>
                      <span>{activeRow.route}</span>
                      <span>{activeRow.elapsed_ms == null ? "running" : `${activeRow.elapsed_ms}ms`}</span>
                      <span>{activeRow.sidekick_runs ? `${activeRow.sidekick_runs} sidekick` : activeRow.mode}</span>
                    </div>
                    <div className="rollout-question">{activeRow.prompt}</div>
                    <div className="rollout-expected">{activeRow.expected_signal}</div>
                    <pre className="rollout-output">{activeRow.output || (activeRow.status === "running" ? "Generating..." : activeRow.reason)}</pre>
                  </>
                ) : (
                  <div className="svc-desc">Run a local smoke to watch the rollout and score row by row.</div>
                )}
              </div>
            </div>
          </div>
        )}

        {plan && (
          <div className="card evals-wide">
            <div className="card-row">
              <div>
                <div className="card-title">{plan.dry_run ? "Planned run" : "Executed run"}</div>
                <div className="card-sub">{plan.run_id} · {plan.rows} rows · {plan.recorded_skips} skips</div>
              </div>
              <span className="svc-state">{plan.suite}</span>
            </div>
            <div className="eval-table">
              {plan.candidates.flatMap((candidateRun) =>
                candidateRun.run.rows.slice(0, 8).map((row) => (
                  <div className="eval-row" key={`${candidateRun.candidate}-${row.task_id}-${row.mode}`}>
                    <span>{candidateRun.candidate}</span>
                    <span>{row.task_id}</span>
                    <span>{row.mode}</span>
                    <span>{row.route}</span>
                    <span className={row.ready ? "ok" : "warn"}>{row.ready ? "ready" : row.reason}</span>
                  </div>
                )),
              )}
            </div>
          </div>
        )}

        <div className="card evals-wide">
          <div className="card-title">Recent performance</div>
          {runSummary?.runs.length ? (
            <div className="eval-table">
              {runSummary.runs.slice(0, 6).map((run) => (
                <div className="eval-row" key={run.run_id}>
                  <span>{run.run_id}</span>
                  <span>{run.rows} rows</span>
                  <span>{run.ok_rows} ok</span>
                  <span>{run.error_rows} errors</span>
                  <span>{run.avg_score == null ? "unscored" : run.avg_score.toFixed(2)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="svc-desc">No persisted eval rows yet.</div>
          )}
        </div>

        <div className="card evals-wide">
          <div className="card-title">Route policy</div>
          {decisions.length ? (
            <div className="eval-table">
              {decisions.map((decision) => (
                <div className="eval-row" key={decision.id}>
                  <span>{decision.policy_class}</span>
                  <span>{decision.recommended_route}</span>
                  <span>{decision.use_sidekick ? "sidekick" : decision.upgrade_sidekick ? "upgrade sidekick" : decision.escalate_gateway ? "gateway" : "main"}</span>
                  <span>{decision.reason}</span>
                  <span>{decision.prompt_excerpt}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="svc-desc">No route decisions recorded yet.</div>
          )}
        </div>
      </div>
    </>
  );
}

function normalizeRowStatus(status: string): FusionLiveRow["status"] {
  if (status === "ok" || status === "error" || status === "skipped" || status === "planned") return status;
  return status.trim() ? "ok" : "error";
}

function progressPct(done: number, total: number): number {
  if (!total) return 0;
  return Math.max(4, Math.min(100, Math.round((done / total) * 100)));
}

function TrainingStep({ title, body, state }: { title: string; body: string; state: "ready" | "idle" | "blocked" }) {
  const dotClass = state === "ready" ? "running" : state === "blocked" ? "error" : "loading";
  return (
    <div className="svc">
      <span className={`dot ${dotClass}`} />
      <div>
        <div className="svc-name">{title}</div>
        <div className="svc-desc">{body}</div>
      </div>
      <span className="svc-state">{state}</span>
    </div>
  );
}
