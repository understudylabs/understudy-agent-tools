/**
 * File-based benchmark run queue + executor.
 *
 * Contract (settled): the hub UI NEVER orchestrates execution. It only writes
 * `understudy.run_request.v1` JSON files into <benchmark-dir>/runs/queue/ and
 * re-reads them to render status. `understudy runs execute` (this module) is
 * the only thing that runs models: it picks up queued requests, executes the
 * benchmark's generated verifiers environment per model arm (REUSING the
 * run-replays invocation — allowlisted env + --no-push privacy wiring — never
 * forking it), converts results to understudy.eval_result.v1 rows, and streams
 * progress as it goes:
 *   - per-rollout events append to <dir>/runs/events.jsonl
 *   - rows append to <dir>/rows-<run_id>-<model>.jsonl (the hub's row glob)
 *   - the request file's status/progress is rewritten after every rollout
 * Cancellation is a status flip on the request file (the hub API does it);
 * the executor honors it between rollouts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildReplayInvocation, isMutatingTool, scoreState } from "./trace-foundry.js";
import { COST_PER_MTOKEN, resolveGatewayAuth } from "./trace-author.js";
import { BENCHMARK_PROPOSAL_SCHEMA, BENCHMARK_SCHEMA, CALIBRATION_SCHEMA, EVAL_RESULT_SCHEMA, RUN_EVENT_SCHEMA, appendJournalEntry, readJsonlFile, serializeJsonlLine, serializeRunEvent } from "./benchmark-artifacts.js";

type Obj = Record<string, any>;
const asObject = (value: unknown): Obj => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const RUN_REQUEST_SCHEMA = "understudy.run_request.v1";
export const RUN_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RUN_SPLITS = ["train", "dev", "holdout", "all"] as const;
export type RunSplit = (typeof RUN_SPLITS)[number];

/** Row arm labels: "incumbent" = the model that produced the source captures, rerun; everything else is a "candidate". */
export const ARM_KINDS = ["incumbent", "candidate"] as const;
export type ArmKind = (typeof ARM_KINDS)[number];
/** Default incumbent-pass threshold on the strict contract score. */
export const DEFAULT_CALIBRATION_THRESHOLD = 1;

export type RunRequest = {
  schema_version: typeof RUN_REQUEST_SCHEMA;
  run_id: string;
  benchmark_id: string;
  models: string[];
  split: RunSplit;
  tasks: "all" | string[];
  rollouts_per_task: number;
  created_at: string;
  status: RunStatus;
  progress: { completed: number; total: number };
  started_at?: string | null;
  finished_at?: string | null;
  /** Present when status is failed: the honest error class + message. */
  error?: { class: string; message: string } | null;
  /** While running: the active arm's live journal (path relative to the benchmark dir) + what's executing. */
  live?: { journal: string; model: string; task_id: string | null } | null;
  /**
   * Additive (absent on old requests — existing readers ignore it): models in
   * this run that are the benchmark's recorded incumbent. Their rows are
   * labeled arm_kind "incumbent" and feed the calibration gate.
   */
  incumbent_models?: string[];
  /** Additive: strict-score pass threshold for the incumbent calibration gate (default 1). */
  calibration_threshold?: number;
};

/** Live journals live under <benchmark>/runs/live/ and stay after the run for replay-scrubbing. */
export function liveJournalPath(benchmarkDir: string, runId: string, model: string): string {
  return join(runsDir(benchmarkDir), "live", `${sanitizeForFile(runId)}-${sanitizeForFile(model)}.jsonl`);
}

export function runsDir(benchmarkDir: string): string {
  return join(resolve(benchmarkDir), "runs");
}
export function runsQueueDir(benchmarkDir: string): string {
  return join(runsDir(benchmarkDir), "queue");
}
export function runRequestPath(benchmarkDir: string, runId: string): string {
  return join(runsQueueDir(benchmarkDir), `${runId}.json`);
}
export function runEventsPath(benchmarkDir: string): string {
  return join(runsDir(benchmarkDir), "events.jsonl");
}

/** Atomic-ish request write: tmp file + rename so the hub never reads a torn JSON. */
export function writeRunRequest(benchmarkDir: string, request: RunRequest): string {
  const dir = runsQueueDir(benchmarkDir);
  mkdirSync(dir, { recursive: true });
  const file = runRequestPath(benchmarkDir, request.run_id);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

export function readRunRequest(file: string): RunRequest | null {
  try {
    const parsed = asObject(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.schema_version !== RUN_REQUEST_SCHEMA || typeof parsed.run_id !== "string") return null;
    return parsed as RunRequest;
  } catch {
    return null;
  }
}

/** All request files, oldest first (creation order). */
export function listRunRequests(benchmarkDir: string): RunRequest[] {
  const dir = runsQueueDir(benchmarkDir);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const requests: RunRequest[] = [];
  for (const name of names) {
    const request = readRunRequest(join(dir, name));
    if (request) requests.push(request);
  }
  return requests.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.run_id.localeCompare(b.run_id));
}

export type RunRequestInput = {
  benchmark_id: string;
  models: unknown;
  split: unknown;
  tasks: unknown;
  rollouts_per_task: unknown;
  /** Optional (additive): the subset of `models` to label as the incumbent arm. */
  incumbent_models?: unknown;
  /** Optional (additive): calibration pass threshold in (0, 1]. */
  calibration_threshold?: unknown;
};

export const MAX_MODELS_PER_RUN = 8;
export const MAX_ROLLOUTS_PER_TASK = 20;
/** Per-arm eval-example cap passed to the verifiers subprocess (-n); binding it is recorded, never silent. */
export const VERIFIERS_MAX_EXAMPLES = 1000;

/**
 * Validate a run-request body against the benchmark's known task ids.
 * Returns human-readable errors; empty means valid. Shared by the hub API
 * (POST /api/runs) and the CLI so the two never drift.
 */
