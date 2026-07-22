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
import { hostname } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildReplayInvocation, goldFinalResponseFor, isMutatingTool, oracleEventsFor, readCapturesByKey, responseJudgedRequired, scoreContract } from "./trace-foundry.js";
import { COST_PER_MTOKEN, resolveGatewayAuth } from "./trace-author.js";
import { BENCHMARK_PROPOSAL_SCHEMA, BENCHMARK_SCHEMA, CALIBRATION_SCHEMA, EVAL_RESULT_SCHEMA, RUN_EVENT_SCHEMA, appendJournalEntry, readJsonlFile, serializeJsonlLine, serializeRunEvent } from "./benchmark-artifacts.js";
import { resolveLocalArm, type LocalServerHandle, type LocalServingRig, type ResolvedLocalArm } from "./local-serving.js";

type Obj = Record<string, any>;
const asObject = (value: unknown): Obj => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const RUN_REQUEST_SCHEMA = "understudy.run_request.v1";

/**
 * The executor's own package version, stamped into every run event and eval
 * row so a degraded run (e.g. a stale watcher built before a feature landed)
 * is attributable post-hoc. Best-effort: "unknown" when package.json is
 * unreadable (never fails the run).
 */
export const EXECUTOR_VERSION: string = (() => {
  try {
    return String(asObject(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).version ?? "unknown");
  } catch {
    return "unknown";
  }
})();

/**
 * Capabilities THIS executor understands. A run request may carry an additive
 * `requires` list (populated by writers when they use a feature whose silent
 * omission would corrupt results); an executor that does not recognize a
 * required capability must SKIP the request with a recorded `run_unsupported`
 * event — never execute it with the unknown fields silently dropped.
 * Old executors predate `requires` entirely, hence the belt-and-braces
 * EXECUTOR_VERSION stamps above.
 */
export const EXECUTOR_CAPABILITIES = ["trivial_arms", "calibration", "rollout_timeout", "prompt_overrides", "app_replay", "local_arms", "majority_class"] as const;

/** The `requires` entries of a request this executor cannot honor (empty = safe to run). */
export function unsupportedRequirements(request: Pick<RunRequest, "requires">, capabilities: readonly string[] = EXECUTOR_CAPABILITIES): string[] {
  return (request.requires ?? []).filter((capability) => !capabilities.includes(capability));
}
export const RUN_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RUN_SPLITS = ["train", "dev", "holdout", "all"] as const;
export type RunSplit = (typeof RUN_SPLITS)[number];

/**
 * Row arm labels: "incumbent" = the model that produced the source captures,
 * rerun; "candidate" = any other model arm; "null_agent"/"spam_agent" are the
 * deterministic trivial calibration arms (extended additively — old readers
 * only ever see incumbent/candidate on old rows).
 */
export const ARM_KINDS = ["incumbent", "candidate", "null_agent", "spam_agent", "app_replay", "majority_class"] as const;
export type ArmKind = (typeof ARM_KINDS)[number];
/**
 * The trivial calibration arms (agentic-benchmarks floor discipline: a
 * do-nothing agent must score ~0). "majority_class" is the imbalanced-
 * classifier floor: on classification-shaped tasks it deterministically
 * answers the most frequent TRAIN-split gold label (capability-gated via
 * requires: ["majority_class"] so old executors skip, never mislabel).
 */
export const TRIVIAL_ARM_KINDS = ["null_agent", "spam_agent", "majority_class"] as const;
export type TrivialArmKind = (typeof TRIVIAL_ARM_KINDS)[number];

/**
 * A run-request model arm (additive union): the historical bare gateway model
 * id string, OR a LOCAL trained-artifact arm — a path to a
 * `.understudy-model` bundle or an MLX model dir (base + optional LoRA
 * adapter), served by the executor through the MLX serving rig for the
 * duration of the arm. Object entries require the "local_arms" capability;
 * requests without them keep the exact prior shape.
 */
export type LocalModelArm = {
  /** Local path to a .understudy-model bundle or an MLX model directory. */
  ref: string;
  /** Leaderboard/rows arm label (default: the ref's basename). */
  label?: string;
  /** Serving hints: {base_url} reuses a running server; {port, model_id, command} tune the spawn. */
  serving?: Record<string, unknown>;
};
export type ModelArmEntry = string | LocalModelArm;

export const isLocalArmEntry = (entry: ModelArmEntry): entry is LocalModelArm => typeof entry !== "string";

/** The row/rows-file/leaderboard label of one model arm entry. */
export function armLabelOf(entry: ModelArmEntry): string {
  if (typeof entry === "string") return entry;
  const label = entry.label?.trim();
  if (label) return label;
  const ref = String(entry.ref ?? "").replace(/\/+$/, "");
  return ref.split("/").filter(Boolean).pop() ?? ref;
}
/**
 * A prompt-override experiment arm: the SAME model as `model`, with
 * `system_prompt_suffix` appended to the task's system/operating prompt at
 * rollout time (run-scoped only — task files are never mutated). Rows are
 * labeled with the additive `arm_label` so the override arm is a distinct
 * leaderboard arm from the bare model arm; the suffix's sha256 rides each row
 * for provenance while the full text lives in the run's overrides sidecar
 * (runs/<run_id>-overrides.json). Override arms are always arm_kind
 * "candidate" — only the bare incumbent arm feeds calibration.
 */
export type PromptOverride = {
  arm_label: string;
  model: string;
  system_prompt_suffix: string;
};

/** Provenance hash of an override suffix (sha256 of the raw text — rows carry this, never the text). */
export const promptSuffixHash = (suffix: string): string => createHash("sha256").update(suffix).digest("hex");

/** The overrides sidecar carrying the FULL override text (rows carry only the hash). */
export function runOverridesPath(benchmarkDir: string, runId: string): string {
  return join(runsDir(benchmarkDir), `${sanitizeForFile(runId)}-overrides.json`);
}

/** Default incumbent-pass threshold on the strict contract score. */
export const DEFAULT_CALIBRATION_THRESHOLD = 1;
/** A trivial arm passing more than this fraction of tasks flags the benchmark floor_exceeded. */
export const TRIVIAL_FLOOR_LIMIT = 0.05;

export type RunRequest = {
  schema_version: typeof RUN_REQUEST_SCHEMA;
  run_id: string;
  benchmark_id: string;
  /** Arm entries: gateway model id strings (unchanged) and/or additive local-artifact objects. */
  models: ModelArmEntry[];
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
  /**
   * Additive (absent when unused — old readers see the exact prior shape):
   * trivial calibration arms to run alongside the model arms. Deterministic,
   * zero-cost, one rollout per task; rows are labeled with the arm kind.
   */
  trivial_arms?: TrivialArmKind[];
  /**
   * Additive: capabilities an executor MUST understand to run this request
   * (populated by writers whenever they use a feature — e.g. "trivial_arms",
   * "calibration", "rollout_timeout" — whose silent omission by an old
   * executor would corrupt results). Executors skip-with-record on any entry
   * they do not recognize.
   */
  requires?: string[];
  /** Additive: per-rollout wall-clock budget in seconds (default DEFAULT_ROLLOUT_TIMEOUT_SECONDS). */
  rollout_timeout_seconds?: number;
  /**
   * Additive (absent when unused): prompt-override experiment arms. Each runs
   * the named model with the suffix appended to the task's system prompt at
   * rollout time; rows are labeled with the arm_label. Requires the
   * "prompt_overrides" capability (old executors skip, never run bare).
   */
  prompt_overrides?: PromptOverride[];
  /**
   * Additive (absent when unused): run the user's OWN app per the benchmark's
   * app-harness.json sidecar (understudy.app_harness.v1) instead of a model
   * arm. Rows are labeled arm_kind "app_replay" and NEVER feed calibration —
   * an app replay is a regression check on current code, not an incumbent
   * claim. Capability-gated via requires: ["app_replay"].
   */
  app_replay?: boolean;
  /**
   * Additive (absent when unused): the understudy.experiment.v1 experiment_id
   * this run evaluates. Pure passthrough provenance — rows/events join back
   * to the experiment via run_id → this request; executors need no capability.
   */
  experiment_id?: string;
  /** Additive: the executor that atomically claimed this request (stale-watcher hijack guard). */
  claimed_by?: RunClaim | null;
  /** Additive: recorded when an executor skipped this request because it lacks a required capability. */
  unsupported?: { executor_version: string; missing: string[]; at: string } | null;
};

