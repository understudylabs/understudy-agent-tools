// `understudy benchmarks mcp` — stdio MCP server exposing the file-based
// benchmark artifacts (manifest.json/benchmark.json, tasks.jsonl,
// reviews.jsonl, rows-*.jsonl, runs/queue + runs/live) to a coding agent, so
// the agent can read failing rollouts, diff trajectories, review tasks, and
// queue runs — the Raindrop-Workshop-style operator loop.
//
// Every tool goes through the SAME shared modules the benchmark hub uses:
// loaders + write validation from ./benchmark-hub-core.js, run-request
// schema/queue from ./run-executor.js, contract accumulation from
// ./benchmark-replay.js. Nothing here executes models: queue_run only writes
// an understudy.run_request.v1 file; `understudy runs execute` / the daemon
// picks it up.
//
// All stdout is MCP protocol; diagnostics go to stderr only.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  applyAutoAccepts,
  createExperiment,
  deriveTaskAttention,
  effectiveDecision,
  experimentsSummary,
  getEntry,
  listExperiments,
  updateExperiment,
  loadHub,
  loadTaskSidecars,
  queueOrCancelRun,
  submitReview,
  submitTaskFeedback,
} from "./benchmark-hub-core.js";
import type { AnyHubEntry, CalibrationSummary, EvalRow, FoundryTask, ProposedHubEntry, ReviewDecision } from "./benchmark-hub-types.js";
import { REVIEW_DECISIONS, taskDisplayName } from "./benchmark-hub-types.js";
import { isAnomalousEvalRow, liveJournalPath, readRunRequest, runRequestPath, RUN_SPLITS } from "./run-executor.js";
import { accumulateReplay, type OracleReplay, type ReplayCall } from "./benchmark-replay.js";
import { compileCaptureImport } from "./capture-import.js";
import { compileDatasetFoundry, type DatasetFoundryOptions } from "./dataset-foundry.js";
import { formatRegradeDelta, regradeRuns } from "./regrade.js";

type Obj = Record<string, unknown>;
const asObject = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** Guard against unbounded journals/row files. */
const MAX_JOURNAL_LINES = 5_000;

class ToolError extends Error {}

/**
 * Point the loaders at the requested roots. Default (no extra roots, env
 * unset) is ~/.understudy/benchmarks — data-core's own default. Extra roots
 * are ADDED after the default, via the same colon-separated
 * BENCHMARK_HUB_DATA_DIR contract the hub honors.
 */
export function configureBenchmarksMcpRoots(extraRoots: string[]): void {
  if (extraRoots.length === 0) return;
  const defaults = process.env.BENCHMARK_HUB_DATA_DIR
    ? process.env.BENCHMARK_HUB_DATA_DIR.split(":").filter(Boolean)
    : [join(homedir(), ".understudy", "benchmarks")];
  process.env.BENCHMARK_HUB_DATA_DIR = [...defaults, ...extraRoots.map((r) => resolve(r))].join(":");
}

/* ---------------- shared summaries ---------------- */

function rowsSummary(rows: EvalRow[]): Obj {
  // Same trust discipline as the hub: anomaly-flagged rows never enter means —
  // they are counted (`anomalous`), never silently dropped.
  const clean = rows.filter((r) => !isAnomalousEvalRow(r));
  const scores = clean.map((r) => r.score).filter((s): s is number => typeof s === "number");
  const byModel: Record<
    string,
    { rows: number; mean_score: number | null; ok: number; error: number; anomalous: number; arm_kind: string | null }
  > = {};
  for (const r of rows) {
    const model = r.model ?? "(unknown)";
    const bucket = (byModel[model] ??= { rows: 0, mean_score: null, ok: 0, error: 0, anomalous: 0, arm_kind: null });
    bucket.rows += 1;
    if (r.status === "ok") bucket.ok += 1;
    if (r.status === "error") bucket.error += 1;
    if (isAnomalousEvalRow(r)) bucket.anomalous += 1;
    if (typeof r.arm_kind === "string" && bucket.arm_kind === null) bucket.arm_kind = r.arm_kind;
  }
  for (const [model, bucket] of Object.entries(byModel)) {
    const ms = clean
      .filter((r) => (r.model ?? "(unknown)") === model && typeof r.score === "number")
      .map((r) => r.score as number);
    bucket.mean_score = ms.length > 0 ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
  }
  return {
    rows: rows.length,
    anomalous: rows.length - clean.length,
    mean_score: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    by_model: byModel,
  };
}

function reviewSummary(entry: ProposedHubEntry): Obj {
  const counts: Record<string, number> = {};
  for (const d of REVIEW_DECISIONS) counts[d] = 0;
  let reviewed = 0;
  for (const t of entry.tasks) {
    const decision = entry.latestReviewByTask[t.task_id]?.decision;
    if (decision) {
      counts[decision] = (counts[decision] ?? 0) + 1;
      reviewed += 1;
    }
  }
  return { ...counts, unreviewed: entry.tasks.length - reviewed };
}

function requireString(args: Obj, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new ToolError(`${key} (string) is required`);
  return v;
}

/**
 * Compact projection of the understudy.calibration.v1 sidecar for tool
 * outputs (additive): incumbent gate counts plus the trivial-arm floors
 * (null_agent / spam_agent) when the calibrating run carried those arms.
 */