export function validateRunRequestInput(input: RunRequestInput, knownTaskIds: string[]): string[] {
  const errors: string[] = [];
  const models = input.models;
  if (!Array.isArray(models) || models.length === 0 || !models.every((m) => typeof m === "string" && m.trim().length > 0)) {
    errors.push("models must be a non-empty array of model id strings");
  } else {
    if (models.length > MAX_MODELS_PER_RUN) errors.push(`at most ${MAX_MODELS_PER_RUN} models per run`);
    if (new Set(models).size !== models.length) errors.push("models must be unique");
  }
  if (!RUN_SPLITS.includes(input.split as RunSplit)) errors.push(`split must be one of ${RUN_SPLITS.join(", ")}`);
  const tasks = input.tasks;
  if (tasks !== "all") {
    if (!Array.isArray(tasks) || tasks.length === 0 || !tasks.every((t) => typeof t === "string")) {
      errors.push('tasks must be "all" or a non-empty array of task ids');
    } else {
      const known = new Set(knownTaskIds);
      for (const t of tasks) if (!known.has(t)) errors.push(`unknown task_id: ${t}`);
    }
  }
  const rollouts = input.rollouts_per_task;
  if (!Number.isInteger(rollouts) || (rollouts as number) <= 0 || (rollouts as number) > MAX_ROLLOUTS_PER_TASK) {
    errors.push(`rollouts_per_task must be an integer between 1 and ${MAX_ROLLOUTS_PER_TASK}`);
  }
  const incumbents = input.incumbent_models;
  if (incumbents !== undefined) {
    if (!Array.isArray(incumbents) || !incumbents.every((m) => typeof m === "string" && m.trim().length > 0)) {
      errors.push("incumbent_models must be an array of model id strings");
    } else if (Array.isArray(models) && !incumbents.every((m) => models.includes(m))) {
      errors.push("incumbent_models must be a subset of models");
    }
  }
  const threshold = input.calibration_threshold;
  if (threshold !== undefined && (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1)) {
    errors.push("calibration_threshold must be a number in (0, 1]");
  }
  return errors;
}

/** Create + persist a queued run request. Caller validates first. */
export function createRunRequest(
  benchmarkDir: string,
  input: { benchmark_id: string; models: string[]; split: RunSplit; tasks: "all" | string[]; rollouts_per_task: number; incumbent_models?: string[]; calibration_threshold?: number },
  now: Date = new Date(),
): RunRequest {
  const request: RunRequest = {
    schema_version: RUN_REQUEST_SCHEMA,
    run_id: `run-${hash({ ...input, at: now.toISOString(), nonce: Math.random() }).slice(0, 16)}`,
    benchmark_id: input.benchmark_id,
    models: input.models,
    split: input.split,
    tasks: input.tasks,
    rollouts_per_task: input.rollouts_per_task,
    created_at: now.toISOString(),
    status: "queued",
    progress: { completed: 0, total: 0 },
    started_at: null,
    finished_at: null,
    error: null,
    // Additive fields stay absent unless requested, so old readers see the exact prior shape.
    ...(input.incumbent_models && input.incumbent_models.length > 0 ? { incumbent_models: input.incumbent_models } : {}),
    ...(input.calibration_threshold !== undefined ? { calibration_threshold: input.calibration_threshold } : {}),
  };
  writeRunRequest(benchmarkDir, request);
  return request;
}

/**
 * Cancel = status flip on the request file. Only queued/running requests can
 * be cancelled; the executor honors the flip between rollouts.
 */
export function cancelRunRequest(benchmarkDir: string, runId: string): { ok: true; request: RunRequest } | { ok: false; error: string; status: number } {
  const file = runRequestPath(benchmarkDir, runId);
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return { ok: false, error: "invalid run_id", status: 400 };
  const request = existsSync(file) ? readRunRequest(file) : null;
  if (!request) return { ok: false, error: "unknown run_id", status: 404 };
  if (request.status !== "queued" && request.status !== "running") {
    return { ok: false, error: `run is already ${request.status}`, status: 409 };
  }
  const updated: RunRequest = { ...request, status: "cancelled", finished_at: new Date().toISOString() };
  writeRunRequest(benchmarkDir, updated);
  return { ok: true, request: updated };
}

/* ------------------------------------------------------------------ */
/* Executor                                                            */
/* ------------------------------------------------------------------ */

export type RolloutResult = {
  score: number | null;
  subscores: Record<string, number> | null;
  status: "ok" | "error" | "unscored";
  latency_ms: number | null;
  cost: number | null;
  /** Mutating tool calls the arm performed — feeds the hub's per-arm accumulation replay. */
  writes: { tool: string; arguments: unknown }[];
  /** Total tool calls (reads AND writes) the arm made; null = the runner cannot tell (anomaly checks fall back to writes). */
  tool_call_count?: number | null;
  /** Character count of the final assistant response; null = the runner cannot tell (never treated as empty). */
  final_response_chars?: number | null;
  error?: string | null;
};

/* ------------------------------------------------------------------ */
/* Rollout anomaly sentinels — the "silent zero" gate                  */
/* ------------------------------------------------------------------ */

/**
 * Structural sentinels evaluated after every rollout, BEFORE its score is
 * trusted. Each kind is a failure class we have already shipped once:
 * display-title-instead-of-prompt (fixed in defa40d), journals rendering
 * empty (#323), and all-zero scores indistinguishable from harness failure.
 * Anomalous rows are marked (`anomaly` on the row) and excluded from
 * leaderboard aggregates by default — never silently dropped.
 */
export type RolloutAnomalyKind =
  | "empty_prompt"
  | "no_tool_calls"
  | "empty_final_response"
  | "no_journal_events"
  | "zero_score_zero_calls";