/* ------------------------------------------------------------------ */
/* Request claiming (stale-watcher hijack guard)                       */
/* ------------------------------------------------------------------ */

export type RunClaim = {
  pid: number;
  /** Random tie-break token: the claim survives only if OUR nonce is what re-reads from disk. */
  nonce: string;
  executor_version: string;
  host: string;
  claimed_at: string;
};

/** True when a pid is (probably) alive on this host. EPERM = alive but not ours. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type ClaimOutcome = { ok: true; request: RunRequest; claim: RunClaim } | { ok: false; reason: "missing" | "not_queued" | "claimed"; request: RunRequest | null };

/**
 * Atomically claim a queued request before executing it: write our claim
 * (pid + executor version + nonce + timestamp) onto the request file, then
 * RE-READ to verify our nonce is what actually landed — two racing executors
 * both write, but only the one whose write survived proceeds. A claim held by
 * a live pid is respected (skip); a claim whose pid is dead is taken over
 * (the claiming executor crashed / was killed).
 */
export function claimRunRequest(benchmarkDir: string, runId: string, options?: { pid?: number; executorVersion?: string; now?: () => Date }): ClaimOutcome {
  const file = runRequestPath(benchmarkDir, runId);
  const request = existsSync(file) ? readRunRequest(file) : null;
  if (!request) return { ok: false, reason: "missing", request: null };
  if (request.status !== "queued") return { ok: false, reason: "not_queued", request };
  const pid = options?.pid ?? process.pid;
  const existing = request.claimed_by ?? null;
  // Respect a live foreign claim; take over a dead one (staleness takeover).
  if (existing && existing.pid !== pid && pidAlive(existing.pid)) return { ok: false, reason: "claimed", request };
  const claim: RunClaim = {
    pid,
    nonce: createHash("sha256").update(`${pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16),
    executor_version: options?.executorVersion ?? EXECUTOR_VERSION,
    host: hostname(),
    claimed_at: (options?.now?.() ?? new Date()).toISOString(),
  };
  writeRunRequest(benchmarkDir, { ...request, claimed_by: claim });
  // Verify the claim actually landed (atomic-rename write means the LAST
  // racing writer wins; only that executor may proceed).
  const reread = readRunRequest(file);
  if (!reread || reread.claimed_by?.nonce !== claim.nonce) return { ok: false, reason: "claimed", request: reread ?? request };
  return { ok: true, request: reread, claim };
}

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
  /** Optional (additive): trivial calibration arms ("null_agent" / "spam_agent"). */
  trivial_arms?: unknown;
  /** Optional (additive): per-rollout wall-clock budget in seconds. */
  rollout_timeout_seconds?: unknown;
  /** Optional (additive): prompt-override experiment arms ({arm_label, model, system_prompt_suffix}). */
  prompt_overrides?: unknown;
  /** Optional (additive): replay the user's own app per app-harness.json (arm_kind "app_replay"). */
  app_replay?: unknown;
  /** Optional (additive): understudy.experiment.v1 experiment_id this run evaluates (provenance passthrough). */
  experiment_id?: unknown;
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
  // Arm labels of the valid entries (string ids as-is; local arms via
  // armLabelOf) — every downstream membership/uniqueness check keys on these.
  let armLabels: string[] | null = null;
  if (!Array.isArray(models) || models.length === 0) {
    errors.push("models must be a non-empty array of model id strings or {ref, label?, serving?} local arms");
  } else {
    const labels: string[] = [];
    for (const entry of models) {
      if (typeof entry === "string") {
        if (entry.trim().length === 0) errors.push("models: model id strings must be non-empty");
        else labels.push(entry);
      } else if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        const o = asObject(entry);
        if (typeof o.ref !== "string" || o.ref.trim().length === 0) {
          errors.push("models: local arm entries need a non-empty ref (path to a .understudy-model bundle or an MLX model dir)");
        }
        if (o.label !== undefined && (typeof o.label !== "string" || o.label.trim().length === 0)) errors.push("models: local arm label must be a non-empty string when present");
        if (o.serving !== undefined && (o.serving === null || typeof o.serving !== "object" || Array.isArray(o.serving))) errors.push("models: local arm serving must be an object when present");
        if (typeof o.ref === "string" && o.ref.trim().length > 0) labels.push(armLabelOf(o as LocalModelArm));
      } else {
        errors.push("models entries must be model id strings or {ref, label?, serving?} objects");
      }
    }
    if (models.length > MAX_MODELS_PER_RUN) errors.push(`at most ${MAX_MODELS_PER_RUN} models per run`);
    if (new Set(labels).size !== labels.length) errors.push("model arm labels must be unique");
    armLabels = labels;
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
    } else if (armLabels !== null && !incumbents.every((m) => armLabels!.includes(m))) {
      errors.push("incumbent_models must be a subset of models");
    }
  }
  const threshold = input.calibration_threshold;
  if (threshold !== undefined && (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1)) {
    errors.push("calibration_threshold must be a number in (0, 1]");
  }
  const trivial = input.trivial_arms;
  if (trivial !== undefined) {
    if (!Array.isArray(trivial) || !trivial.every((kind) => TRIVIAL_ARM_KINDS.includes(kind as TrivialArmKind))) {
      errors.push(`trivial_arms must be an array of ${TRIVIAL_ARM_KINDS.join(" / ")}`);
    } else if (new Set(trivial).size !== trivial.length) {
      errors.push("trivial_arms must be unique");
    }
  }
  const timeout = input.rollout_timeout_seconds;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) {
    errors.push("rollout_timeout_seconds must be a positive number of seconds");
  }
  const experimentId = input.experiment_id;
  if (experimentId !== undefined && (typeof experimentId !== "string" || !/^[A-Za-z0-9_.-]+$/.test(experimentId))) {
    errors.push("experiment_id must be a non-empty string of [A-Za-z0-9_.-]");
  }
  const appReplay = input.app_replay;
  if (appReplay !== undefined && typeof appReplay !== "boolean") {
    errors.push("app_replay must be a boolean");
  }
  if (appReplay === true && Array.isArray(incumbents) && incumbents.length > 0) {
    errors.push("app_replay runs cannot carry incumbent_models — an app replay is not an incumbent claim and never feeds calibration");
  }
  const overrides = input.prompt_overrides;
  if (overrides !== undefined) {
    if (!Array.isArray(overrides) || overrides.length === 0) {
      errors.push("prompt_overrides must be a non-empty array of {arm_label, model, system_prompt_suffix}");
    } else {
      const labels = new Set<string>();
      for (const entry of overrides) {
        const o = asObject(entry);
        const label = typeof o.arm_label === "string" ? o.arm_label.trim() : "";
        if (!label) errors.push("prompt_overrides: arm_label must be a non-empty string");
        else if (labels.has(label)) errors.push(`prompt_overrides: duplicate arm_label ${label}`);
        else labels.add(label);
        // The label is a leaderboard arm AND a rows-file key: it must never
        // collide with a bare model arm (that would merge two arms' rows).
        if (label && armLabels !== null && armLabels.includes(label)) errors.push(`prompt_overrides: arm_label ${label} collides with a model arm`);
        if (typeof o.model !== "string" || !o.model.trim()) errors.push("prompt_overrides: model must be a non-empty string");
        else if (armLabels !== null && !armLabels.includes(o.model)) errors.push(`prompt_overrides: model ${o.model} must be one of the run's models`);
        if (typeof o.system_prompt_suffix !== "string" || !o.system_prompt_suffix.trim()) errors.push("prompt_overrides: system_prompt_suffix must be a non-empty string");
      }
    }
  }
  return errors;
}

