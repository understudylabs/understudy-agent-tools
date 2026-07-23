/**
 * Regrade verb — Harbor-style trial regrade for benchmark runs.
 *
 * NEVER re-runs the agent. For rows whose benchmark verifier is declared
 * replayable (manifest.verifier.replayable === true) and whose run retained
 * its traces.jsonl evidence (runs/work/<run>--<arm>/outputs/**\/traces.jsonl,
 * the structural layout the executor writes), the retained trajectory is
 * rescored offline against the CURRENT verifier definition (the task's
 * outcome contract in tasks.jsonl) through the same shared accumulation the
 * hub replays (accumulateReplay → scoreContract). New rows are written under
 * a NEW run_id (<old>-regrade-<n>) stamped with
 * provenance.source_run {action:"regrade", run_id, row_ref}; the original
 * cost/tokens/latency are PRESERVED (cost was incurred once, recorded — a
 * regrade re-judges, it never re-spends). Non-replayable or trace-missing
 * rows are skipped with an explicit reason, never silently dropped.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { EVAL_RESULT_SCHEMA, appendJsonlRows, readJsonlFile } from "./benchmark-artifacts.js";
import { accumulateReplay, type ReplayCall } from "./benchmark-replay.js";
import { bumpVersion } from "./benchmark.js";
import { serializeVersionEntryLine, type BenchmarkVersionEntry, type VersionTaskBump } from "./benchmark-upgrade.js";
import { newOutputFiles, rowsFilePath, verifiersWorkDir } from "./run-executor.js";

type Obj = Record<string, unknown>;
const asObject = (value: unknown): Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};

/** Same filename sanitizer the executor uses for rows/work-dir names (kept in lockstep by tests). */
const sanitizeForFile = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);

/* ------------------------------------------------------------------ */
/* Result shapes                                                       */
/* ------------------------------------------------------------------ */

export type RegradeSkipReason =
  | "verifier_not_replayable"
  | "trace_missing"
  | "no_trace_for_task"
  | "task_definition_missing"
  | "already_regraded_row";

export type RegradedRow = {
  task_id: string;
  model: string;
  rollout: number;
  old_score: number | null;
  new_score: number | null;
  changed: boolean;
  /** Where the source row lives: <rows-file basename>#<line index>. */
  row_ref: string;
};

export type RegradeSkip = { task_id: string; model: string; rollout: number; reason: RegradeSkipReason };

export type RegradeRunSummary = {
  run_id: string;
  /** The run_id the regraded rows are (or would be, in dry-run) written under; null when nothing regrades. */
  new_run_id: string | null;
  dry_run: boolean;
  rows_considered: number;
  regraded: RegradedRow[];
  skipped: RegradeSkip[];
  delta: {
    changed: number;
    up: number;
    down: number;
    /** Means over rows where both old and new score are numeric. */
    mean_before: number | null;
    mean_after: number | null;
  };
  /**
   * Additive: the ONE understudy.benchmark_version.v1 line this invocation
   * appended to versions.jsonl (MINOR bumps for every regraded task, so the
   * superseded source rows go stale in leaderboard aggregates instead of
   * double-counting next to their regrades). Shared across every summary of
   * the invocation; null on dry runs and when nothing was regraded.
   */
  version_entry: BenchmarkVersionEntry | null;
};

export type RegradeOptions = {
  /** Regrade only this source run (default: every run with retained rows, skipping rows that are themselves regrades). */
  runId?: string | null;
  /** Regrade only these task ids. */
  taskIds?: string[] | null;
  /** Plan + score without writing any rows. */
  dryRun?: boolean;
  now?: () => Date;
};

/* ------------------------------------------------------------------ */
/* Evidence: retained traces.jsonl per (run, arm)                      */
/* ------------------------------------------------------------------ */

export type TraceEvidence = { calls: ReplayCall[]; finalResponse: string | null };

/**
 * Project one retained verifiers trace onto replay evidence: EVERY tool call
 * (reads and writes, in node order, mcp prefix stripped — the same mapping
 * projectVerifiersTrace uses for writes) plus the final assistant text.
 */