export type RolloutAnomaly = { kind: RolloutAnomalyKind; detail: string };

const textOfContent = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => String(asObject(b).text ?? "")).join("") : "";

export function detectRolloutAnomalies(args: {
  /** Sidecar task (understudy.benchmark_task.v1) — carries the outcome contract + title. */
  task: Obj;
  result: RolloutResult;
  /** The prompt actually sent to the model (generated environment tasks.json row); undefined = unknown, skip the check. */
  promptSent?: string | null;
  /** The task's stored source prompt (first user message of source_messages); undefined = unknown. */
  storedPrompt?: string | null;
  /** Bytes present in the arm's live journal after this rollout; undefined = unknown, skip the check. */
  journalBytes?: number | null;
}): RolloutAnomaly[] {
  const anomalies: RolloutAnomaly[] = [];
  const { task, result } = args;
  const title = String(task.title ?? "").trim();

  // (a) empty or near-empty prompt sent to the model — including the
  // display-title-instead-of-full-prompt class (defa40d).
  if (args.promptSent !== undefined && args.promptSent !== null) {
    const prompt = String(args.promptSent).trim();
    const stored = String(args.storedPrompt ?? "").trim();
    if (prompt.length === 0) {
      anomalies.push({ kind: "empty_prompt", detail: "prompt sent to the model is empty" });
    } else if (stored.length >= 32 && prompt === title && title !== stored) {
      anomalies.push({ kind: "empty_prompt", detail: `prompt sent equals the display title (${prompt.length} chars) while the stored task prompt is ${stored.length} chars` });
    } else if (stored.length >= 400 && prompt.length < stored.length * 0.1) {
      anomalies.push({ kind: "empty_prompt", detail: `prompt sent is ${prompt.length} chars vs ${stored.length} chars stored for the task` });
    }
  }

  // Sentinels below judge completed rollouts only: error/unscored rows are
  // already untrusted by every aggregate.
  if (result.status !== "ok") return anomalies;
  const required = ((asObject(task.outcome_contract).required ?? []) as unknown[]).map(asObject);
  const calls = typeof result.tool_call_count === "number" ? result.tool_call_count : result.writes.length;

  // (b) zero tool calls on a task whose contract requires state effects.
  const stateRules = required.filter((rule) => String(rule.type ?? "state_effect") === "state_effect").length;
  if (stateRules > 0 && calls === 0) {
    anomalies.push({ kind: "no_tool_calls", detail: `contract requires ${stateRules} state effect(s) but the rollout made zero tool calls` });
  }

  // (c) empty final response where the contract carries response obligations.
  const responseRules = required.filter(
    (rule) => String(rule.type ?? "") === "response_obligation" || (String(rule.type ?? "") === "value_propagation" && asObject(rule.must_reach).kind === "final_response"),
  ).length;
  if (responseRules > 0 && result.final_response_chars === 0) {
    anomalies.push({ kind: "empty_final_response", detail: `contract has ${responseRules} response obligation(s) but the final response is empty` });
  }

  // (d) journal/row write anomaly: a completed rollout left zero live-journal events.
  if (args.journalBytes === 0) {
    anomalies.push({ kind: "no_journal_events", detail: "rollout completed but the live journal recorded zero events" });
  }

  // (e) all-zero contract score with zero tool calls — indistinguishable from
  // a harness failure, so it must never be trusted as an honest 0.
  if (result.score === 0 && calls === 0) {
    anomalies.push({ kind: "zero_score_zero_calls", detail: "score is 0 and the rollout made zero tool calls — indistinguishable from harness failure" });
  }
  return anomalies;
}

/** True when a persisted eval row carries a structural-sentinel flag (same predicate as the hub's isAnomalousRow). */
export function isAnomalousEvalRow(row: Obj): boolean {
  const anomaly = row.anomaly;
  return anomaly != null && typeof anomaly === "object" && typeof (anomaly as Obj).kind === "string";
}

export type ArmRunner = (args: {
  benchmarkDir: string;
  model: string;
  task: Obj;
  rollout: number;
  /** Every task_id the run request selected — arm-level runners scope their eval to exactly these. */
  selectedTaskIds: string[];
  /** Live journal file for this arm (runners/worlds append one JSON line per tool call/result); null disables. */
  journalPath: string | null;
}) => Promise<RolloutResult>;

export type RunEvent = {
  schema_version: typeof RUN_EVENT_SCHEMA;
  ts: string;
  run_id: string;
  type: "run_started" | "arm_started" | "rollout" | "rollout_error" | "arm_finished" | "run_finished" | "run_cancelled" | "run_failed" | "cap_warning";
  model?: string;
  task_id?: string;
  rollout?: number;
  score?: number | null;
  status?: string;
  error?: string | null;
  progress?: { completed: number; total: number };
  /** Structural sentinel that fired on this rollout (additive; absent when clean). */
  anomaly?: RolloutAnomaly | null;
  /** Explicit no-silent-caps record: present on cap_warning events when a hard cap binds. */
  warning?: string;
};

function appendEvent(benchmarkDir: string, event: RunEvent, onEvent?: (event: RunEvent) => void): void {
  mkdirSync(runsDir(benchmarkDir), { recursive: true });
  appendFileSync(runEventsPath(benchmarkDir), serializeRunEvent(event), { mode: 0o600 });
  onEvent?.(event);
}

const sanitizeForFile = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);

export function rowsFilePath(benchmarkDir: string, runId: string, model: string): string {
  return join(resolve(benchmarkDir), `rows-${sanitizeForFile(runId)}-${sanitizeForFile(model)}.jsonl`);
}

function readJsonl(path: string): Obj[] {
  return existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => asObject(JSON.parse(line))) : [];
}