function calibrationOut(calibration: CalibrationSummary | null | undefined): Obj | null {
  if (!calibration) return null;
  return {
    run_id: calibration.run_id,
    threshold: calibration.threshold,
    passed_count: calibration.passed_count,
    failed_count: calibration.failed_count,
    failed_task_ids: calibration.failed_task_ids,
    // Additive: trivial-arm floors — floor_exceeded means the benchmark's
    // contracts are trivially satisfiable and passed_task_ids are suspect.
    null_floor: calibration.null_floor ?? null,
    spam_floor: calibration.spam_floor ?? null,
  };
}

function requireEntry(slug: string): AnyHubEntry {
  const entry = getEntry(slug);
  if (!entry) throw new ToolError(`unknown benchmark slug: ${slug} (use list_benchmarks)`);
  return entry;
}

/** The task record the shared scorer runs contracts against. */
function scoringTask(entry: AnyHubEntry, taskId: string): Obj | null {
  if (entry.kind === "proposed") return (entry.tasks.find((t) => t.task_id === taskId) as unknown as Obj) ?? null;
  if (entry.kind === "ok") return loadTaskSidecars(entry)[taskId] ?? null;
  return null;
}

function entryRows(entry: AnyHubEntry): EvalRow[] {
  return entry.kind === "invalid" ? [] : entry.rows;
}

/* ---------------- trajectories (runs/live journals) ---------------- */

type JournalEvent = { index: number; kind: string; tool: string; status: string | null; write: boolean; arguments: unknown; content: string | null };

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // capped/summary string — keep as-is
  }
}

/** Locate the journal for one run arm: exact path first, newest prefix match as fallback. */
function findJournal(dir: string, runId: string, model: string | null): string | null {
  if (!/^[A-Za-z0-9_.-]+$/.test(runId)) throw new ToolError("invalid run_id");
  if (model) {
    const exact = liveJournalPath(dir, runId, model);
    if (existsSync(exact)) return exact;
  }
  const liveDir = join(dir, "runs", "live");
  try {
    const candidates = readdirSync(liveDir)
      .filter((name) => name.startsWith(`${runId}-`) && name.endsWith(".jsonl"))
      .map((name) => join(liveDir, name))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
    return candidates.at(-1) ?? null;
  } catch {
    return null;
  }
}

function readJournalEvents(journal: string): JournalEvent[] {
  const events: JournalEvent[] = [];
  const lines = readFileSync(journal, "utf8").split("\n").filter(Boolean).slice(0, MAX_JOURNAL_LINES);
  lines.forEach((line, index) => {
    let parsed: Obj;
    try {
      parsed = asObject(JSON.parse(line));
    } catch {
      return; // torn tail line mid-append
    }
    events.push({
      index,
      kind: String(parsed.kind ?? ""),
      tool: String(parsed.tool ?? ""),
      status: typeof parsed.status === "string" ? parsed.status : null,
      write: parsed.write === true,
      arguments: parseArguments(parsed.arguments),
      content: typeof parsed.content === "string" ? parsed.content : null,
    });
  });
  return events;
}

type Trajectory = {
  journal_file: string;
  model: string | null;
  events: JournalEvent[];
  calls: ReplayCall[];
  final_response: string | null;
  accumulation: OracleReplay | null;
};

/** One arm's trajectory + the shared contract accumulation over it. */
function loadTrajectory(entry: AnyHubEntry, runId: string, taskId: string, model: string | null): Trajectory {
  if (entry.kind === "invalid") throw new ToolError(`benchmark dir is invalid: ${entry.errors.join("; ")}`);
  const journal = findJournal(entry.dir, runId, model);
  if (!journal) {
    throw new ToolError(
      `no trajectory journal found for run ${runId}${model ? ` model ${model}` : ""} under ${join(entry.dir, "runs", "live")}`,
    );
  }
  const events = readJournalEvents(journal);
  const calls: ReplayCall[] = events
    .filter((e) => e.kind === "call")
    .map((e) => ({ name: e.tool, arguments: e.arguments, ...(e.status === "error" ? { status: "error" } : {}) }));
  const finalEvent = events.find((e) => e.kind === "final_response");
  const finalResponse = finalEvent?.content ?? null;
  const task = scoringTask(entry, taskId);
  // journal filename: <runId>-<model>.jsonl (sanitized) — recover the arm's model for display.
  const inferredModel = model ?? basename(journal, ".jsonl").slice(runId.length + 1) ?? null;
  return {
    journal_file: journal,
    model: inferredModel || null,
    events,
    calls,
    final_response: finalResponse,
    accumulation: task ? accumulateReplay(task, calls, finalResponse) : null,
  };
}

function obligations(accumulation: OracleReplay | null): { label: string; kind: string; met: boolean; met_at: number | null }[] {
  return (accumulation?.required ?? []).map((r) => ({ label: r.label, kind: r.kind, met: r.met_at !== null, met_at: r.met_at }));
}

/* ---------------- tools ---------------- */

function toolListBenchmarks(): unknown {
  const entries = loadHub();
  return {
    roots: process.env.BENCHMARK_HUB_DATA_DIR ?? join(homedir(), ".understudy", "benchmarks"),
    benchmarks: entries.map((entry) => {
      if (entry.kind === "invalid") {
        return { slug: entry.slug, dir: entry.dir, stage: "invalid", errors: entry.errors };
      }
      if (entry.kind === "proposed") {
        return {
          slug: entry.slug,
          dir: entry.dir,
          stage: "proposed",
          tasks: entry.tasks.length,
          reviews: reviewSummary(entry),
          rows: entry.rows.length,
          read_only: entry.readOnly,
        };
      }
      return {
        slug: entry.slug,
        dir: entry.dir,
        stage: "promoted",
        benchmark_id: entry.manifest.benchmark_id,
        name: entry.manifest.name ?? null,
        tasks: entry.manifest.tasks.length,
        rows: entry.rows.length,
        warnings: entry.warnings.map((w) => w.label),
        read_only: entry.readOnly,
      };
    }),
  };
}