/** Create + persist a queued run request. Caller validates first. */
export function createRunRequest(
  benchmarkDir: string,
  input: { benchmark_id: string; models: ModelArmEntry[]; split: RunSplit; tasks: "all" | string[]; rollouts_per_task: number; incumbent_models?: string[]; calibration_threshold?: number; trivial_arms?: TrivialArmKind[]; rollout_timeout_seconds?: number; prompt_overrides?: PromptOverride[]; app_replay?: boolean; experiment_id?: string },
  now: Date = new Date(),
): RunRequest {
  // Writers declare the capabilities their feature use depends on, so an old
  // executor (which cannot honor them) skips the request instead of silently
  // dropping the fields (the stale-watcher hijack class).
  const requires: string[] = [];
  if (input.trivial_arms && input.trivial_arms.length > 0) requires.push("trivial_arms");
  // Old executors know "trivial_arms" but not the majority_class kind; a
  // distinct capability keeps them from running the arm as an unknown no-op.
  if ((input.trivial_arms ?? []).includes("majority_class")) requires.push("majority_class");
  if (input.models.some(isLocalArmEntry)) requires.push("local_arms");
  if ((input.incumbent_models && input.incumbent_models.length > 0) || input.calibration_threshold !== undefined) requires.push("calibration");
  if (input.rollout_timeout_seconds !== undefined) requires.push("rollout_timeout");
  if (input.prompt_overrides && input.prompt_overrides.length > 0) requires.push("prompt_overrides");
  if (input.app_replay === true) requires.push("app_replay");
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
    ...(input.trivial_arms && input.trivial_arms.length > 0 ? { trivial_arms: input.trivial_arms } : {}),
    ...(input.rollout_timeout_seconds !== undefined ? { rollout_timeout_seconds: input.rollout_timeout_seconds } : {}),
    ...(input.prompt_overrides && input.prompt_overrides.length > 0 ? { prompt_overrides: input.prompt_overrides } : {}),
    ...(input.app_replay === true ? { app_replay: true } : {}),
    // Additive provenance passthrough — no capability entry needed: an old
    // executor ignoring it changes nothing (rows join via run_id anyway).
    ...(input.experiment_id !== undefined ? { experiment_id: input.experiment_id } : {}),
    ...(requires.length > 0 ? { requires } : {}),
  };
  writeRunRequest(benchmarkDir, request);
  // Provenance sidecar: rows carry only the suffix hash; the FULL override
  // text is written once per run next to the queue (never onto task files).
  if (request.prompt_overrides && request.prompt_overrides.length > 0) {
    const sidecar = {
      run_id: request.run_id,
      benchmark_id: request.benchmark_id,
      created_at: request.created_at,
      overrides: request.prompt_overrides.map((o) => ({ ...o, system_prompt_suffix_sha256: promptSuffixHash(o.system_prompt_suffix) })),
    };
    mkdirSync(runsDir(benchmarkDir), { recursive: true });
    writeFileSync(runOverridesPath(benchmarkDir, request.run_id), `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o600 });
  }
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
  /**
   * Additive oracle diagnostic (oracle runner only): obligation groups whose
   * gold evidence is missing from the artifacts (e.g. ["response"] when the
   * captured incumbent final response is not recoverable). Distinguishes
   * "unverifiable" from "broken" — absent on every other runner's results.
   */
  oracle?: { missing_gold: string[] } | null;
  /** Additive: true when the rollout was killed by the per-rollout timeout (row gets the rollout_timeout anomaly). */
  timed_out?: boolean;
  /**
   * Additive: a structural anomaly the RUNNER itself detected (e.g. the
   * app-replay arm's "app_replay_unobserved" when the launched app's tool
   * calls could not be observed). Marked on the row exactly like
   * executor-detected sentinels — honest partial evidence, never a fake score.
   */
  anomaly?: RolloutAnomaly | null;
  /**
   * Additive perf evidence (local arms; where obtainable): generation
   * throughput derived from the runner's own usage/timing data. Never
   * estimated when the runner cannot tell.
   */
  perf?: { tokens_per_sec?: number | null } | null;
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
  | "zero_score_zero_calls"
  | "rollout_timeout"
  | "app_replay_unobserved";

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

  // Contract awareness for the tool-shaped sentinels (d)/(e): a response-only
  // contract (response obligations / final-response value propagations only —
  // e.g. classification workloads) legitimately produces zero tool calls and
  // zero journal events, so those sentinels only apply when the contract
  // actually obliges tool activity (state effects, read obligations, or
  // tool-directed value propagations).
  const toolObligations = required.filter((rule) => {
    const type = String(rule.type ?? "state_effect");
    if (type === "state_effect" || type === "read_obligation") return true;
    return type === "value_propagation" && asObject(rule.must_reach).kind !== "final_response";
  }).length;

  // (d) journal/row write anomaly: a completed rollout left zero live-journal
  // events on a task whose contract requires tool activity.
  if (args.journalBytes === 0 && toolObligations > 0) {
    anomalies.push({ kind: "no_journal_events", detail: `rollout completed but the live journal recorded zero events (contract has ${toolObligations} tool obligation(s))` });
  }

  // (e) all-zero contract score with zero tool calls on a tool-obliging
  // contract — indistinguishable from a harness failure, so it must never be
  // trusted as an honest 0. A response-only contract scoring 0 with zero
  // calls is an honest miss (the final response is the evidence), not a
  // harness anomaly.
  if (result.score === 0 && calls === 0 && toolObligations > 0) {
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
  /** Additive: the executing run's id — runners use it to isolate per-invocation outputs structurally. */
  runId?: string;
  /** Additive: per-rollout wall-clock budget in seconds (runners spawning subprocesses enforce it on the child). */
  rolloutTimeoutSeconds?: number;
  /** Additive (prompt-override arms only): the arm's leaderboard label — runners key caches/work dirs on it so an override arm never shares state with the bare model arm. */
  armLabel?: string;
  /** Additive (prompt-override arms only): suffix appended to each task's system prompt at rollout time, run-scoped (task files are never mutated). */
  systemPromptSuffix?: string;
  /** Additive (local arms only): the served artifact's endpoint — runners point their client at it instead of the gateway. */
  local?: { baseUrl: string; modelId: string };
}) => Promise<RolloutResult>;

export type RunEvent = {
  schema_version: typeof RUN_EVENT_SCHEMA;
  ts: string;
  run_id: string;
  type: "run_started" | "arm_started" | "rollout" | "rollout_error" | "arm_finished" | "run_finished" | "run_cancelled" | "run_failed" | "cap_warning" | "run_unsupported";
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
  /** Additive: the executor package version that emitted this event (degraded-run attribution). */
  executor_version?: string;
};

function appendEvent(benchmarkDir: string, event: RunEvent, onEvent?: (event: RunEvent) => void): void {
  const stamped: RunEvent = { ...event, executor_version: event.executor_version ?? EXECUTOR_VERSION };
  mkdirSync(runsDir(benchmarkDir), { recursive: true });
  appendFileSync(runEventsPath(benchmarkDir), serializeRunEvent(stamped), { mode: 0o600 });
  onEvent?.(stamped);
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
  /**
   * Additive: the runner for app_replay requests (launches the user's own app
   * per app-harness.json; see src/app-harness.ts). When absent, this executor
   * simply does not advertise the "app_replay" capability, so such requests
   * are skipped-with-record — never executed as a model arm by mistake.
   */
  appReplayRunner?: ArmRunner;
  /**
   * Additive: the serving rig for LOCAL trained-artifact arms ({ref, …}
   * model entries). The executor starts the server for the arm (or reuses a
   * running one when the arm's serving.base_url points at it), hands the
   * runner the endpoint, and tears the server down after the arm. When
   * absent, this executor does not advertise the "local_arms" capability, so
   * such requests are skipped-with-record — never run against the gateway
   * with the ref silently dropped.
   */
  localServing?: LocalServingRig;
  /** Rollouts in flight per arm (the concurrency flag). */
  concurrency?: number;
  /** Per-rollout wall-clock budget in seconds; the request's rollout_timeout_seconds wins when present. */
  rolloutTimeoutSeconds?: number;
  now?: () => Date;
  onEvent?: (event: RunEvent) => void;
  /** Test seam: this executor's pid for claiming (default process.pid). */
  pid?: number;
  /** Test seam: this executor's capability set (default EXECUTOR_CAPABILITIES). */
  capabilities?: readonly string[];
};

/** Generous default per-rollout budget: a rollout past this is a hang, not a slow model. */
export const DEFAULT_ROLLOUT_TIMEOUT_SECONDS = 600;

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

  // Capability gate: a request requiring features this executor does not
  // recognize is SKIPPED with a recorded run_unsupported note — never executed
  // with the unknown fields silently dropped (the stale-watcher hijack class).
  // Status stays "queued" so a capable executor can still pick it up.
  const baseCapabilities = options.capabilities ?? EXECUTOR_CAPABILITIES;
  // "app_replay"/"local_arms" are only honestly supported when their runner/rig was wired in.
  const capabilities = baseCapabilities
    .filter((c) => c !== "app_replay" || options.appReplayRunner !== undefined)
    .filter((c) => c !== "local_arms" || options.localServing !== undefined);
  const missing = unsupportedRequirements(initial, capabilities);
  if (missing.length > 0) {
    const note = { executor_version: EXECUTOR_VERSION, missing, at: now().toISOString() };
    // Record once per executor version (a watch daemon polls forever).
    const prior = initial.unsupported;
    if (!prior || prior.executor_version !== note.executor_version || prior.missing.join(",") !== missing.join(",")) {
      writeRunRequest(dir, { ...initial, unsupported: note });
      appendEvent(dir, { schema_version: RUN_EVENT_SCHEMA, ts: note.at, run_id: runId, type: "run_unsupported", status: "unsupported", error: `executor ${EXECUTOR_VERSION} does not support required capabilities: ${missing.join(", ")}` }, options.onEvent);
    }
    return readRunRequest(file) ?? initial;
  }

  // Atomic claim before any execution: a request claimed by another LIVE
  // executor is skipped (returned still-queued); a dead claimant is taken over.
  const claimed = claimRunRequest(dir, runId, { pid: options.pid, now });
  if (!claimed.ok) return claimed.request ?? initial;
  let request: RunRequest = claimed.request;

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

  // Arms = the requested model arms plus any trivial calibration arms. Trivial
  // arms are deterministic, so they run exactly ONE rollout per task no matter
  // what rollouts_per_task says (repeats add nothing but identical rows).
  type Arm = { model: string; kind: ArmKind; runner: ArmRunner; rollouts: number; override?: PromptOverride; local?: ResolvedLocalArm };
  // app_replay requests replay the user's OWN app (labels stay per "model"
  // entry — typically the app/route name); the capability gate above already
  // guaranteed options.appReplayRunner is present when app_replay is true.
  const appReplay = request.app_replay === true && options.appReplayRunner !== undefined;
  const arms: Arm[] = request.models.map((entry) => {
    const model = armLabelOf(entry);
    // Local trained-artifact arm: resolve the ref NOW (provenance hash + base
    // model + adapter flag) so a missing/renamed bundle fails the run up
    // front, never mid-arm. The capability gate above guaranteed
    // options.localServing is present when any local entry exists.
    const local = isLocalArmEntry(entry) ? resolveLocalArm(entry) : undefined;
    return {
      model,
      kind: appReplay ? ("app_replay" as ArmKind) : (((request.incumbent_models ?? []).includes(model) ? "incumbent" : "candidate") as ArmKind),
      runner: appReplay ? options.appReplayRunner! : options.runner,
      rollouts: request.rollouts_per_task,
      ...(local ? { local } : {}),
    };
  });
  // Prompt-override experiment arms: same underlying model, a run-scoped
  // system-prompt suffix, rows labeled with the arm_label. ALWAYS candidates —
  // an override arm is not the incumbent baseline, so it never feeds
  // calibration even when its base model is the incumbent.
  for (const override of request.prompt_overrides ?? []) {
    arms.push({ model: override.arm_label, kind: "candidate", runner: options.runner, rollouts: request.rollouts_per_task, override });
  }
  for (const kind of request.trivial_arms ?? []) {
    if (!TRIVIAL_ARM_KINDS.includes(kind)) continue;
    arms.push({ model: kind, kind, runner: kind === "null_agent" ? nullAgentRunner() : kind === "spam_agent" ? spamAgentRunner() : majorityClassRunner(), rollouts: 1 });
  }
  const total = arms.reduce((sum, arm) => sum + selected.length * arm.rollouts, 0);
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
    for (const arm of arms) {
      const model = arm.model;
      if (cancelled()) break;
      appendEvent(dir, { schema_version: RUN_EVENT_SCHEMA, ts: now().toISOString(), run_id: runId, type: "arm_started", model }, options.onEvent);
      // Local arm: stand the artifact's server up for the WHOLE arm (or reuse
      // a running one the spec points at) and tear it down after — the runner
      // gets the endpoint instead of the gateway.
      let localServer: LocalServerHandle | null = null;
      if (arm.local) localServer = await options.localServing!.start(arm.local);
      try {
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
      for (const task of selected) for (let rollout = 0; rollout < arm.rollouts; rollout += 1) queue.push({ task, rollout });
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
          // Per-rollout wall-clock budget: the request's additive
          // rollout_timeout_seconds wins, then the executor flag, then the
          // generous default. Subprocess-spawning runners also receive the
          // budget so they can kill the child (a blocked event loop cannot be
          // preempted from here); either path yields a rollout_timeout row.
          const timeoutSeconds = request.rollout_timeout_seconds ?? options.rolloutTimeoutSeconds ?? DEFAULT_ROLLOUT_TIMEOUT_SECONDS;
          let result: RolloutResult;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const TIMED_OUT = Symbol("rollout_timeout");
          try {
            // Override arms invoke the BASE model; the arm label only labels
            // rows/files. The suffix + label ride the additive runner args.
            const attempt = arm.runner({ benchmarkDir: dir, model: arm.override?.model ?? model, task: sidecar, rollout: item.rollout, selectedTaskIds: selected.map((t) => String(t.task_id)), journalPath, runId, rolloutTimeoutSeconds: timeoutSeconds, ...(arm.override ? { armLabel: arm.override.arm_label, systemPromptSuffix: arm.override.system_prompt_suffix } : {}), ...(localServer ? { local: { baseUrl: localServer.baseUrl, modelId: localServer.modelId } } : {}) });
            const raced = await Promise.race([attempt, new Promise<typeof TIMED_OUT>((res) => { timer = setTimeout(() => res(TIMED_OUT), Math.max(1, Math.round(timeoutSeconds * 1000))); })]);
            if (raced === TIMED_OUT) {
              attempt.catch(() => { /* late settle of the abandoned rollout is irrelevant */ });
              result = { score: null, subscores: null, status: "error", latency_ms: Math.round(timeoutSeconds * 1000), cost: null, writes: [], timed_out: true, error: `rollout_timeout: rollout exceeded ${timeoutSeconds}s` };
            } else {
              result = raced;
            }
          } catch (err) {
            result = { score: null, subscores: null, status: "error", latency_ms: null, cost: null, writes: [], error: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err) };
          } finally {
            clearTimeout(timer);
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
          // Structural sentinels are MODEL-arm-only: a trivial arm making zero
          // tool calls / an empty final response is behaving exactly as
          // designed, never a harness anomaly (its floor is the signal).
          const anomalies: RolloutAnomaly[] = (TRIVIAL_ARM_KINDS as readonly string[]).includes(arm.kind) ? [] : detectRolloutAnomalies({
            task: sidecar,
            result,
            promptSent: envRow === undefined ? undefined : String(envRow.prompt ?? ""),
            storedPrompt: envRow === undefined ? undefined : textOfContent(((Array.isArray(envRow.source_messages) ? envRow.source_messages : []).map(asObject).find((m) => m.role === "user") ?? {}).content),
            journalBytes,
          });
          // Timeout kills are structural anomalies on EVERY arm kind: the row
          // is marked (and excluded from aggregates like other anomalies),
          // never silently dropped, and the run continues.
          if (result.timed_out === true) {
            anomalies.unshift({ kind: "rollout_timeout", detail: result.error ?? `rollout exceeded ${timeoutSeconds}s` });
          }
          // Runner-detected structural anomalies (e.g. app_replay_unobserved)
          // are marked on the row exactly like executor-detected sentinels.
          if (result.anomaly) anomalies.unshift(result.anomaly);
          const row: Obj = {
            schema_version: EVAL_RESULT_SCHEMA,
            run_id: runId,
            task_id: taskId,
            split: item.task.split ?? "none",
            score: result.score,
            subscores: result.subscores,
            status: result.status,
            model,
            // Additive arm label: incumbent reruns and trivial calibration
            // arms are distinguishable from candidate arms everywhere
            // downstream (hub badges, calibration, floors).
            arm_kind: arm.kind,
            // Additive attribution stamp: which executor build produced this row.
            executor_version: EXECUTOR_VERSION,
            route: arm.local ? "local" : "gateway",
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
            // Additive override provenance: base model + suffix hash (full
            // text lives in runs/<run_id>-overrides.json, never on rows).
            ...(arm.override ? { prompt_override: { arm_label: arm.override.arm_label, base_model: arm.override.model, system_prompt_suffix_sha256: promptSuffixHash(arm.override.system_prompt_suffix) } } : {}),
            // Additive local-artifact provenance + perf (local arms only):
            // exactly which bundle was served, plus throughput/peak memory
            // where the runner/rig can actually tell (never estimated).
            ...(arm.local ? { local_artifact: arm.local.artifact } : {}),
            ...(typeof result.perf?.tokens_per_sec === "number" ? { tokens_per_sec: result.perf.tokens_per_sec } : {}),
            ...(localServer && typeof localServer.stats().peak_memory_bytes === "number" ? { peak_memory_bytes: localServer.stats().peak_memory_bytes } : {}),
            // Additive oracle diagnostic: missing-gold rows render "unverifiable", never a bare fail.
            ...(result.oracle && result.oracle.missing_gold.length > 0 ? { oracle: result.oracle } : {}),
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
      } finally {
        // Teardown after the arm — a server the rig REUSED is never ours to stop.
        if (localServer && !localServer.reused) await localServer.stop();
      }
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
  // Calibration gate: a finished run with an incumbent arm and/or trivial
  // arms updates the benchmark's calibration.json sidecar from its own
  // rows + run events.
  if ((request.incumbent_models ?? []).length > 0 || (request.trivial_arms ?? []).length > 0) writeCalibrationSummary(dir, request, selected.map((t) => String(t.task_id)));
  return request;
}

/* ------------------------------------------------------------------ */
/* Incumbent calibration gate                                          */
/* ------------------------------------------------------------------ */

export function calibrationPath(benchmarkDir: string): string {
  return join(resolve(benchmarkDir), "calibration.json");
}

export type CalibrationTask = { task_id: string; score: number | null; passed: boolean; rollouts: number; anomalous_rollouts: number };

/**
 * Per-benchmark trivial-arm floor: the fraction of selected tasks the arm
 * passes at the calibration threshold. A trivial agent passing tasks means
 * the contract is satisfiable by doing nothing (null) or by ritual tool
 * calling (spam) — floor > TRIVIAL_FLOOR_LIMIT flags the benchmark.
 */
export type TrivialFloor = {
  arm_kind: TrivialArmKind;
  /** passed / selected tasks, at the calibration threshold. Null when the arm produced no rows. */
  floor: number | null;
  /** The offending tasks: every selected task the trivial arm passes. */
  passed_task_ids: string[];
  floor_exceeded: boolean;
};

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
  /** Additive: null-agent floor (absent when the run carried no null_agent arm — old readers see the prior shape). */
  null_floor?: TrivialFloor;
  /** Additive: spam-agent floor (absent when the run carried no spam_agent arm). */
  spam_floor?: TrivialFloor;
  /** Additive: majority-class floor (absent when the run carried no majority_class arm) — the imbalanced-classifier trap. */
  majority_floor?: TrivialFloor;
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
  /** Trivial arms the run carried; each contributes its floor to the summary. */
  trivialArms?: TrivialArmKind[];
}): CalibrationSummary {
  const threshold = args.threshold ?? DEFAULT_CALIBRATION_THRESHOLD;
  const incumbents = new Set(args.incumbentModels);
  const runEvents = args.events.filter((e) => e.run_id === args.runId);
  const eventTs = (type: string): string | null => {
    const event = runEvents.find((e) => e.type === type);
    return typeof event?.ts === "string" ? event.ts : null;
  };
  const rows = args.rows.filter((row) => row.run_id === args.runId && incumbents.has(String(row.model ?? "")));
  // A trivial-only run makes NO incumbent claim: tasks stay empty rather than
  // reading "every task failed calibration" off arms that never ran.
  const tasks: CalibrationTask[] = incumbents.size === 0 ? [] : args.selectedTaskIds.map((taskId) => {
    const taskRows = rows.filter((row) => String(row.task_id) === taskId);
    const anomalous = taskRows.filter(isAnomalousEvalRow);
    const scores = taskRows.filter((row) => !isAnomalousEvalRow(row) && row.status === "ok" && typeof row.score === "number").map((row) => Number(row.score));
    const best = scores.length > 0 ? Math.max(...scores) : null;
    return { task_id: taskId, score: best, passed: best !== null && best >= threshold, rollouts: taskRows.length, anomalous_rollouts: anomalous.length };
  });
  const failed = tasks.filter((task) => !task.passed);
  // Trivial-arm floors: a task "passes" for a trivial arm when its best ok,
  // non-anomalous row for that arm_kind reaches the SAME threshold the
  // incumbent gate uses. floor = passed / selected.
  const runRows = args.rows.filter((row) => row.run_id === args.runId);
  const floorFor = (kind: TrivialArmKind): TrivialFloor => {
    const armRows = runRows.filter((row) => String(row.arm_kind ?? "") === kind);
    const passedIds = args.selectedTaskIds.filter((taskId) => {
      const scores = armRows
        .filter((row) => String(row.task_id) === taskId && !isAnomalousEvalRow(row) && row.status === "ok" && typeof row.score === "number")
        .map((row) => Number(row.score));
      return scores.length > 0 && Math.max(...scores) >= threshold;
    });
    const floor = armRows.length === 0 ? null : args.selectedTaskIds.length === 0 ? 0 : passedIds.length / args.selectedTaskIds.length;
    return { arm_kind: kind, floor, passed_task_ids: passedIds, floor_exceeded: floor !== null && floor > TRIVIAL_FLOOR_LIMIT };
  };
  const trivialArms = args.trivialArms ?? [];
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
    // Additive floors: absent unless the run carried the arm.
    ...(trivialArms.includes("null_agent") ? { null_floor: floorFor("null_agent") } : {}),
    ...(trivialArms.includes("spam_agent") ? { spam_floor: floorFor("spam_agent") } : {}),
    ...(trivialArms.includes("majority_class") ? { majority_floor: floorFor("majority_class") } : {}),
  };
}

/** Rebuild calibration.json from a finished incumbent run's rows + events. Best-effort: never fails the run. */
function writeCalibrationSummary(benchmarkDir: string, request: RunRequest, selectedTaskIds: string[]): void {
  try {
    // Rows/events re-read through the SHARED tolerant codec (never a private parser).
    const rows = [...(request.incumbent_models ?? []), ...(request.trivial_arms ?? [])].flatMap((model) => readJsonlFile<Obj>(rowsFilePath(benchmarkDir, request.run_id, model)).items);
    const summary = deriveCalibrationSummary({
      benchmarkId: request.benchmark_id,
      runId: request.run_id,
      incumbentModels: request.incumbent_models ?? [],
      threshold: request.calibration_threshold,
      selectedTaskIds,
      rows,
      events: readJsonlFile<Obj>(runEventsPath(benchmarkDir)).items,
      trivialArms: request.trivial_arms ?? [],
    });
    const file = calibrationPath(benchmarkDir);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // calibration is a derived sidecar — a write failure must not fail the run
  }
}

/** Execute every queued request once, oldest first. Requests skipped as claimed-by-a-live-executor or capability-unsupported stay queued and are not reported as results. */
export async function executeQueuedRuns(benchmarkDir: string, options: ExecuteOptions): Promise<RunRequest[]> {
  const results: RunRequest[] = [];
  for (const request of listRunRequests(benchmarkDir)) {
    if (request.status !== "queued") continue;
    const outcome = await executeRunRequest(benchmarkDir, request.run_id, options);
    if (outcome.status !== "queued") results.push(outcome);
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Runners                                                             */
/* ------------------------------------------------------------------ */

/**
 * Offline validation-oracle runner: deterministic, zero-cost, no provider
 * calls. Constructs each task's FULL oracle rollout — the contract's own tool
 * calls (state effects, read obligations, tool-args value propagations) PLUS
 * the stored GOLD final response (the captured incumbent's final assistant
 * text from normalized-captures.jsonl) — and scores it through the SAME
 * full-contract scorer real arms are judged by (scoreContract), so EVERY
 * obligation kind is oracle-verified offline, not just state effects.
 *
 * A well-formed task must score strict 1. When the gold final response is
 * missing from the artifacts, response/value obligations cannot be verified:
 * the row records the additive diagnostic `oracle.missing_gold: ["response"]`
 * so the hub can render "unverifiable" distinctly from "broken".
 * Rows are labeled honestly via subscores.runner_oracle = 1.
 */
export function oracleRunner(): ArmRunner {
  const journal = appendJournalEntry;
  const capturesCache = new Map<string, Map<string, Obj>>();
  return async ({ benchmarkDir, task, journalPath }) => {
    const started = Date.now();
    const sidecar = asObject(task);
    const calls = oracleEventsFor(sidecar).calls;
    for (const call of calls) {
      journal(journalPath, { at: Date.now() / 1000, kind: "call", tool: String(call.tool), write: isMutatingTool(String(call.tool)), status: "ok", arguments: JSON.stringify(call.arguments ?? {}).slice(0, 800) });
      journal(journalPath, { at: Date.now() / 1000, kind: "result", tool: String(call.tool), status: "ok", content: "{\"ok\": true}" });
    }
    if (!capturesCache.has(benchmarkDir)) capturesCache.set(benchmarkDir, readCapturesByKey(benchmarkDir));
    const gold = goldFinalResponseFor(sidecar, capturesCache.get(benchmarkDir)!);
    const missingGold = gold === null && responseJudgedRequired(sidecar).length > 0 ? ["response"] : [];
    const scored = asObject(scoreContract(sidecar, { calls, finalResponse: gold ?? "" }));
    // The hub replays accumulation from row.writes: keep it the contract's
    // state effects exactly (the rules the state scorer judges), as before.
    const writes = ((asObject(sidecar.outcome_contract).required ?? []) as unknown[]).map(asObject).filter((rule) => String(rule.type ?? "state_effect") === "state_effect").map((rule) => ({ tool: String(rule.tool), arguments: rule.observed_arguments ?? {} }));
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
      tool_call_count: calls.length,
      final_response_chars: gold === null ? null : gold.trim().length,
      ...(missingGold.length > 0 ? { oracle: { missing_gold: missingGold } } : {}),
    };
  };
}

/* ------------------------------------------------------------------ */
/* Trivial calibration arms (agentic-benchmarks floor discipline)      */
/* ------------------------------------------------------------------ */

/** The null agent's entire output: deterministic boilerplate, never task-derived. */
export const NULL_AGENT_FINAL_RESPONSE = "I was unable to complete this task.";

const trivialSubscores = (scored: Obj, label: "runner_null_agent" | "runner_spam_agent" | "runner_majority_class"): Record<string, number> => ({
  final_state: Number(scored.strict ?? 0),
  final_state_partial_credit: Number(scored.recall ?? 0),
  recall: Number(scored.recall ?? 0),
  precision: Number(scored.precision ?? 0),
  policy: Number(scored.policy ?? 0),
  [label]: 1,
});

/**
 * Null-agent arm: adversarially inert. Makes NO tool calls and answers every
 * task with the same boilerplate final response, scored through the SAME
 * full-contract scorer real arms are judged by (scoreContract over the empty
 * event stream). Deterministic, zero provider calls, zero cost. Any task this
 * arm passes is satisfiable by doing nothing — the tau-bench 38% class.
 */
export function nullAgentRunner(): ArmRunner {
  return async ({ task }) => {
    const started = Date.now();
    const scored = asObject(scoreContract(asObject(task), { calls: [], finalResponse: NULL_AGENT_FINAL_RESPONSE }));
    return {
      score: Number(scored.strict ?? 0),
      subscores: trivialSubscores(scored, "runner_null_agent"),
      status: "ok" as const,
      latency_ms: Math.max(1, Date.now() - started),
      cost: 0,
      writes: [],
      tool_call_count: 0,
      final_response_chars: NULL_AGENT_FINAL_RESPONSE.length,
    };
  };
}

/**
 * Deterministic schema-minimal arguments for one declared tool schema
 * (environment/understudy_trace_env/servers/schemas.json entry): every
 * required property gets the zero value of its declared type; observed enums
 * get their first (sorted-stable as recorded) allowed value. No randomness,
 * no task-derived content — the point is ritual, content-free tool calling.
 */
export function schemaMinimalArguments(schema: Obj): Obj {
  const properties = asObject(schema.properties);
  const enums = asObject(schema.enums_by_observation);
  const zero = (type: unknown): unknown => {
    if (type === "number" || type === "integer") return 0;
    if (type === "boolean") return false;
    if (type === "array") return [];
    if (type === "object") return {};
    return "";
  };
  const args: Obj = {};
  const required = (Array.isArray(schema.required) ? schema.required : []).map(String);
  for (const key of required) args[key] = zero(properties[key]);
  // Observation-tightened requirements/enums keep the call schema-valid in
  // the strict world server; only top-level paths are synthesized.
  for (const path of (Array.isArray(schema.required_by_observation) ? schema.required_by_observation : []).map(String)) {
    if (!path.includes(".") && args[path] === undefined) args[path] = zero(properties[path]);
  }
  for (const [path, allowed] of Object.entries(enums)) {
    if (!path.includes(".") && Array.isArray(allowed) && allowed.length > 0) args[path] = allowed[0];
  }
  return args;
}

/** The benchmark's declared tool surface: schemas.json when present, else the tools named by the task's own contract (empty args). */
export function spamToolSurface(benchmarkDir: string, task: Obj): { tool: string; arguments: Obj }[] {
  try {
    const schemas = asObject(JSON.parse(readFileSync(join(resolve(benchmarkDir), "environment", "understudy_trace_env", "servers", "schemas.json"), "utf8")));
    const tools = Object.keys(schemas).sort();
    if (tools.length > 0) return tools.map((tool) => ({ tool, arguments: schemaMinimalArguments(asObject(schemas[tool])) }));
  } catch { /* no generated environment — fall back to the contract's tools */ }
  const contract = asObject(task.outcome_contract);
  const tools = new Set<string>();
  for (const listName of ["required", "preserved", "forbidden"]) {
    for (const rule of (Array.isArray(contract[listName]) ? (contract[listName] as unknown[]) : []).map(asObject)) {
      if (typeof rule.tool === "string" && rule.tool) tools.add(rule.tool);
    }
  }
  return [...tools].sort().map((tool) => ({ tool, arguments: {} }));
}

/**
 * Spam-agent arm: deterministically calls EVERY tool in the benchmark's tool
 * surface exactly once with schema-minimal arguments, then stops with a
 * boilerplate final response. Scored through the same full-contract scorer.
 * Any task this arm passes is satisfiable by ritual behavior (touch every
 * tool, say nothing) rather than by understanding the task.
 */
export function spamAgentRunner(): ArmRunner {
  const journal = appendJournalEntry;
  return async ({ benchmarkDir, task, journalPath }) => {
    const started = Date.now();
    const calls = spamToolSurface(benchmarkDir, asObject(task));
    for (const call of calls) {
      journal(journalPath, { at: Date.now() / 1000, kind: "call", tool: call.tool, write: isMutatingTool(call.tool), status: "ok", arguments: JSON.stringify(call.arguments).slice(0, 800) });
      journal(journalPath, { at: Date.now() / 1000, kind: "result", tool: call.tool, status: "ok", content: "{\"ok\": true}" });
    }
    const scored = asObject(scoreContract(asObject(task), { calls, finalResponse: NULL_AGENT_FINAL_RESPONSE }));
    return {
      score: Number(scored.strict ?? 0),
      subscores: trivialSubscores(scored, "runner_spam_agent"),
      status: "ok" as const,
      latency_ms: Math.max(1, Date.now() - started),
      cost: 0,
      writes: calls.filter((call) => isMutatingTool(call.tool)),
      tool_call_count: calls.length,
      final_response_chars: NULL_AGENT_FINAL_RESPONSE.length,
    };
  };
}

/* ------------------------------------------------------------------ */
/* Majority-class floor arm (the imbalanced-classifier trap)           */
/* ------------------------------------------------------------------ */

/**
 * The gold LABEL of a classification-shaped task, or null when the task is
 * not classification-shaped. Classification-shaped = the outcome contract's
 * required obligations are EXACTLY ONE response obligation whose gold is a
 * label (`contains_category` with a string `expected`) — a task with state
 * effects or multiple obligations is an agentic task, not a classifier row.
 */
export function classificationGoldLabel(task: Obj): string | null {
  const required = ((asObject(task.outcome_contract).required ?? []) as unknown[]).map(asObject);
  if (required.length !== 1) return null;
  const rule = required[0];
  if (String(rule.type ?? "state_effect") !== "response_obligation" || String(rule.kind ?? "") !== "contains_category") return null;
  const expected = typeof rule.expected === "string" ? rule.expected.trim() : "";
  return expected.length > 0 ? expected : null;
}

/**
 * The most frequent classification gold label across the benchmark's TRAIN
 * split — NEVER holdout/dev: the majority arm must not read the answer
 * distribution of the split it is scored on. Ties break deterministically to
 * the lexicographically smallest label. Null when the train split has no
 * classification-shaped tasks.
 */
export function majorityTrainLabel(manifestTasks: Obj[], sidecarTasksById: Map<string, Obj>): string | null {
  const counts = new Map<string, number>();
  for (const task of manifestTasks.map(asObject)) {
    if (String(task.split ?? "") !== "train") continue; // holdout/dev structurally excluded
    const sidecar = sidecarTasksById.get(String(task.task_id));
    const label = sidecar ? classificationGoldLabel(sidecar) : null;
    if (label !== null) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [label, count] of counts) {
    if (best === null || count > counts.get(best)! || (count === counts.get(best)! && label < best)) best = label;
  }
  return best;
}

/** Read the benchmark's majority train label from its own artifacts (benchmark.json splits + tasks.jsonl contracts). */
export function benchmarkMajorityTrainLabel(benchmarkDir: string): string | null {
  const dir = resolve(benchmarkDir);
  let manifestTasks: Obj[] = [];
  try {
    manifestTasks = (asObject(JSON.parse(readFileSync(join(dir, "benchmark.json"), "utf8"))).tasks ?? []).map(asObject);
  } catch {
    return null;
  }
  const sidecar = new Map(readJsonl(join(dir, "tasks.jsonl")).map((t) => [String(t.task_id), t]));
  return majorityTrainLabel(manifestTasks, sidecar);
}

/**
 * Majority-class arm: on classification-shaped tasks it deterministically
 * answers the benchmark's most frequent TRAIN-split gold label (computed from
 * the tasks' split assignment — never holdout); on every other task shape it
 * behaves exactly like the null agent. Zero tool calls, zero cost, scored
 * through the same full-contract scorer. Any classification benchmark this
 * arm passes at a high rate is dominated by its majority label — the
 * imbalanced-classifier trap a naive accuracy leaderboard hides.
 */
export function majorityClassRunner(): ArmRunner {
  const labelCache = new Map<string, string | null>();
  return async ({ benchmarkDir, task }) => {
    const started = Date.now();
    if (!labelCache.has(benchmarkDir)) labelCache.set(benchmarkDir, benchmarkMajorityTrainLabel(benchmarkDir));
    const majority = labelCache.get(benchmarkDir) ?? null;
    // Non-classification tasks (or no train-split labels at all): null-agent behavior.
    const response = classificationGoldLabel(asObject(task)) !== null && majority !== null ? majority : NULL_AGENT_FINAL_RESPONSE;
    const scored = asObject(scoreContract(asObject(task), { calls: [], finalResponse: response }));
    return {
      score: Number(scored.strict ?? 0),
      subscores: trivialSubscores(scored, "runner_majority_class"),
      status: "ok" as const,
      latency_ms: Math.max(1, Date.now() - started),
      cost: 0,
      writes: [],
      tool_call_count: 0,
      final_response_chars: response.length,
    };
  };
}

/**
 * Per-invocation work directory for one verifiers eval subprocess. The eval
 * writes outputs/ relative to its CWD, so giving every (run, arm) invocation
 * its own cwd makes trace attribution STRUCTURAL: two concurrent runs of the
 * same model can never cross-read each other's traces.jsonl (the mtime-based
 * hazard this replaces). Old layouts (outputs/ directly under the benchmark
 * dir) stay readable via the legacy fallback in runVerifiersSplits.
 */
export function verifiersWorkDir(benchmarkDir: string, invocationTag: string): string {
  return join(resolve(benchmarkDir), "runs", "work", sanitizeForFile(invocationTag));
}

/**
 * traces.jsonl files under <root>/outputs/ newer than `since` (the verifiers
 * eval writes outputs/ relative to its cwd). With per-invocation work dirs the
 * root is already unique per (run, arm); the mtime filter only matters for the
 * legacy shared-outputs layout.
 */
export function newOutputFiles(root: string, since: number): string[] {
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
  walk(join(root, "outputs"));
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
export function projectVerifiersTrace(trace: Obj, model: string, options: { local?: boolean } = {}): { taskId: string | null; result: RolloutResult } {
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
  // A LOCAL artifact arm costs $0 by construction (no provider tokens are
  // billed); the gateway heuristic would fabricate spend from a made-up rate.
  const cost = options.local ? 0 : calls.length > 0 ? (promptTokens * rate.input + completionTokens * rate.output) / 1_000_000 : null;
  // Local-arm throughput evidence: completion tokens over measured model-call
  // wall time — only when both are actually present in the trace.
  const tokensPerSec = options.local && completionTokens > 0 && latencyMs > 0 ? Number(((completionTokens * 1000) / latencyMs).toFixed(2)) : null;
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
      ...(tokensPerSec !== null ? { perf: { tokens_per_sec: tokensPerSec } } : {}),
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
export type VerifiersArmOptions = {
  /** Per-rollout budget in seconds — the eval subprocess gets timeout × tasks-in-split and is killed on expiry (each unresolved task becomes a rollout_timeout row). */
  timeoutSeconds?: number | null;
  /** Unique per-invocation tag (run_id + arm) — the eval runs in its own work dir so trace attribution is structural, never mtime-based. */
  invocationTag?: string | null;
  /** Run-scoped prompt-override suffix: appended to each selected task's system prompt for THIS invocation only (the temp-rewrite pattern; the source rows are restored after). */
  systemPromptSuffix?: string | null;
  /** Local-artifact arm: the served endpoint replaces the gateway creds for THIS invocation (the eval's -m gets modelId — MLX servers accept the weights path). */
  local?: { baseUrl: string; modelId: string } | null;
};

/** Apply a run-scoped override suffix to one generated-environment task row (pure; used by the temp-rewrite below and its tests). */
export function applySystemPromptSuffix(row: Obj, suffix: string): Obj {
  const existing = typeof row.system_prompt === "string" ? row.system_prompt : "";
  return { ...row, system_prompt: existing.length > 0 ? `${existing}\n\n${suffix}` : suffix };
}

export function runVerifiersArm(benchmarkDir: string, model: string, maxExamples: number, parentEnv: NodeJS.ProcessEnv = process.env, taskIds: string[] | null = null, journalPath: string | null = null, options: VerifiersArmOptions = {}): Map<string, RolloutResult> {
  const dir = resolve(benchmarkDir);
  const environment = join(dir, "environment");
  // Scope the eval to exactly the requested tasks (a single-task run on a
  // large benchmark must never fan out to every env task): the taskset loads
  // rows from tasks.json, so temporarily filter it — the same temp-rewrite
  // pattern runTraceReplays uses for context variants — and restore after.
  const taskRowsPath = join(environment, "understudy_trace_env", "tasks.json");
  const allTaskRows: Obj[] | null = existsSync(taskRowsPath) ? ((JSON.parse(readFileSync(taskRowsPath, "utf8")) as unknown[]).map(asObject)) : null;
  const suffix = options.systemPromptSuffix?.trim() ? options.systemPromptSuffix : null;
  // A rewrite happens when the run scopes to a task subset OR carries a
  // prompt-override suffix; either way the SOURCE rows are restored after —
  // the override is run-scoped only, never a persistent task-file mutation.
  const sourceTaskRows = taskIds !== null || suffix !== null ? allTaskRows : null;
  const wanted = taskIds === null ? null : new Set(taskIds);
  const filteredRows = taskIds === null ? null : (allTaskRows ?? []).filter((row) => wanted!.has(String(row.task_id)));
  const splits = filteredRows === null ? ["train", "dev", "holdout"] : [...new Set(filteredRows.map((row) => String(row.split)))];
  // Split → task ids the eval will attempt: sizes the per-split subprocess
  // timeout budget and names the tasks a killed split leaves unresolved.
  const taskIdsBySplit = new Map<string, string[]>();
  for (const row of filteredRows ?? allTaskRows ?? []) {
    const split = String(row.split);
    taskIdsBySplit.set(split, [...(taskIdsBySplit.get(split) ?? []), String(row.task_id)]);
  }
  const effectiveRows = filteredRows ?? allTaskRows;
  const rowsToWrite = suffix !== null && effectiveRows !== null ? effectiveRows.map((row) => applySystemPromptSuffix(row, suffix)) : filteredRows;
  if (sourceTaskRows !== null && rowsToWrite !== null) writeFileSync(taskRowsPath, `${JSON.stringify(rowsToWrite, null, 2)}\n`, { mode: 0o600 });
  try {
    return runVerifiersSplits(dir, environment, model, maxExamples, parentEnv, splits, journalPath, { ...options, taskIdsBySplit });
  } finally {
    if (sourceTaskRows !== null) writeFileSync(taskRowsPath, `${JSON.stringify(sourceTaskRows, null, 2)}\n`, { mode: 0o600 });
  }
}

function runVerifiersSplits(dir: string, environment: string, model: string, maxExamples: number, parentEnv: NodeJS.ProcessEnv, splits: string[], journalPath: string | null = null, options: VerifiersArmOptions & { taskIdsBySplit?: Map<string, string[]> } = {}): Map<string, RolloutResult> {
  // Gateway creds resolve the CLI's canonical way (env first, then
  // ~/.understudy/credentials.json) and are handed to buildReplayInvocation
  // through its own env contract — the executor ONLY talks to the Understudy
  // gateway, never a stray OPENAI_* pointing elsewhere.
  // Local arms point the runner's OpenAI-compatible client at the served
  // artifact instead — buildReplayInvocation's own env contract carries the
  // base URL/key either way (no gateway credential is ever required for a
  // fully-local arm).
  const local = options.local ?? null;
  const runnerEnv: NodeJS.ProcessEnv = local !== null
    ? { ...parentEnv, UNDERSTUDY_GATEWAY_URL: local.baseUrl, UNDERSTUDY_API_KEY: "local", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined }
    : (() => {
        const auth = resolveGatewayAuth(parentEnv);
        return { ...parentEnv, UNDERSTUDY_GATEWAY_URL: auth.baseUrl, UNDERSTUDY_API_KEY: auth.apiKey, OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined };
      })();
  const evalModel = local?.modelId ?? model;
  // The generated taskset loads ONE split per eval (config default train), so
  // an arm covers all tasks by running each split; a split with no tasks
  // fails its own eval harmlessly (the merged map decides success below).
  const results = new Map<string, RolloutResult>();
  const failures: string[] = [];
  // Per-invocation output isolation: the eval writes outputs/ relative to its
  // cwd, so an invocation tag gives this (run, arm) its own work dir — trace
  // attribution becomes structural instead of "traces.jsonl newer than start",
  // which two concurrent same-model runs could cross-read.
  const workDir = options.invocationTag ? verifiersWorkDir(dir, options.invocationTag) : dir;
  if (workDir !== dir) mkdirSync(workDir, { recursive: true });
  for (const split of splits) {
    const invocation = buildReplayInvocation(environment, evalModel, "authentic_history", maxExamples, false, runnerEnv);
    // Live watching: the generated world server journals every tool call and
    // result to this file the moment it happens (no-op when unset). The var
    // rides the eval subprocess env, which the subprocess runtime inherits.
    if (journalPath !== null) invocation.env.UNDERSTUDY_LIVE_JOURNAL = journalPath;
    invocation.args.push("--env.taskset.split", split);
    // Subprocess kill switch for hung rollouts: the eval runs the split's
    // tasks in one child, so its budget is per-rollout timeout × task count.
    const splitTaskIds = options.taskIdsBySplit?.get(split) ?? [];
    const budgetMs = options.timeoutSeconds ? Math.max(1, Math.round(options.timeoutSeconds * 1000)) * Math.max(1, splitTaskIds.length) : undefined;
    const started = Date.now();
    const child = spawnSync("uv", invocation.args, { cwd: workDir, encoding: "utf8", env: invocation.env, maxBuffer: 64 * 1024 * 1024, ...(budgetMs !== undefined ? { timeout: budgetMs, killSignal: "SIGKILL" as const } : {}) });
    const timedOut = (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || (budgetMs !== undefined && child.status === null && child.signal !== null);
    if (child.error && !timedOut) throw new HarnessExecutionError(`could not start uv/verifiers: ${child.error.message}`);
    if (child.status !== 0 && !timedOut) {
      failures.push(`split ${split}: exited ${child.status}: ${`${child.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n")}`);
      continue;
    }
    // Structural read first (this invocation's own work dir); the legacy
    // shared-outputs layout stays readable for old runs / untagged callers.
    let files = newOutputFiles(workDir, started - 1000);
    if (files.length === 0 && workDir !== dir) files = newOutputFiles(dir, started - 1000);
    for (const file of files) {
      for (const line of readJsonl(file)) {
        for (const trace of (Array.isArray(line.traces) ? line.traces : []).map(asObject)) {
          const { taskId, result } = projectVerifiersTrace(trace, model, { local: local !== null });
          if (taskId && !results.has(taskId)) results.set(taskId, result);
        }
      }
    }
    if (timedOut) {
      // Every task the killed split left unresolved becomes an explicit
      // rollout_timeout result (marked + excluded like other anomalies);
      // traces the child wrote before the kill are kept above.
      for (const taskId of splitTaskIds) {
        if (results.has(taskId)) continue;
        results.set(taskId, { score: null, subscores: null, status: "error", latency_ms: budgetMs ?? null, cost: null, writes: [], timed_out: true, error: `rollout_timeout: verifiers eval for split ${split} exceeded ${Math.round((budgetMs ?? 0) / 1000)}s and was killed` });
      }
      if (splitTaskIds.length === 0) failures.push(`split ${split}: timed out after ${budgetMs}ms and was killed`);
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
  return async ({ benchmarkDir, model, task, selectedTaskIds, journalPath, runId, rolloutTimeoutSeconds, armLabel, systemPromptSuffix, local }) => {
    // Cache/work-dir key on the arm LABEL: an override arm never shares its
    // memoized eval (or its output isolation) with the bare model arm.
    const arm = armLabel ?? model;
    const key = `${benchmarkDir}::${runId ?? ""}::${arm}::${systemPromptSuffix ? promptSuffixHash(systemPromptSuffix) : ""}::${local ? local.baseUrl : ""}::${[...selectedTaskIds].sort().join(",")}`;
    if (!armCache.has(key)) {
      try {
        armCache.set(key, runVerifiersArm(benchmarkDir, model, VERIFIERS_MAX_EXAMPLES, parentEnv, selectedTaskIds, journalPath, {
          timeoutSeconds: rolloutTimeoutSeconds ?? null,
          // run_id + arm in the path: structural per-invocation isolation.
          invocationTag: runId ? `${runId}--${arm}` : null,
          systemPromptSuffix: systemPromptSuffix ?? null,
          // Local artifact arm: the eval talks to the served endpoint, never the gateway.
          local: local ?? null,
        }));
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