/** The tasks a request selects: manifest tasks filtered by split + explicit ids. */
export function selectTasks(manifest: Obj, request: Pick<RunRequest, "split" | "tasks">): Obj[] {
  const tasks = (Array.isArray(manifest.tasks) ? manifest.tasks : []).map(asObject);
  const bySplit = request.split === "all" ? tasks : tasks.filter((t) => t.split === request.split);
  if (request.tasks === "all") return bySplit;
  const wanted = new Set(request.tasks);
  return bySplit.filter((t) => wanted.has(String(t.task_id)));
}

export type ExecuteOptions = {
  runner: ArmRunner;
  /** Rollouts in flight per arm (the concurrency flag). */
  concurrency?: number;
  now?: () => Date;
  onEvent?: (event: RunEvent) => void;
};

/**
 * Execute ONE queued request to a terminal state. State machine:
 * queued → running → done | failed | cancelled. Progress persists to the
 * request file after every rollout, so a killed executor resumes honestly
 * (rows/events already written stay; the hub renders partial progress).
 * Cancellation (an external status flip) is honored between rollouts.
 */
export async function executeRunRequest(benchmarkDir: string, runId: string, options: ExecuteOptions): Promise<RunRequest> {
  const dir = resolve(benchmarkDir);
  const now = options.now ?? (() => new Date());
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error("--concurrency must be a positive integer");
  const file = runRequestPath(dir, runId);
  const initial = readRunRequest(file);
  if (!initial) throw new Error(`No run request ${runId} in ${runsQueueDir(dir)}`);
  if (initial.status !== "queued") throw new Error(`Run ${runId} is ${initial.status}, not queued`);
  let request: RunRequest = initial;

  const manifest = asObject(JSON.parse(readFileSync(join(dir, "benchmark.json"), "utf8")));
  // Promoted manifests always run; proposal-stamped dirs run too — the hub
  // API gates proposed queueing to single ACCEPTED tasks with a validated
  // environment, and the generated environment/ is identical either way.
  if (![BENCHMARK_SCHEMA, BENCHMARK_PROPOSAL_SCHEMA].includes(String(manifest.schema_version))) {
    throw new Error("benchmark.json is neither understudy.benchmark.v1 nor understudy.benchmark_proposal.v1; rebuild or promote the benchmark first.");
  }
  const manifestTasks = new Map((Array.isArray(manifest.tasks) ? manifest.tasks : []).map((t: Obj) => [String(t.task_id), asObject(t)]));
  // The foundry sidecar carries the outcome contracts the runners score against.
  const sidecarTasks = new Map(readJsonl(join(dir, "tasks.jsonl")).map((t) => [String(t.task_id), t]));
  const selected = selectTasks(manifest, request);
  if (selected.length === 0) {
    request = { ...request, status: "failed", finished_at: now().toISOString(), error: { class: "EmptySelection", message: `no tasks match split=${request.split}` } };
    writeRunRequest(dir, request);
    appendEvent(dir, { schema_version: RUN_EVENT_SCHEMA, ts: now().toISOString(), run_id: runId, type: "run_failed", error: request.error?.message }, options.onEvent);
    return request;
  }

  const total = request.models.length * selected.length * request.rollouts_per_task;
  request = { ...request, status: "running", started_at: now().toISOString(), progress: { completed: 0, total } };
  writeRunRequest(dir, request);
  appendEvent(dir, { schema_version: RUN_EVENT_SCHEMA, ts: now().toISOString(), run_id: runId, type: "run_started", progress: request.progress }, options.onEvent);
  // No silent caps: the verifiers arm evals at most VERIFIERS_MAX_EXAMPLES
  // tasks per split (-n); a selection past that would be silently dropped by
  // the eval harness, so the binding cap is recorded as an explicit event.
  if (selected.length > VERIFIERS_MAX_EXAMPLES) {
    appendEvent(dir, { schema_version: RUN_EVENT_SCHEMA, ts: now().toISOString(), run_id: runId, type: "cap_warning", warning: `selected ${selected.length} tasks exceeds the per-arm eval cap of ${VERIFIERS_MAX_EXAMPLES}; tasks beyond the cap may be dropped by the eval harness` }, options.onEvent);
  }

  // Generated-environment task rows (prompt actually sent + stored source
  // messages) feed the prompt sentinels; absent/unreadable = checks skipped.
  let envTaskRows = new Map<string, Obj>();
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "environment", "understudy_trace_env", "tasks.json"), "utf8"));
    if (Array.isArray(parsed)) envTaskRows = new Map(parsed.map((row: unknown) => [String(asObject(row).task_id), asObject(row)]));
  } catch { /* no generated environment — prompt sentinels skipped */ }

  const cancelled = (): boolean => readRunRequest(file)?.status === "cancelled";
  let completed = 0;
  const persistProgress = () => {
    // Re-read before writing so an external cancel flip is never clobbered.
    const current = readRunRequest(file) ?? request;
    request = { ...current, progress: { completed, total } };
    writeRunRequest(dir, request);
  };

  try {
    for (const model of request.models) {
      if (cancelled()) break;
      appendEvent(dir, { schema_version: RUN_EVENT_SCHEMA, ts: now().toISOString(), run_id: runId, type: "arm_started", model }, options.onEvent);
      const rowsFile = rowsFilePath(dir, runId, model);
      // Live journal for this arm: the world/runner appends tool events the
      // moment they happen; the hub's live endpoint tails it. The path is
      // advertised on the request file so the UI knows what's executing.
      const journalPath = liveJournalPath(dir, runId, model);
      mkdirSync(join(runsDir(dir), "live"), { recursive: true });
      const journalRel = relative(dir, journalPath);
      // Work items for this arm; a bounded pool honors --concurrency while the
      // cancel check between dequeues keeps the flip responsive.
      const queue: { task: Obj; rollout: number }[] = [];
      for (const task of selected) for (let rollout = 0; rollout < request.rollouts_per_task; rollout += 1) queue.push({ task, rollout });
      let armCancelled = false;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (armCancelled || cancelled()) {
            armCancelled = true;
            return;
          }
          const item = queue.shift();
          if (!item) return;
          const taskId = String(item.task.task_id);
          const sidecar = sidecarTasks.get(taskId) ?? item.task;
          // Advertise what's executing (journal + model + task) on the request
          // file so the hub can attach a live watcher.
          const current = readRunRequest(file) ?? request;
          request = { ...current, live: { journal: journalRel, model, task_id: taskId } };
          writeRunRequest(dir, request);
          let result: RolloutResult;
          try {
            result = await options.runner({ benchmarkDir: dir, model, task: sidecar, rollout: item.rollout, selectedTaskIds: selected.map((t) => String(t.task_id)), journalPath });
          } catch (err) {
            result = { score: null, subscores: null, status: "error", latency_ms: null, cost: null, writes: [], error: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err) };
          }
          // Defensive: an empty contract is not judgeable — rows are unscored,
          // never ok-with-vacuous-numbers. (The foundry now guarantees a
          // fallback rubric, so this should be unreachable on fresh builds.)
          if (((asObject(sidecar.outcome_contract).required ?? []) as unknown[]).length === 0 && result.status === "ok") {
            result = { ...result, score: null, subscores: null, status: "unscored", error: "empty contract — not judgeable; regenerate-env synthesizes a fallback rubric" };
          }
          // Structural sentinels before the score is trusted: anomalous rows
          // are marked on the row (and its event), never silently dropped —
          // the hub excludes them from aggregates but keeps the counts visible.
          const envRow = envTaskRows.get(taskId);
          let journalBytes: number | null = null;
          try { journalBytes = statSync(journalPath).size; } catch { journalBytes = 0; }
          const anomalies = detectRolloutAnomalies({
            task: sidecar,
            result,
            promptSent: envRow === undefined ? undefined : String(envRow.prompt ?? ""),
            storedPrompt: envRow === undefined ? undefined : textOfContent(((Array.isArray(envRow.source_messages) ? envRow.source_messages : []).map(asObject).find((m) => m.role === "user") ?? {}).content),
            journalBytes,
          });
          const row: Obj = {
            schema_version: EVAL_RESULT_SCHEMA,
            run_id: runId,
            task_id: taskId,
            split: item.task.split ?? "none",
            score: result.score,
            subscores: result.subscores,
            status: result.status,
            model,
            // Additive arm label: incumbent reruns are distinguishable from
            // candidate arms everywhere downstream (hub badges, calibration).
            arm_kind: (request.incumbent_models ?? []).includes(model) ? "incumbent" : "candidate",
            route: "gateway",
            latency_ms: result.latency_ms,
            cost: result.cost,
            created_at: now().toISOString(),
            benchmark_id: String(manifest.benchmark_id),
            category_id: manifestTasks.get(taskId)?.category_id ?? null,
            rollout: item.rollout,
            // Extension: the arm's mutating calls, so the hub can replay the
            // contract accumulation for this arm next to the oracle.
            writes: result.writes,
            ...(typeof result.tool_call_count === "number" ? { tool_call_count: result.tool_call_count } : {}),
            ...(typeof result.final_response_chars === "number" ? { final_response_chars: result.final_response_chars } : {}),
            // Marked, not dropped: the primary anomaly plus the full list.
            ...(anomalies.length > 0 ? { anomaly: anomalies[0], anomalies } : {}),
            ...(result.error ? { error: result.error } : {}),
          };
          appendFileSync(rowsFile, serializeJsonlLine(row), { mode: 0o600 });
          completed += 1;
          appendEvent(
            dir,
            {
              schema_version: RUN_EVENT_SCHEMA,
              ts: now().toISOString(),
              run_id: runId,
              type: result.status === "error" ? "rollout_error" : "rollout",
              model,
              task_id: taskId,
              rollout: item.rollout,
              score: result.score,
              status: result.status,
              error: result.error ?? null,
              progress: { completed, total },
              ...(anomalies.length > 0 ? { anomaly: anomalies[0] } : {}),
            },
            options.onEvent,
          );
          persistProgress();
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
      appendEvent(dir, { schema_version: RUN_EVENT_SCHEMA, ts: now().toISOString(), run_id: runId, type: "arm_finished", model, progress: { completed, total } }, options.onEvent);
      if (armCancelled) break;
    }
  } catch (err) {
    // A hard arm failure (e.g. HarnessError from the verifiers subprocess) is
    // surfaced honestly: events carry the message, the request records the class.
    const message = err instanceof Error ? err.message : String(err);
    const errorClass = err instanceof Error ? err.constructor.name : "Error";
    request = { ...(readRunRequest(file) ?? request), status: "failed", finished_at: now().toISOString(), progress: { completed, total }, live: null, error: { class: errorClass, message } };
    writeRunRequest(dir, request);
    appendEvent(dir, { schema_version: RUN_EVENT_SCHEMA, ts: now().toISOString(), run_id: runId, type: "run_failed", error: `${errorClass}: ${message}`, progress: { completed, total } }, options.onEvent);
    return request;
  }

  if (cancelled()) {
    request = { ...(readRunRequest(file) ?? request), progress: { completed, total }, live: null };
    writeRunRequest(dir, request);
    appendEvent(dir, { schema_version: RUN_EVENT_SCHEMA, ts: now().toISOString(), run_id: runId, type: "run_cancelled", progress: { completed, total } }, options.onEvent);
    return request;
  }

  request = { ...(readRunRequest(file) ?? request), status: "done", finished_at: now().toISOString(), progress: { completed, total }, live: null };
  writeRunRequest(dir, request);
  appendEvent(dir, { schema_version: RUN_EVENT_SCHEMA, ts: now().toISOString(), run_id: runId, type: "run_finished", progress: { completed, total } }, options.onEvent);
  // Calibration gate: a finished run with an incumbent arm updates the
  // benchmark's calibration.json sidecar from its own rows + run events.
  if ((request.incumbent_models ?? []).length > 0) writeCalibrationSummary(dir, request, selected.map((t) => String(t.task_id)));
  return request;
}