function taskScores(rows: EvalRow[], taskId: string): Obj {
  return rowsSummary(rows.filter((r) => r.task_id === taskId));
}

function toolReadBenchmark(args: Obj): unknown {
  const entry = requireEntry(requireString(args, "slug"));
  if (entry.kind === "invalid") return { slug: entry.slug, stage: "invalid", errors: entry.errors };
  if (entry.kind === "proposed") {
    return {
      slug: entry.slug,
      stage: "proposed",
      dir: entry.dir,
      manifest: entry.foundry,
      review_summary: reviewSummary(entry),
      // Additive: the auto-accept policy in force (review-policy.json sidecar,
      // defaults when the file is absent) + the incumbent/trivial calibration.
      review_policy: entry.reviewPolicy ?? null,
      calibration: calibrationOut(entry.calibration),
      // Additive: experiment-lineage sidecar summary (experiments.jsonl).
      experiments: experimentsSummary(entry.dir),
      cross_check_errors: entry.crossCheckErrors,
      tasks: (() => {
        const attentionByTask = new Map(deriveTaskAttention(entry).map((a) => [a.task_id, a.flags]));
        return entry.tasks.map((t) => ({
          task_id: t.task_id,
          name: taskDisplayName(t),
          split: t.split,
          status: t.status,
          machine_confidence: t.machine_confidence,
          review: entry.latestReviewByTask[t.task_id]
            ? { decision: entry.latestReviewByTask[t.task_id].decision, note: entry.latestReviewByTask[t.task_id].note }
            : null,
          // Additive (born-accepted model): the decision in force — an
          // explicit line, else the policy default — plus attention flags.
          effective_decision: effectiveDecision(entry, t.task_id),
          attention_flags: attentionByTask.get(t.task_id) ?? [],
          scores: taskScores(entry.rows, t.task_id),
        }));
      })(),
    };
  }
  const reviewsByTask = new Map<string, { decision: ReviewDecision; note: string }>();
  for (const r of entry.reviews ?? []) reviewsByTask.set(r.task_id, { decision: r.decision, note: r.note });
  return {
    slug: entry.slug,
    stage: "promoted",
    dir: entry.dir,
    manifest: entry.manifest,
    warnings: entry.warnings,
    // Additive: incumbent-rerun calibration sidecar presence + its summary
    // (incumbent gate counts and trivial-arm floors when arms ran).
    calibration_present: entry.calibration != null,
    calibration: calibrationOut(entry.calibration),
    // Additive: experiment-lineage sidecar summary (experiments.jsonl).
    experiments: experimentsSummary(entry.dir),
    tasks: entry.manifest.tasks.map((t) => ({
      task_id: t.task_id,
      split: t.split,
      category_id: t.category_id,
      review: reviewsByTask.get(t.task_id) ?? null,
      scores: taskScores(entry.rows, t.task_id),
    })),
  };
}

function toolReadTask(args: Obj): unknown {
  const entry = requireEntry(requireString(args, "slug"));
  const taskId = requireString(args, "task_id");
  if (entry.kind === "invalid") throw new ToolError(`benchmark dir is invalid: ${entry.errors.join("; ")}`);
  if (entry.kind === "proposed") {
    const task = entry.tasks.find((t) => t.task_id === taskId) as FoundryTask | undefined;
    if (!task) throw new ToolError(`unknown task_id: ${taskId}`);
    const worldModel = asObject(task.world_model);
    const initialState = asObject(worldModel.initial_state);
    return {
      task_id: task.task_id,
      name: taskDisplayName(task),
      title: task.title,
      prompt: task.authored?.statement ?? task.title,
      success_criteria: task.authored?.success_criteria ?? [],
      split: task.split,
      status: task.status,
      machine_confidence: task.machine_confidence,
      tool_surface: task.tool_surface,
      outcome_contract: task.outcome_contract,
      world_model_summary: {
        status: worldModel.status ?? null,
        initial_state_materialized: initialState.materialized === true,
        observations: Array.isArray(initialState.observations) ? initialState.observations.length : 0,
        transitions: Array.isArray(worldModel.transitions) ? worldModel.transitions.length : 0,
      },
      claims: task.claims,
      review: entry.latestReviewByTask[taskId] ?? null,
      // Additive (born-accepted model): decision in force + attention flags.
      effective_decision: effectiveDecision(entry, taskId),
      attention_flags: deriveTaskAttention(entry).find((a) => a.task_id === taskId)?.flags ?? [],
      review_history: entry.reviews.filter((r) => r.task_id === taskId),
      scores: taskScores(entry.rows, taskId),
    };
  }
  const manifestTask = entry.manifest.tasks.find((t) => t.task_id === taskId);
  if (!manifestTask) throw new ToolError(`unknown task_id: ${taskId}`);
  const sidecar = loadTaskSidecars(entry)[taskId] ?? null;
  const worldModel = asObject(sidecar?.world_model);
  return {
    task_id: taskId,
    manifest_task: manifestTask,
    prompt: asObject(sidecar?.authored).statement ?? sidecar?.title ?? null,
    outcome_contract: sidecar?.outcome_contract ?? null,
    world_model_summary: sidecar
      ? {
          status: worldModel.status ?? null,
          transitions: Array.isArray(worldModel.transitions) ? worldModel.transitions.length : 0,
        }
      : null,
    sidecar,
    review_history: (entry.reviews ?? []).filter((r) => r.task_id === taskId),
    scores: taskScores(entry.rows, taskId),
  };
}