export function traceEvidence(trace: Obj): { taskId: string | null; evidence: TraceEvidence } {
  const taskId = (asObject(asObject(trace.task).data).task_id as string | undefined) ?? null;
  const calls: ReplayCall[] = [];
  let finalResponse: string | null = null;
  for (const node of (Array.isArray(trace.nodes) ? trace.nodes : []).map(asObject)) {
    const message = asObject(node.message);
    if (message.role === "assistant") {
      const text = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((b: unknown) => String(asObject(b).text ?? "")).join("")
          : "";
      if (text.trim().length > 0) finalResponse = text;
    }
    for (const tc of (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(asObject)) {
      const fn = asObject(tc.function);
      const name = String(tc.name ?? fn.name ?? "").replace(/^world_toolset_/, "");
      if (!name) continue;
      let args: unknown = tc.arguments ?? fn.arguments ?? {};
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* keep raw */ } }
      calls.push({ name, arguments: args });
    }
  }
  return { taskId, evidence: { calls, finalResponse } };
}

/** task_id → retained trace evidence for one (run, arm), from the structural work dir. Empty map = no retained traces. */
export function loadRetainedTraces(benchmarkDir: string, runId: string, model: string): Map<string, TraceEvidence> {
  const evidence = new Map<string, TraceEvidence>();
  const workDir = verifiersWorkDir(benchmarkDir, `${runId}--${model}`);
  if (!existsSync(workDir)) return evidence;
  for (const file of newOutputFiles(workDir, 0)) {
    for (const line of readJsonlFile<Obj>(file).items) {
      for (const trace of (Array.isArray(line.traces) ? line.traces : []).map(asObject)) {
        const { taskId, evidence: ev } = traceEvidence(trace);
        if (taskId && !evidence.has(taskId)) evidence.set(taskId, ev);
      }
    }
  }
  return evidence;
}

/* ------------------------------------------------------------------ */
/* Row discovery                                                       */
/* ------------------------------------------------------------------ */

type SourceRow = { row: Obj; rowsFile: string; index: number };

/** Every persisted eval row in the benchmark dir, grouped by its OWN run_id (row content, never the filename). */
export function readAllRows(benchmarkDir: string): Map<string, SourceRow[]> {
  const dir = resolve(benchmarkDir);
  const byRun = new Map<string, SourceRow[]>();
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return byRun; }
  for (const name of names.filter((n) => n.startsWith("rows-") && n.endsWith(".jsonl")).sort()) {
    const file = join(dir, name);
    readJsonlFile<Obj>(file).items.forEach((row, index) => {
      if (row.schema_version !== EVAL_RESULT_SCHEMA) return;
      const runId = typeof row.run_id === "string" ? row.run_id : null;
      if (!runId) return;
      const list = byRun.get(runId) ?? [];
      list.push({ row, rowsFile: file, index });
      byRun.set(runId, list);
    });
  }
  return byRun;
}

/** First unused <old>-regrade-<n> run id (checked against known run ids AND existing rows files). */
export function allocateRegradeRunId(benchmarkDir: string, runId: string, knownRunIds: Set<string>): string {
  const dir = resolve(benchmarkDir);
  for (let n = 1; ; n += 1) {
    const candidate = `${runId}-regrade-${n}`;
    const prefix = `rows-${sanitizeForFile(candidate)}-`;
    let taken = knownRunIds.has(candidate);
    if (!taken) {
      try { taken = readdirSync(dir).some((name) => name.startsWith(prefix)); } catch { taken = false; }
    }
    if (!taken) return candidate;
  }
}

/* ------------------------------------------------------------------ */
/* Regrade                                                             */
/* ------------------------------------------------------------------ */

/**
 * The versions.jsonl line a regrade appends: one MINOR bump per regraded
 * task. A regrade re-judges retained trajectories against the CURRENT
 * verifier — the moment its rows land, the pre-regrade rows for those tasks
 * are superseded evidence and must go STALE (isRowStale keys on this entry's
 * created_at), otherwise leaderboard aggregates would average both
 * generations: the task weighted twice, old-verifier and new-verifier scores
 * blended. `created_at` must be captured BEFORE any new row is stamped so
 * the regraded rows themselves stay fresh. Pure — the caller appends
 * serializeVersionEntryLine(entry) (ledgers are append-only).
 */
export function regradeVersionEntry(
  manifest: Obj,
  priorVersionLines: Obj[],
  taskBumps: VersionTaskBump[],
  createdAt: string,
  note: string,
): BenchmarkVersionEntry {
  const lastLine = priorVersionLines.length > 0 ? asObject(priorVersionLines[priorVersionLines.length - 1]) : null;
  const lastVersion = typeof lastLine?.version === "string" && lastLine.version.trim() ? lastLine.version : null;
  const manifestVersion = typeof manifest.version === "string" && manifest.version.trim() ? manifest.version : null;
  const splits = asObject(manifest.splits);
  const contamination = splits.contamination;
  return {
    schema_version: "understudy.benchmark_version.v1",
    created_at: createdAt,
    version: bumpVersion(lastVersion ?? manifestVersion ?? "1.0.0", "minor"),
    splits_sha256: typeof splits.splits_sha256 === "string" ? splits.splits_sha256 : null,
    contamination:
      contamination === "clean" || contamination === "contaminated" || contamination === "unknown" ? contamination : null,
    note,
    task_bumps: taskBumps,
  };
}