/* ------------------------------------------------------------------ */
/* Incumbent calibration gate                                          */
/* ------------------------------------------------------------------ */

export function calibrationPath(benchmarkDir: string): string {
  return join(resolve(benchmarkDir), "calibration.json");
}

export type CalibrationTask = { task_id: string; score: number | null; passed: boolean; rollouts: number; anomalous_rollouts: number };

export type CalibrationSummary = {
  schema_version: typeof CALIBRATION_SCHEMA;
  benchmark_id: string;
  run_id: string;
  incumbent_models: string[];
  threshold: number;
  /** Timestamps come from the run's own events (never a fresh clock read). */
  started_at: string | null;
  finished_at: string | null;
  tasks: CalibrationTask[];
  passed_count: number;
  failed_count: number;
  /** Tasks the incumbent fails on rerun — the hub flags these incumbent_failed (suspect). */
  failed_task_ids: string[];
};

/**
 * Derive the incumbent-pass signal per task from incumbent-arm rows: a task
 * passes when its BEST scored incumbent rollout reaches the threshold on the
 * strict contract score. Tasks with no ok row fail (the incumbent could not
 * reproduce its own outcome). Timestamps are read from the run's events, not
 * from a wall clock, so the summary is replay-stable.
 *
 * Same trust discipline as the hub leaderboard: rows flagged by the
 * structural sentinels (`row.anomaly`) NEVER enter the best-score
 * computation — an anomalous "pass" is indistinguishable from a harness
 * failure, so a task whose only ok rollouts are anomalous fails calibration.
 * Anomalous rollouts stay counted per task (marked, not dropped).
 */