function toolReadRollout(args: Obj): unknown {
  const entry = requireEntry(requireString(args, "slug"));
  const runId = requireString(args, "run_id");
  const taskId = requireString(args, "task_id");
  const model = typeof args.model === "string" && args.model.length > 0 ? args.model : null;
  const trajectory = loadTrajectory(entry, runId, taskId, model);
  const rows = entryRows(entry).filter(
    (r) => r.run_id === runId && r.task_id === taskId && (model === null || r.model === model),
  );
  return {
    run_id: runId,
    task_id: taskId,
    model: trajectory.model,
    journal_file: trajectory.journal_file,
    events: trajectory.events,
    final_response: trajectory.final_response,
    rows: rows.map((r) => ({
      model: r.model ?? null,
      score: r.score ?? null,
      subscores: r.subscores ?? null,
      status: r.status,
      latency_ms: r.latency_ms ?? null,
      // Additive: incumbent-vs-candidate arm label + structural sentinel flag.
      arm_kind: r.arm_kind ?? null,
      anomaly: r.anomaly ?? null,
    })),
    // Per-obligation contract scoring through the SAME shared scorer as the
    // hub's Replay tab (dist/benchmark-replay.js).
    obligations: obligations(trajectory.accumulation),
    verdict: trajectory.accumulation?.verdict ?? null,
    accumulation: trajectory.accumulation,
  };
}

function toolDiffRollouts(args: Obj): unknown {
  const entry = requireEntry(requireString(args, "slug"));
  const taskId = requireString(args, "task_id");
  const runA = requireString(args, "run_a");
  const runB = requireString(args, "run_b");
  const modelA = typeof args.model_a === "string" && args.model_a.length > 0 ? args.model_a : null;
  const modelB = typeof args.model_b === "string" && args.model_b.length > 0 ? args.model_b : null;
  const a = loadTrajectory(entry, runA, taskId, modelA);
  const b = loadTrajectory(entry, runB, taskId, modelB);
  // Additive: the matching eval rows' arm label + sentinel flag per arm.
  const armRows = (runId: string, model: string | null) =>
    entryRows(entry)
      .filter((r) => r.run_id === runId && r.task_id === taskId && (model === null || r.model === model))
      .map((r) => ({ model: r.model ?? null, score: r.score ?? null, status: r.status, arm_kind: r.arm_kind ?? null, anomaly: r.anomaly ?? null }));

  const oblA = obligations(a.accumulation);
  const oblB = obligations(b.accumulation);
  const labels = [...new Set([...oblA.map((o) => o.label), ...oblB.map((o) => o.label)])];
  const obligationDiff = labels.map((label) => {
    const inA = oblA.find((o) => o.label === label) ?? null;
    const inB = oblB.find((o) => o.label === label) ?? null;
    return {
      label,
      kind: inA?.kind ?? inB?.kind ?? "unknown",
      a: inA ? { met: inA.met, met_at: inA.met_at } : null,
      b: inB ? { met: inB.met, met_at: inB.met_at } : null,
      same: (inA?.met ?? null) === (inB?.met ?? null),
    };
  });

  const seqA = a.calls.map((c) => c.name);
  const seqB = b.calls.map((c) => c.name);
  let divergesAt: number | null = null;
  for (let i = 0; i < Math.max(seqA.length, seqB.length); i += 1) {
    if (seqA[i] !== seqB[i]) {
      divergesAt = i;
      break;
    }
  }
  return {
    task_id: taskId,
    a: { run_id: runA, model: a.model, journal_file: a.journal_file, calls: seqA, verdict: a.accumulation?.verdict ?? null, rows: armRows(runA, a.model) },
    b: { run_id: runB, model: b.model, journal_file: b.journal_file, calls: seqB, verdict: b.accumulation?.verdict ?? null, rows: armRows(runB, b.model) },
    obligations: obligationDiff,
    tool_sequence: {
      diverges_at: divergesAt,
      common_prefix: divergesAt === null ? seqA.length : divergesAt,
      a_from_divergence: divergesAt === null ? [] : seqA.slice(divergesAt, divergesAt + 20),
      b_from_divergence: divergesAt === null ? [] : seqB.slice(divergesAt, divergesAt + 20),
    },
  };
}

function toolSubmitReview(args: Obj): unknown {
  const slug = requireString(args, "slug");
  // Shared validation + append (dist/benchmark-hub-core.js) — the exact code
  // behind the hub's POST /api/reviews.
  const result = submitReview(getEntry(slug), {
    task_id: args.task_id,
    decision: args.decision,
    note: args.note,
  });
  if (!result.ok) throw new ToolError(result.error);
  return { ok: true, review: result.review };
}

function toolApplyAutoAccepts(args: Obj): unknown {
  const slug = requireString(args, "slug");
  // Shared policy + append (dist/benchmark-hub-core.js) — the exact code
  // behind the hub's POST /api/reviews/auto ("Apply N auto-accepts" button).
  // Explicit-invocation semantics: calling this tool IS the user action;
  // nothing is ever auto-applied on read.
  const result = applyAutoAccepts(getEntry(slug));
  if (!result.ok) throw new ToolError(result.error);
  return {
    ok: true,
    applied: result.applied,
    applied_count: result.applied.length,
    exceptions: result.exceptions,
    reviews: result.reviews,
  };
}