/**
 * Regrade one benchmark dir's runs. Returns one summary per source run
 * (deterministic run_id order). With dryRun, nothing is written — the summary
 * IS the plan. When rows ARE written, one understudy.benchmark_version.v1
 * line (MINOR bump per regraded task) is appended to versions.jsonl so the
 * superseded source rows go stale instead of double-counting.
 */
export function regradeRuns(benchmarkDir: string, options: RegradeOptions = {}): RegradeRunSummary[] {
  const dir = resolve(benchmarkDir);
  const now = options.now ?? (() => new Date());
  const dryRun = options.dryRun === true;
  // Captured before any new row is stamped: rows created at/after this
  // instant survive the staleness gate; everything earlier is superseded.
  const versionStampedAt = now().toISOString();
  const manifest = asObject(JSON.parse(readFileSync(join(dir, "benchmark.json"), "utf8")));
  const replayable = asObject(manifest.verifier).replayable === true;
  // CURRENT verifier definition: the tasks' outcome contracts as they stand NOW.
  const sidecarTasks = new Map(
    readJsonlFile<Obj>(join(dir, "tasks.jsonl")).items.map((t) => [String(t.task_id), t]),
  );
  const byRun = readAllRows(dir);
  const knownRunIds = new Set(byRun.keys());
  const wantedTasks = options.taskIds && options.taskIds.length > 0 ? new Set(options.taskIds) : null;

  const runIds = options.runId
    ? byRun.has(options.runId) ? [options.runId] : []
    : [...byRun.keys()].sort();
  if (options.runId && runIds.length === 0) throw new Error(`no rows found for run ${options.runId} in ${dir}`);

  const summaries: RegradeRunSummary[] = [];
  const bumpedTasks = new Map<string, VersionTaskBump>();
  for (const runId of runIds) {
    const sourceRows = (byRun.get(runId) ?? []).filter(
      (s) => wantedTasks === null || wantedTasks.has(String(s.row.task_id)),
    );
    if (sourceRows.length === 0) continue;
    const tracesByModel = new Map<string, Map<string, TraceEvidence>>();
    const regraded: RegradedRow[] = [];
    const skipped: RegradeSkip[] = [];
    const newRows: Obj[] = [];
    const newRunId = allocateRegradeRunId(dir, runId, knownRunIds);

    for (const { row, rowsFile, index } of sourceRows) {
      const taskId = String(row.task_id);
      const model = String(row.model ?? "");
      const rollout = typeof row.rollout === "number" ? row.rollout : 0;
      const skip = (reason: RegradeSkipReason) => skipped.push({ task_id: taskId, model, rollout, reason });
      // A row that is itself a regrade output is only re-regraded when its
      // run was requested EXPLICITLY (no accidental regrade-of-regrade loops).
      if (!options.runId && asObject(asObject(row.provenance).source_run).action === "regrade") { skip("already_regraded_row"); continue; }
      if (!replayable) { skip("verifier_not_replayable"); continue; }
      const task = sidecarTasks.get(taskId);
      if (!task) { skip("task_definition_missing"); continue; }
      if (!tracesByModel.has(model)) tracesByModel.set(model, loadRetainedTraces(dir, runId, model));
      const traces = tracesByModel.get(model)!;
      if (traces.size === 0) { skip("trace_missing"); continue; }
      const evidence = traces.get(taskId);
      if (!evidence) { skip("no_trace_for_task"); continue; }

      const replay = accumulateReplay(task, evidence.calls, evidence.finalResponse);
      const verdict = replay.verdict;
      const newScore = verdict.judgeable ? verdict.strict : null;
      const oldScore = typeof row.score === "number" ? row.score : null;
      const rowRef = `${basename(rowsFile)}#${index}`;
      regraded.push({
        task_id: taskId,
        model,
        rollout,
        old_score: oldScore,
        new_score: newScore,
        changed: oldScore !== newScore,
        row_ref: rowRef,
      });
      // New row = the old row re-stamped: new run_id, new verdict, regrade
      // provenance. Cost/tokens/latency/route/arm provenance are PRESERVED
      // from the original row — the spend happened once and stays recorded.
      newRows.push({
        ...row,
        run_id: newRunId,
        score: newScore,
        subscores: verdict.judgeable
          ? {
              final_state: verdict.strict,
              ...(verdict.recall !== null ? { recall: verdict.recall, final_state_partial_credit: verdict.recall } : {}),
              ...(verdict.precision !== null ? { precision: verdict.precision } : {}),
              ...(verdict.policy !== null ? { policy: verdict.policy } : {}),
            }
          : null,
        status: verdict.judgeable ? "ok" : "unscored",
        created_at: now().toISOString(),
        provenance: {
          ...asObject(row.provenance),
          source_run: { action: "regrade", run_id: runId, row_ref: rowRef },
        },
      });
    }

    // Delta over rows where BOTH scores are numeric (honest means, no null coercion).
    const comparable = regraded.filter((r) => r.old_score !== null && r.new_score !== null);
    const mean = (values: number[]): number | null =>
      values.length === 0 ? null : Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4));
    const up = comparable.filter((r) => (r.new_score as number) > (r.old_score as number)).length;
    const down = comparable.filter((r) => (r.new_score as number) < (r.old_score as number)).length;

    if (!dryRun && newRows.length > 0) {
      // One rows file per (new run, model) — the executor's own layout.
      const byModel = new Map<string, Obj[]>();
      for (const row of newRows) {
        const model = String(row.model ?? "");
        byModel.set(model, [...(byModel.get(model) ?? []), row]);
      }
      for (const [model, rows] of byModel) appendJsonlRows(rowsFilePath(dir, newRunId, model), rows);
      // Every regraded task gets a MINOR bump on the invocation's single
      // versions.jsonl entry (appended once, below). from is null — the
      // verifier edit that motivated the regrade was not necessarily
      // recorded, so the pre-change task semver is unknown here.
      for (const r of regraded) {
        if (bumpedTasks.has(r.task_id)) continue;
        const taskVersion = sidecarTasks.get(r.task_id)?.version;
        bumpedTasks.set(r.task_id, {
          task_id: r.task_id,
          bump: "minor",
          from: null,
          to: typeof taskVersion === "string" && taskVersion.trim() ? taskVersion : null,
          reason: `regraded under current verifier (${runId} -> ${newRunId})`,
        });
      }
    }

    summaries.push({
      run_id: runId,
      new_run_id: regraded.length > 0 ? newRunId : null,
      dry_run: dryRun,
      rows_considered: sourceRows.length,
      regraded,
      skipped,
      delta: {
        changed: regraded.filter((r) => r.changed).length,
        up,
        down,
        mean_before: mean(comparable.map((r) => r.old_score as number)),
        mean_after: mean(comparable.map((r) => r.new_score as number)),
      },
      version_entry: null,
    });
  }

  if (!dryRun && bumpedTasks.size > 0) {
    const taskBumps = [...bumpedTasks.values()].sort((a, b) => a.task_id.localeCompare(b.task_id));
    const rescored = summaries.reduce((n, s) => n + s.regraded.length, 0);
    const entry = regradeVersionEntry(
      manifest,
      readJsonlFile<Obj>(join(dir, "versions.jsonl")).items,
      taskBumps,
      versionStampedAt,
      `runs regrade: rescored ${rescored} row(s) across ${summaries.filter((s) => s.new_run_id !== null).length} run(s) under the current verifier`,
    );
    appendFileSync(join(dir, "versions.jsonl"), serializeVersionEntryLine(entry), "utf8");
    for (const summary of summaries) summary.version_entry = entry;
  }
  return summaries;
}

/** Human delta line: "3 changed (1 up, 2 down), mean reward 0.67 -> 0.33". */
export function formatRegradeDelta(summary: RegradeRunSummary): string {
  const { changed, up, down, mean_before, mean_after } = summary.delta;
  const means = mean_before !== null && mean_after !== null ? `, mean reward ${mean_before} -> ${mean_after}` : "";
  const action = summary.dry_run ? "would regrade" : "regraded";
  return `${summary.run_id}: ${action} ${summary.regraded.length}/${summary.rows_considered} rows${summary.new_run_id ? ` as ${summary.new_run_id}` : ""} — ${changed} changed (${up} up, ${down} down)${means}; ${summary.skipped.length} skipped`;
}