export function deriveCalibrationSummary(args: {
  benchmarkId: string;
  runId: string;
  incumbentModels: string[];
  threshold?: number;
  selectedTaskIds: string[];
  rows: Obj[];
  events: Obj[];
}): CalibrationSummary {
  const threshold = args.threshold ?? DEFAULT_CALIBRATION_THRESHOLD;
  const incumbents = new Set(args.incumbentModels);
  const runEvents = args.events.filter((e) => e.run_id === args.runId);
  const eventTs = (type: string): string | null => {
    const event = runEvents.find((e) => e.type === type);
    return typeof event?.ts === "string" ? event.ts : null;
  };
  const rows = args.rows.filter((row) => row.run_id === args.runId && incumbents.has(String(row.model ?? "")));
  const tasks: CalibrationTask[] = args.selectedTaskIds.map((taskId) => {
    const taskRows = rows.filter((row) => String(row.task_id) === taskId);
    const anomalous = taskRows.filter(isAnomalousEvalRow);
    const scores = taskRows.filter((row) => !isAnomalousEvalRow(row) && row.status === "ok" && typeof row.score === "number").map((row) => Number(row.score));
    const best = scores.length > 0 ? Math.max(...scores) : null;
    return { task_id: taskId, score: best, passed: best !== null && best >= threshold, rollouts: taskRows.length, anomalous_rollouts: anomalous.length };
  });
  const failed = tasks.filter((task) => !task.passed);
  return {
    schema_version: CALIBRATION_SCHEMA,
    benchmark_id: args.benchmarkId,
    run_id: args.runId,
    incumbent_models: [...incumbents].sort(),
    threshold,
    started_at: eventTs("run_started"),
    finished_at: eventTs("run_finished"),
    tasks,
    passed_count: tasks.length - failed.length,
    failed_count: failed.length,
    failed_task_ids: failed.map((task) => task.task_id),
  };
}

/** Rebuild calibration.json from a finished incumbent run's rows + events. Best-effort: never fails the run. */
function writeCalibrationSummary(benchmarkDir: string, request: RunRequest, selectedTaskIds: string[]): void {
  try {
    // Rows/events re-read through the SHARED tolerant codec (never a private parser).
    const rows = (request.incumbent_models ?? []).flatMap((model) => readJsonlFile<Obj>(rowsFilePath(benchmarkDir, request.run_id, model)).items);
    const summary = deriveCalibrationSummary({
      benchmarkId: request.benchmark_id,
      runId: request.run_id,
      incumbentModels: request.incumbent_models ?? [],
      threshold: request.calibration_threshold,
      selectedTaskIds,
      rows,
      events: readJsonlFile<Obj>(runEventsPath(benchmarkDir)).items,
    });
    const file = calibrationPath(benchmarkDir);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // calibration is a derived sidecar — a write failure must not fail the run
  }
}