function toolSubmitFeedback(args: Obj): unknown {
  const slug = requireString(args, "slug");
  // Shared validation + append (dist/benchmark-hub-core.js) — the exact code
  // behind the hub's POST /api/feedback. Records the feedback line and
  // returns the agent handoff prompt; nothing is executed here.
  const result = submitTaskFeedback(getEntry(slug), { task_id: args.task_id, feedback: args.feedback });
  if (!result.ok) throw new ToolError(result.error);
  return { ok: true, feedback: result.feedback, handoff: result.handoff };
}

function toolQueueRun(args: Obj): unknown {
  const slug = requireString(args, "slug");
  // Shared validation + queue write (dist/benchmark-hub-core.js +
  // run-executor's understudy.run_request.v1 schema) — the exact code behind
  // the hub's POST /api/runs. Writes runs/queue/<run_id>.json only; the
  // executor daemon does the running.
  const result = queueOrCancelRun(getEntry(slug), {
    models: args.models,
    tasks: args.tasks ?? "all",
    split: args.split,
    rollouts_per_task: args.rollouts_per_task ?? 1,
    // Additive: incumbent-baseline arm + calibration threshold pass-through.
    incumbent_models: args.incumbent_models,
    calibration_threshold: args.calibration_threshold,
    // Additive: experiment-lineage cross-link (validated against experiments.jsonl).
    experiment_id: args.experiment_id,
  });
  if (!result.ok) throw new ToolError(result.error);
  return { ok: true, run_id: result.run.run_id, run: result.run, execute_hint: result.execute_hint };
}

function toolRunStatus(args: Obj): unknown {
  const entry = requireEntry(requireString(args, "slug"));
  const runId = requireString(args, "run_id");
  if (entry.kind === "invalid") throw new ToolError(`benchmark dir is invalid: ${entry.errors.join("; ")}`);
  if (!/^[A-Za-z0-9_.-]+$/.test(runId)) throw new ToolError("invalid run_id");
  const file = runRequestPath(entry.dir, runId);
  const run = existsSync(file) ? readRunRequest(file) : null;
  if (!run) throw new ToolError(`unknown run_id: ${runId}`);
  const rows = entryRows(entry).filter((r) => r.run_id === runId);
  // Additive: incumbent arm + calibration sidecar (both stages carry
  // calibration.json after an incumbent/trivial-arm run finishes), including
  // the null/spam trivial-arm floors.
  const calibration = entry.calibration ?? null;
  return {
    run_id: runId,
    status: run.status,
    progress: run.progress,
    live: run.live ?? null,
    error: run.error ?? null,
    models: run.models,
    tasks: run.tasks,
    incumbent_models: run.incumbent_models ?? [],
    calibration: calibrationOut(calibration),
    rows: rowsSummary(rows),
    per_task: [...new Set(rows.map((r) => r.task_id))].sort().map((taskId) => ({ task_id: taskId, ...taskScores(rows, taskId) })),
  };
}

function toolRegradeRun(args: Obj): unknown {
  const entry = requireEntry(requireString(args, "slug"));
  if (entry.kind !== "ok") throw new ToolError(`regrade needs a promoted benchmark dir (understudy.benchmark.v1); this dir is stage "${entry.kind}"`);
  // Shared offline regrade engine (dist/regrade.js) — the exact code behind
  // `understudy runs regrade`. NEVER re-runs the agent: rescores retained
  // trace evidence against the CURRENT verifier definition. dry_run defaults
  // to TRUE — the write path (new rows under <run>-regrade-<n>) must be
  // requested explicitly with dry_run:false.
  const dryRun = args.dry_run !== false;
  const taskIds = Array.isArray(args.task_ids) ? args.task_ids.map(String) : null;
  const summaries = regradeRuns(entry.dir, {
    runId: typeof args.run_id === "string" ? args.run_id : null,
    taskIds,
    dryRun,
  });
  return { ok: true, dry_run: dryRun, summaries, deltas: summaries.map((s) => formatRegradeDelta(s)) };
}

/* ---------------- experiment lineage (experiments.jsonl) ---------------- */

function toolCreateExperiment(args: Obj): unknown {
  const slug = requireString(args, "slug");
  // Shared validation + append (dist/benchmark-hub-core.js →
  // dist/benchmark-artifacts.js) — one understudy.experiment.v1 line into
  // experiments.jsonl next to the benchmark manifest.
  const result = createExperiment(getEntry(slug), asObject(args.experiment) as never);
  if (!result.ok) throw new ToolError(result.error);
  return { ok: true, experiment: result.experiment, file: result.file };
}

function toolUpdateExperiment(args: Obj): unknown {
  const slug = requireString(args, "slug");
  const result = updateExperiment(getEntry(slug), args.experiment_id, asObject(args.patch));
  if (!result.ok) throw new ToolError(result.error);
  return { ok: true, experiment: result.experiment, file: result.file };
}

function toolListExperiments(args: Obj): unknown {
  const entry = requireEntry(requireString(args, "slug"));
  if (entry.kind === "invalid") throw new ToolError(`benchmark dir is invalid: ${entry.errors.join("; ")}`);
  return listExperiments(entry.dir);
}

/* ---------------- workload intake: profile + dataset foundry ---------------- */

/** Extensions dataset-foundry can load (mirrors its DATA_EXTENSIONS). */
const DATASET_EXTENSIONS = new Set([".jsonl", ".ndjson", ".csv", ".tsv", ".xlsx"]);
const MAX_DATASET_CANDIDATES = 50;
const MAX_CANDIDATE_SCAN_DEPTH = 3;
const SKIPPED_SCAN_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", "dist", "build"]);

