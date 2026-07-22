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
import { basename, join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  getEntry,
  loadHub,
  loadTaskSidecars,
  queueOrCancelRun,
  submitReview,
} from "./benchmark-hub-core.js";
import type { AnyHubEntry, EvalRow, FoundryTask, ProposedHubEntry, ReviewDecision } from "./benchmark-hub-types.js";
import { REVIEW_DECISIONS, taskDisplayName } from "./benchmark-hub-types.js";
import { isAnomalousEvalRow, liveJournalPath, readRunRequest, runRequestPath, RUN_SPLITS } from "./run-executor.js";
import { accumulateReplay, type OracleReplay, type ReplayCall } from "./benchmark-replay.js";

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
      cross_check_errors: entry.crossCheckErrors,
      tasks: entry.tasks.map((t) => ({
        task_id: t.task_id,
        name: taskDisplayName(t),
        split: t.split,
        status: t.status,
        machine_confidence: t.machine_confidence,
        review: entry.latestReviewByTask[t.task_id]
          ? { decision: entry.latestReviewByTask[t.task_id].decision, note: entry.latestReviewByTask[t.task_id].note }
          : null,
        scores: taskScores(entry.rows, t.task_id),
      })),
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
    // Additive: incumbent-rerun calibration sidecar presence.
    calibration_present: entry.calibration != null,
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
  // Additive: incumbent arm + calibration sidecar presence (promoted entries
  // carry calibration.json after an incumbent rerun finishes).
  const calibration = entry.kind === "ok" ? (entry.calibration ?? null) : null;
  return {
    run_id: runId,
    status: run.status,
    progress: run.progress,
    live: run.live ?? null,
    error: run.error ?? null,
    models: run.models,
    tasks: run.tasks,
    incumbent_models: run.incumbent_models ?? [],
    calibration: calibration
      ? {
          run_id: calibration.run_id,
          threshold: calibration.threshold,
          passed_count: calibration.passed_count,
          failed_count: calibration.failed_count,
          failed_task_ids: calibration.failed_task_ids,
        }
      : null,
    rows: rowsSummary(rows),
    per_task: [...new Set(rows.map((r) => r.task_id))].sort().map((taskId) => ({ task_id: taskId, ...taskScores(rows, taskId) })),
  };
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
      },
      required: ["slug", "models"],
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
    case "queue_run": return toolQueueRun(args);
    case "run_status": return toolRunStatus(args);
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