/** Execute every queued request once, oldest first. */
export async function executeQueuedRuns(benchmarkDir: string, options: ExecuteOptions): Promise<RunRequest[]> {
  const results: RunRequest[] = [];
  for (const request of listRunRequests(benchmarkDir)) {
    if (request.status !== "queued") continue;
    results.push(await executeRunRequest(benchmarkDir, request.run_id, options));
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Runners                                                             */
/* ------------------------------------------------------------------ */

/**
 * Offline validation-oracle runner: deterministic, zero-cost, no provider
 * calls. Replays each task's own outcome contract (the oracle writes) through
 * the SAME scoreState the generated environment uses, so the whole queue →
 * events → rows → leaderboard/replay loop is provable end to end without
 * spend. Rows are labeled honestly via subscores.runner_oracle = 1.
 */
export function oracleRunner(): ArmRunner {
  const journal = appendJournalEntry;
  return async ({ task, journalPath }) => {
    const started = Date.now();
    const writes = (asObject(task.outcome_contract).required ?? []).filter((rule: Obj) => String(rule.type ?? "state_effect") === "state_effect").map((rule: Obj) => ({ tool: String(rule.tool), arguments: rule.observed_arguments ?? {} }));
    for (const write of writes) {
      journal(journalPath, { at: Date.now() / 1000, kind: "call", tool: write.tool, write: true, status: "ok", arguments: JSON.stringify(write.arguments).slice(0, 800) });
      journal(journalPath, { at: Date.now() / 1000, kind: "result", tool: write.tool, status: "ok", content: "{\"ok\": true}" });
    }
    const scored = asObject(scoreState(asObject(task), writes));
    return {
      score: Number(scored.strict ?? 0),
      subscores: {
        final_state: Number(scored.strict ?? 0),
        final_state_partial_credit: Number(scored.recall ?? 0),
        recall: Number(scored.recall ?? 0),
        precision: Number(scored.precision ?? 0),
        policy: Number(scored.policy ?? 0),
        runner_oracle: 1,
      },
      status: "ok" as const,
      latency_ms: Math.max(1, Date.now() - started),
      cost: 0,
      writes,
      tool_call_count: writes.length,
      final_response_chars: null,
    };
  };
}

/**
 * Newest traces.jsonl files under the run's outputs/ (the verifiers eval
 * writes outputs/ relative to its cwd — the benchmark dir) after `since`.
 */
function newOutputFiles(benchmarkDir: string, since: number): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path);
      else if (name === "traces.jsonl" && st.mtimeMs >= since) out.push(path);
    }
  };
  walk(join(benchmarkDir, "outputs"));
  return out.sort();
}

/** Error class for verifiers-subprocess failures (HarnessError et al.), surfaced by name. */
export class HarnessExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessExecutionError";
  }
}

/**
 * Project ONE verifiers v1 trace object onto a RolloutResult: rewards →
 * score/subscores, per-call usage → real latency + estimated cost, assistant
 * tool_calls → the mutating `writes` that feed the hub's accumulation replay.
 * (Shape pinned by the golden fixture in tests/run-executor.test.mjs from a
 * real `uv run eval` run against the pinned commit.)
 */
export function projectVerifiersTrace(trace: Obj, model: string): { taskId: string | null; result: RolloutResult } {
  const taskId = (asObject(asObject(trace.task).data).task_id as string | undefined) ?? null;
  const rewards = asObject(trace.rewards);
  const metrics = asObject(trace.metrics);
  const strict = typeof rewards.final_state === "number" ? rewards.final_state : (Object.values(rewards).find((v) => typeof v === "number") as number | undefined) ?? null;
  const errors = (Array.isArray(trace.errors) ? trace.errors : []).map(asObject);
  const failed = trace.ok === false || errors.length > 0;
  // Real latency + token usage from the model calls; cost is the shared rough
  // gateway heuristic over those tokens (recorded as an estimate).
  const calls = (Array.isArray(trace.calls) ? trace.calls : []).map(asObject);
  let latencyMs = 0, promptTokens = 0, completionTokens = 0;
  for (const call of calls) {
    const time = asObject(call.time), usage = asObject(call.usage);
    if (typeof time.start === "number" && typeof time.end === "number") latencyMs += Math.round((time.end - time.start) * 1000);
    promptTokens += Number(usage.prompt_tokens ?? 0);
    completionTokens += Number(usage.completion_tokens ?? 0);
  }
  const rate = COST_PER_MTOKEN[model] ?? COST_PER_MTOKEN.default;
  const cost = calls.length > 0 ? (promptTokens * rate.input + completionTokens * rate.output) / 1_000_000 : null;
  // Mutating tool calls from the trace's message nodes → per-arm replay input.
  // Total call count (reads AND writes) + final assistant text feed the
  // structural anomaly sentinels.
  const writes: { tool: string; arguments: unknown }[] = [];
  let toolCallCount = 0;
  let finalAssistantText: string | null = null;
  for (const node of (Array.isArray(trace.nodes) ? trace.nodes : []).map(asObject)) {
    const message = asObject(node.message);
    if (message.role === "assistant") {
      const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((b: unknown) => String(asObject(b).text ?? "")).join("") : "";
      finalAssistantText = text;
    }
    toolCallCount += (Array.isArray(message.tool_calls) ? message.tool_calls : []).length;
    for (const tc of (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(asObject)) {
      const fn = asObject(tc.function);
      // Tool names arrive mcp-server-prefixed ("world_toolset_<tool>"); the
      // contract knows the bare tool names.
      const name = String(tc.name ?? fn.name ?? "").replace(/^world_toolset_/, "");
      if (!name || !isMutatingTool(name)) continue;
      let args: unknown = tc.arguments ?? fn.arguments ?? {};
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* keep raw */ } }
      writes.push({ tool: name, arguments: args });
    }
  }
  return {
    taskId,
    result: {
      score: failed ? null : strict,
      subscores: failed ? null : { ...rewards, ...metrics } as Record<string, number>,
      status: failed ? "error" : strict === null ? "unscored" : "ok",
      latency_ms: latencyMs > 0 ? latencyMs : null,
      cost,
      writes,
      tool_call_count: toolCallCount,
      final_response_chars: finalAssistantText === null ? null : finalAssistantText.trim().length,
      error: failed ? String(errors[0]?.type ?? "RolloutError") + ": " + String(errors[0]?.message ?? "rollout not ok").slice(0, 500) : null,
    },
  };
}

/**
 * Real verifiers-arm execution: ONE `uv run … eval` per (model, arm) reusing
 * buildReplayInvocation (allowlisted env, explicit gateway creds, --no-push,
 * mcp-skew pin), then the run's traces.jsonl (written under the benchmark
 * dir's outputs/) is projected onto per-task results. Throws
 * HarnessExecutionError with the subprocess tail on failure.
 */