function datasetCandidates(root: string, depth = 0, found: string[] = []): string[] {
  if (depth > MAX_CANDIDATE_SCAN_DEPTH || found.length >= MAX_DATASET_CANDIDATES) return found;
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return found;
  }
  for (const name of names) {
    if (found.length >= MAX_DATASET_CANDIDATES) break;
    if (name.startsWith(".") || SKIPPED_SCAN_DIRS.has(name)) continue;
    const full = join(root, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) datasetCandidates(full, depth + 1, found);
    else if (stat.isFile() && DATASET_EXTENSIONS.has(extname(name).toLowerCase())) found.push(full);
  }
  return found;
}

/**
 * Profile a dropped file or directory with the SAME local-only scanner the
 * desktop drop path uses (`understudy capture-import compile`): writes
 * workload-card.json / capture-sources.json under ~/.understudy/capture-imports
 * and returns the compile summary plus any dataset files the foundry could
 * consume. Payloads are never read; nothing leaves the machine.
 */
function toolProfileWorkload(args: Obj): unknown {
  const path = resolve(requireString(args, "path"));
  if (!existsSync(path)) throw new ToolError(`path does not exist: ${path}`);
  const stat = statSync(path);
  if (!stat.isFile() && !stat.isDirectory()) throw new ToolError(`path must be a file or directory: ${path}`);
  const outputRoot = optionalString(args, "output_root");
  const compiled = outputRoot
    ? compileCaptureImport(path, new Date(), resolve(outputRoot))
    : compileCaptureImport(path);
  const candidates = stat.isDirectory()
    ? datasetCandidates(path)
    : DATASET_EXTENSIONS.has(extname(path).toLowerCase())
      ? [path]
      : [];
  return {
    ...compiled,
    dataset_candidates: candidates,
    dataset_candidates_truncated: candidates.length >= MAX_DATASET_CANDIDATES,
    next:
      candidates.length > 0
        ? "Inspect the workload card, confirm the labeled dataset with the user, then call from_dataset to compile a proposed benchmark (tasks land in the review inbox — nothing runs)."
        : "No foundry-consumable dataset files (.jsonl/.csv/.tsv/.xlsx) found; discuss with the user what the workload's ground truth is before proposing a benchmark.",
  };
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function hubPrimaryRoot(): string {
  const roots = (process.env.BENCHMARK_HUB_DATA_DIR ?? join(homedir(), ".understudy", "benchmarks"))
    .split(":")
    .filter(Boolean);
  return roots[0] ?? join(homedir(), ".understudy", "benchmarks");
}

function optionalString(args: Obj, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0) throw new ToolError(`${key} must be a non-empty string when provided`);
  return v;
}

/**
 * `understudy benchmarks from-dataset` behind the tool codec: compile a
 * labeled dataset into a PROPOSED benchmark under the primary hub root. The
 * output is machine_compiled_review_pending with executable:false and
 * human_final_judgment among its promotion blockers — creating it queues
 * nothing and spends nothing; the user confirms via the task inbox.
 */
function toolFromDataset(args: Obj): unknown {
  const source = resolve(requireString(args, "source"));
  if (!existsSync(source)) throw new ToolError(`source does not exist: ${source}`);
  const slug = requireString(args, "slug");
  if (!SLUG_RE.test(slug)) {
    throw new ToolError("slug must be lowercase [a-z0-9._-], start alphanumeric, max 64 chars");
  }
  const dir = join(hubPrimaryRoot(), slug);
  if (existsSync(dir)) throw new ToolError(`benchmark dir already exists: ${dir} (pick a new slug)`);
  const options: DatasetFoundryOptions = {};
  const name = optionalString(args, "name");
  if (name) options.name = name;
  const labelColumn = optionalString(args, "label_column");
  if (labelColumn) options.labelColumn = labelColumn;
  if (args.input_columns !== undefined) {
    if (!Array.isArray(args.input_columns) || args.input_columns.some((c) => typeof c !== "string" || c.length === 0)) {
      throw new ToolError("input_columns must be an array of non-empty strings when provided");
    }
    options.inputColumns = args.input_columns as string[];
  }
  const groupColumn = optionalString(args, "group_column");
  if (groupColumn) options.groupColumn = groupColumn;
  const systemPrompt = optionalString(args, "system_prompt");
  if (systemPrompt) options.systemPrompt = systemPrompt;
  const result = compileDatasetFoundry(source, dir, options);
  // Hub slugs are <root-prefix>--<dir-name>: the first BENCHMARK_HUB_DATA_DIR
  // root gets prefix "data"; the ~/.understudy/benchmarks default gets "local"
  // (benchmark-hub-core slugRoots). Return the resolvable slug so the caller
  // can read_benchmark / read_task immediately.
  const prefix = process.env.BENCHMARK_HUB_DATA_DIR ? "data" : "local";
  return { ok: true, slug: `${prefix}--${slug}`, dir, result };
}

/* ---------------- MCP wiring ---------------- */

export const BENCHMARKS_TOOLS = [
  {
    name: "list_benchmarks",
    description:
      "Benchmark directories under the configured roots (default ~/.understudy/benchmarks, plus any --root " +
      "the server was started with): slug, stage (proposed = trace-foundry output awaiting review; promoted " +
      "= understudy.benchmark.v1), task counts, and the review-decision summary for proposed entries.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_benchmark",
    description:
      "One benchmark by slug: the manifest (trace_foundry manifest.json or promoted benchmark.json) plus the " +
      "task list with latest review decisions and per-task score summaries from rows-*.jsonl.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Slug from list_benchmarks." } },
      required: ["slug"],
    },
  },
  {
    name: "read_task",
    description:
      "Full task detail: prompt/statement, outcome contract (required/preserved/forbidden), world-model " +
      "summary, review state + history, and score summary.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" }, task_id: { type: "string" } },
      required: ["slug", "task_id"],
    },
  },
  {
    name: "read_rollout",
    description:
      "One rollout trajectory from the run's live journal (runs/live/<run_id>-<model>.jsonl): ordered tool " +
      "calls and results, the final response when journaled, matching eval rows, and per-obligation contract " +
      "scoring computed by the same shared scorer as the hub's Replay tab.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        run_id: { type: "string" },
        task_id: { type: "string" },
        model: { type: "string", description: "Model arm; omitted = newest journal for the run." },
      },
      required: ["slug", "run_id", "task_id"],
    },
  },
  {
    name: "diff_rollouts",
    description:
      "Side-by-side trajectory comparison for one task across two runs: which contract obligations each " +
      "passed, and where the tool-call sequences diverge (first divergence index + the sequences from there).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        task_id: { type: "string" },
        run_a: { type: "string" },
        run_b: { type: "string" },
        model_a: { type: "string", description: "Optional model arm for run_a." },
        model_b: { type: "string", description: "Optional model arm for run_b." },
      },
      required: ["slug", "task_id", "run_a", "run_b"],
    },
  },
  {
    name: "submit_review",
    description:
      "Append one understudy.benchmark_review.v1 line to reviews.jsonl (append-only; newest per task_id " +
      "wins) — the exact validation the hub's POST /api/reviews performs. Proposed benchmarks only.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        task_id: { type: "string" },
        decision: { type: "string", enum: [...REVIEW_DECISIONS] },
        note: { type: "string", maxLength: 2000 },
      },
      required: ["slug", "task_id", "decision"],
    },
  },
  {
    name: "apply_auto_accepts",
    description:
      "Apply the auto-accept policy to one PROPOSED benchmark: recompute the classification " +
      "(review-policy.json bar; defaults min_confidence=high, require_incumbent_pass=true) and append one " +
      "accept line per clean unreviewed task to reviews.jsonl, stamped source:\"auto\". Only needed for " +
      "benchmarks running review-policy default_decision \"pending\" (the older explicit-accept flow) — under " +
      "the default born-accepted model, unreviewed tasks are already effectively accepted and machine signals " +
      "surface as attention_flags instead. Calling this tool IS the explicit user action; reads never " +
      "auto-apply. Reversible: newest review line per task wins.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Slug from list_benchmarks (proposed stage only)." } },
      required: ["slug"],
    },
  },
  {
    name: "submit_feedback",
    description:
      "Record one understudy.task_feedback.v1 line ('what's wrong with this task') to feedback.jsonl next to " +
      "the foundry manifest (append-only; proposed benchmarks only) and return the copyable agent-handoff " +
      "prompt for actually editing the task + regenerating its environment. Nothing is executed here — the " +
      "same storage-plus-handoff contract as the hub's task feedback box.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        task_id: { type: "string" },
        feedback: { type: "string", maxLength: 4000, description: "Reviewer's own words on what is wrong / should change." },
      },
      required: ["slug", "task_id", "feedback"],
    },
  },
  {
    name: "queue_run",
    description:
      "Write one understudy.run_request.v1 into <benchmark>/runs/queue/ (validated by the same shared schema " +
      "as the hub's POST /api/runs) and return its run_id. NEVER executes anything — `understudy runs " +
      "execute --benchmark <dir> --watch` (or the daemon) picks the request up. Proposed benchmarks accept " +
      "single accepted tasks only.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        models: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Task ids to run; omitted = all tasks in the split.",
        },
        split: { type: "string", enum: [...RUN_SPLITS], description: "Default all." },
        rollouts_per_task: { type: "integer", minimum: 1, maximum: 20, default: 1 },
        incumbent_models: {
          type: "array",
          items: { type: "string" },
          description: "Subset of models to label as the incumbent arm (rows get arm_kind incumbent and feed the calibration gate).",
        },
        calibration_threshold: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 1,
          description: "Incumbent calibration pass threshold on the strict score (default 1).",
        },
        experiment_id: {
          type: "string",
          description:
            "Optional understudy.experiment.v1 experiment this run evaluates; must already exist in the " +
            "benchmark's experiments.jsonl (create_experiment first). Recorded on the run request so rows/" +
            "events join back to the experiment via run_id.",
        },
      },
      required: ["slug", "models"],
    },
  },
  {
    name: "create_experiment",
    description:
      "Append one NEW understudy.experiment.v1 line to experiments.jsonl next to the benchmark manifest: " +
      "hypothesis, data_selection (curate-trajectories selection hash + source), training plan (method, " +
      "base_model, config, provider, cost_estimate, cleared approval gates), optional produced_artifact / " +
      "baseline_run_id / eval_run_ids / verdict. Append-only; refuses an existing experiment_id (use " +
      "update_experiment). Records lineage only — never uploads data or spends.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug from list_benchmarks." },
        experiment: {
          type: "object",
          description:
            "The experiment record. Required: hypothesis (string), data_selection {selection_hash, source, " +
            "splits_sha256?}, training {method sft|lora|distill|rl|prompt_only|none, base_model, provider " +
            "('local' or a provider id), config?, cost_estimate?, approvals?: [{gate, approved_by, at}]}. " +
            "Optional: experiment_id (generated when omitted), status (default draft), produced_artifact " +
            "{kind, ref, sha256}, baseline_run_id, eval_run_ids, verdict {decision promote|shadow|collect|stop, summary, decided_at}.",
        },
      },
      required: ["slug", "experiment"],
    },
  },
  {
    name: "update_experiment",
    description:
      "Supersede one experiment: merge a patch over its newest experiments.jsonl record and append the FULL " +
      "merged record (append-only, newest per experiment_id wins — history is never rewritten). " +
      "training.approvals and eval_run_ids APPEND (cleared gates are never dropped); experiment_id and " +
      "created_at are immutable. Typical patches: status flips, a new approval gate, produced_artifact after " +
      "training, eval_run_ids after runs, the final verdict.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        experiment_id: { type: "string" },
        patch: { type: "object", description: "Partial understudy.experiment.v1 fields to merge over the newest record." },
      },
      required: ["slug", "experiment_id", "patch"],
    },
  },
  {
    name: "list_experiments",
    description:
      "Latest understudy.experiment.v1 record per experiment_id from the benchmark's experiments.jsonl " +
      "(append-only sidecar; newest line per experiment_id wins), plus total superseding line count.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
  },
  {
    name: "profile_workload",
    description:
      "Profile a dropped file or directory with the local-only capture-import scanner (same as the desktop " +
      "drop path): classifies every file, writes workload-card.json + capture-sources.json under " +
      "~/.understudy/capture-imports, and lists dataset files (.jsonl/.csv/.tsv/.xlsx) the foundry could " +
      "consume. Payload bytes are never read as model input and nothing leaves the machine.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the dropped file or directory." },
        output_root: { type: "string", description: "Override artifact root (default ~/.understudy/capture-imports)." },
      },
      required: ["path"],
    },
  },
  {
    name: "from_dataset",
    description:
      "Compile one labeled dataset (file, or directory containing exactly one data file) into a PROPOSED " +
      "benchmark under the primary hub root — the same `understudy benchmarks from-dataset` foundry: curated " +
      "normalized captures, grouped train/dev/holdout splits, a verifiers environment, and machine_proposed " +
      "tasks awaiting the user's review in the task inbox. Creates review-pending artifacts only: " +
      "executable:false, human_final_judgment blocked — never queues a run, never spends.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Absolute path to the dataset file or its directory." },
        slug: { type: "string", description: "New benchmark slug (lowercase [a-z0-9._-]); becomes the dir name under the hub root." },
        name: { type: "string", description: "Human benchmark name; defaults from the source filename." },
        label_column: { type: "string", description: "Label/target column; inferred when omitted." },
        input_columns: { type: "array", items: { type: "string" }, description: "Input columns; inferred when omitted." },
        group_column: { type: "string", description: "Leakage-group column; defaults to the normalized input text." },
        system_prompt: { type: "string", description: "Literal system prompt recorded for the workload." },
      },
      required: ["source", "slug"],
    },
  },
  {
    name: "run_status",
    description:
      "Status of a queued/running/finished run request plus a row summary (per model and per task) as " +
      "rows-*.jsonl files land.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" }, run_id: { type: "string" } },
      required: ["slug", "run_id"],
    },
  },
  {
    name: "regrade_run",
    description:
      "Rescore retained run traces OFFLINE against the CURRENT verifier definition (tasks.jsonl outcome " +
      "contracts) — never re-runs the agent, never spends. dry_run defaults to true and returns the full " +
      "plan + score deltas without writing; dry_run:false appends the rescored rows under a new " +
      "<run>-regrade-<n> run_id with source_run provenance and the original cost/latency preserved. " +
      "Requires manifest.verifier.replayable; rows without retained traces are skipped with explicit reasons.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        run_id: { type: "string", description: "Source run to regrade; omitted = every run with rows (regrade rows themselves are skipped)." },
        task_ids: { type: "array", items: { type: "string" }, description: "Regrade only these task ids." },
        dry_run: { type: "boolean", default: true, description: "true (default) = plan + deltas only, zero writes; false = append regraded rows." },
      },
      required: ["slug"],
    },
  },
] as const;