export function runVerifiersArm(benchmarkDir: string, model: string, maxExamples: number, parentEnv: NodeJS.ProcessEnv = process.env, taskIds: string[] | null = null, journalPath: string | null = null): Map<string, RolloutResult> {
  const dir = resolve(benchmarkDir);
  const environment = join(dir, "environment");
  // Scope the eval to exactly the requested tasks (a single-task run on a
  // large benchmark must never fan out to every env task): the taskset loads
  // rows from tasks.json, so temporarily filter it — the same temp-rewrite
  // pattern runTraceReplays uses for context variants — and restore after.
  const taskRowsPath = join(environment, "understudy_trace_env", "tasks.json");
  const sourceTaskRows = taskIds !== null && existsSync(taskRowsPath) ? (JSON.parse(readFileSync(taskRowsPath, "utf8")) as Obj[]) : null;
  const wanted = taskIds === null ? null : new Set(taskIds);
  const filteredRows = sourceTaskRows?.filter((row) => wanted!.has(String(row.task_id))) ?? null;
  const splits = filteredRows === null ? ["train", "dev", "holdout"] : [...new Set(filteredRows.map((row) => String(row.split)))];
  if (filteredRows !== null) writeFileSync(taskRowsPath, `${JSON.stringify(filteredRows, null, 2)}\n`, { mode: 0o600 });
  try {
    return runVerifiersSplits(dir, environment, model, maxExamples, parentEnv, splits, journalPath);
  } finally {
    if (sourceTaskRows !== null) writeFileSync(taskRowsPath, `${JSON.stringify(sourceTaskRows, null, 2)}\n`, { mode: 0o600 });
  }
}

function runVerifiersSplits(dir: string, environment: string, model: string, maxExamples: number, parentEnv: NodeJS.ProcessEnv, splits: string[], journalPath: string | null = null): Map<string, RolloutResult> {
  // Gateway creds resolve the CLI's canonical way (env first, then
  // ~/.understudy/credentials.json) and are handed to buildReplayInvocation
  // through its own env contract — the executor ONLY talks to the Understudy
  // gateway, never a stray OPENAI_* pointing elsewhere.
  const auth = resolveGatewayAuth(parentEnv);
  const runnerEnv: NodeJS.ProcessEnv = { ...parentEnv, UNDERSTUDY_GATEWAY_URL: auth.baseUrl, UNDERSTUDY_API_KEY: auth.apiKey, OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined };
  // The generated taskset loads ONE split per eval (config default train), so
  // an arm covers all tasks by running each split; a split with no tasks
  // fails its own eval harmlessly (the merged map decides success below).
  const results = new Map<string, RolloutResult>();
  const failures: string[] = [];
  for (const split of splits) {
    const invocation = buildReplayInvocation(environment, model, "authentic_history", maxExamples, false, runnerEnv);
    // Live watching: the generated world server journals every tool call and
    // result to this file the moment it happens (no-op when unset). The var
    // rides the eval subprocess env, which the subprocess runtime inherits.
    if (journalPath !== null) invocation.env.UNDERSTUDY_LIVE_JOURNAL = journalPath;
    invocation.args.push("--env.taskset.split", split);
    const started = Date.now();
    const child = spawnSync("uv", invocation.args, { cwd: dir, encoding: "utf8", env: invocation.env, maxBuffer: 64 * 1024 * 1024 });
    if (child.error) throw new HarnessExecutionError(`could not start uv/verifiers: ${child.error.message}`);
    if (child.status !== 0) {
      failures.push(`split ${split}: exited ${child.status}: ${`${child.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n")}`);
      continue;
    }
    for (const file of newOutputFiles(dir, started - 1000)) {
      for (const line of readJsonl(file)) {
        for (const trace of (Array.isArray(line.traces) ? line.traces : []).map(asObject)) {
          const { taskId, result } = projectVerifiersTrace(trace, model);
          if (taskId && !results.has(taskId)) results.set(taskId, result);
        }
      }
    }
  }
  if (results.size === 0) {
    throw new HarnessExecutionError(failures.length > 0 ? `verifiers eval failed for every split:\n${failures.join("\n")}` : "verifiers eval produced no parsable traces under outputs/");
  }
  return results;
}

/**
 * Verifiers-backed ArmRunner: runs each (model) arm's tasks through the real
 * environment lazily — one eval subprocess per (arm, split), memoized, then
 * per-task rows from the projection. rollouts_per_task > 1 reuses the arm's
 * memoized result (the pinned eval CLI has no per-task rerun switch yet).
 * Unresolved tasks surface as errors, never silently ok.
 */
export function verifiersRunner(parentEnv: NodeJS.ProcessEnv = process.env): ArmRunner {
  const armCache = new Map<string, Map<string, RolloutResult> | Error>();
  return async ({ benchmarkDir, model, task, selectedTaskIds, journalPath }) => {
    const key = `${benchmarkDir}::${model}::${[...selectedTaskIds].sort().join(",")}`;
    if (!armCache.has(key)) {
      try {
        armCache.set(key, runVerifiersArm(benchmarkDir, model, VERIFIERS_MAX_EXAMPLES, parentEnv, selectedTaskIds, journalPath));
      } catch (err) {
        armCache.set(key, err instanceof Error ? err : new Error(String(err)));
      }
    }
    const cached = armCache.get(key)!;
    if (cached instanceof Error) throw cached;
    const result = cached.get(String(task.task_id));
    if (!result) {
      return { score: null, subscores: null, status: "error", latency_ms: null, cost: null, writes: [], error: `no verifiers result for task ${String(task.task_id)}` };
    }
    return result;
  };
}