/** Dispatch one tool call — exported so node:test can exercise tools without a stdio session. */
export function callBenchmarksTool(name: string, args: Obj): unknown {
  switch (name) {
    case "list_benchmarks": return toolListBenchmarks();
    case "read_benchmark": return toolReadBenchmark(args);
    case "read_task": return toolReadTask(args);
    case "read_rollout": return toolReadRollout(args);
    case "diff_rollouts": return toolDiffRollouts(args);
    case "submit_review": return toolSubmitReview(args);
    case "apply_auto_accepts": return toolApplyAutoAccepts(args);
    case "submit_feedback": return toolSubmitFeedback(args);
    case "queue_run": return toolQueueRun(args);
    case "profile_workload": return toolProfileWorkload(args);
    case "from_dataset": return toolFromDataset(args);
    case "run_status": return toolRunStatus(args);
    case "regrade_run": return toolRegradeRun(args);
    case "create_experiment": return toolCreateExperiment(args);
    case "update_experiment": return toolUpdateExperiment(args);
    case "list_experiments": return toolListExperiments(args);
    default: throw new ToolError(`unknown tool: ${name}`);
  }
}

export async function runBenchmarksMcpServer(extraRoots: string[]): Promise<void> {
  configureBenchmarksMcpRoots(extraRoots);
  const server = new Server(
    { name: "understudy-benchmarks", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: BENCHMARKS_TOOLS.map((t) => ({ ...t })) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = callBenchmarksTool(name, asObject(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e instanceof Error ? e.message : e) }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `understudy benchmarks mcp: serving ${BENCHMARKS_TOOLS.length} tools over stdio ` +
      `(roots: ${process.env.BENCHMARK_HUB_DATA_DIR ?? join(homedir(), ".understudy", "benchmarks")})`,
  );
}
