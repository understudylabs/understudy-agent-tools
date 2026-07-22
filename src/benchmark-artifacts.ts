/**
 * benchmark-artifacts — the ONE home for the producer/consumer codecs of every
 * file-based artifact a benchmark directory carries.
 *
 * Why this module exists: the foundry/CLI (src/trace-foundry.ts,
 * src/trace-author.ts, src/run-executor.ts) writes these artifacts and the
 * Benchmark Hub (apps/benchmark-hub/lib/*) reads them, and the two sides
 * drifted repeatedly — the schema-name collision, the renamed proposal stamp,
 * "accept both grounding shapes", and the legacy-journal newline saga. The
 * fix that stuck is the runs-core pattern: the hub re-imports the CLI's
 * compiled dist module so the contract physically cannot fork. This module
 * extends that pattern to the JSONL codec, the live journal, run events,
 * reviews, capture-body naming, and recorded-path portability.
 *
 * Contract invariants (documented so tests can enforce them):
 * - Every JSONL line is `JSON.stringify(row)` + "\n". JSON.stringify escapes
 *   in-string newlines to `\n`, so a physical line is always exactly one row —
 *   the invariant the legacy-journal split violated (commit 9800be7).
 * - Readers are TOLERANT: blank lines are skipped, malformed lines are
 *   counted (never fatal), and a torn tail line mid-append is left for the
 *   next poll.
 * - Recorded paths inside artifacts are benchmark-dir-relative with POSIX
 *   separators (see toPortablePath); readers accept legacy absolute paths.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Obj = Record<string, unknown>;
const asObject = (value: unknown): Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};

/* ------------------------------------------------------------------ */
/* Schema ids — string literals live HERE, nowhere else.               */
/* ------------------------------------------------------------------ */

export const TRACE_FOUNDRY_SCHEMA = "understudy.trace_foundry.v1";
export const BENCHMARK_SCHEMA = "understudy.benchmark.v1";
/** Pre-promotion machine proposal (post schema-name-collision rename). */
export const BENCHMARK_PROPOSAL_SCHEMA = "understudy.benchmark_proposal.v1";
export const BENCHMARK_TASK_SCHEMA = "understudy.benchmark_task.v1";
export const BENCHMARK_REVIEW_SCHEMA = "understudy.benchmark_review.v1";
export const BENCHMARK_FLAG_SCHEMA = "understudy.benchmark_flag.v1";
export const BENCHMARK_OVERVIEW_SCHEMA = "understudy.benchmark_overview.v1";
export const EVAL_RESULT_SCHEMA = "understudy.eval_result.v1";
export const SOURCE_DAG_SCHEMA = "understudy.source_dag.v1";
export const PROMOTION_RECORD_SCHEMA = "understudy.promotion_record.v1";
export const RUN_EVENT_SCHEMA = "understudy.run_event.v1";
/** calibration.json sidecar written after a run with an incumbent arm finishes. */
export const CALIBRATION_SCHEMA = "understudy.calibration.v1";
export const AUTHORING_EVENT_SCHEMA = "understudy.authoring_event.v1";
/** Foundry generation-time structural self-check (manifest.self_check + task.self_check). */
export const FOUNDRY_SELF_CHECK_SCHEMA = "understudy.foundry_self_check.v1";
/** Generated servers/guidance.json — rejection-guidance message templates the world loads as data (an optimizable prompt surface). */
export const REJECTION_GUIDANCE_SCHEMA = "understudy.rejection_guidance.v1";
/** feedback.jsonl sidecar: free-text "what's wrong with this task" lines (append-only). */
export const TASK_FEEDBACK_SCHEMA = "understudy.task_feedback.v1";
/** review-policy.json sidecar: configurable exception-review auto-accept bar. */
export const REVIEW_POLICY_SCHEMA = "understudy.review_policy.v1";
/** app-harness.json sidecar: how to launch the user's OWN app per task (the app_replay arm). */
export const APP_HARNESS_SCHEMA = "understudy.app_harness.v1";
/** experiments.jsonl sidecar: data-selection → training → artifact → eval → verdict lineage (append-only). */
export const EXPERIMENT_SCHEMA = "understudy.experiment.v1";

/* ------------------------------------------------------------------ */
/* JSONL codec                                                         */
/* ------------------------------------------------------------------ */

/**
 * One JSONL line for one row. JSON.stringify NEVER emits a raw newline
 * (in-string newlines become the two characters `\` `n`), so the write side
 * of the one-line-one-row invariant holds by construction.
 */
export function serializeJsonlLine(row: unknown): string {
  return `${JSON.stringify(row)}\n`;
}

export type JsonlParseResult<T> = { items: T[]; skipped: number };

/**
 * Tolerant JSONL parse: \r\n tolerated, blank lines skipped, malformed lines
 * counted in `skipped` instead of failing the caller (the hub's page-level
 * behavior, now shared with the CLI's readers).
 */
export function parseJsonlText<T = Obj>(text: string): JsonlParseResult<T> {
  const items: T[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed) as T);
    } catch {
      skipped += 1;
    }
  }
  return { items, skipped };
}

/** parseJsonlText over a file; a missing/unreadable file is an empty result. */
export function readJsonlFile<T = Obj>(file: string): JsonlParseResult<T> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { items: [], skipped: 0 };
  }
  return parseJsonlText<T>(text);
}

/* ------------------------------------------------------------------ */
/* Live journal (<benchmark>/runs/live/<run>-<model>.jsonl)            */
/* ------------------------------------------------------------------ */

/**
 * One live-journal entry: `kind` is "call" or "result"; call entries carry
 * tool + arguments (arguments may be a JSON string — the generated world
 * server and the oracle runner cap the summary at 800 chars).
 */
export type JournalEntry = Obj & { kind?: string; tool?: string; arguments?: unknown; status?: string };

export function serializeJournalEntry(entry: JournalEntry): string {
  return serializeJsonlLine(entry);
}

/** Best-effort append (the writer contract: never fail a rollout over the journal). */
export function appendJournalEntry(path: string | null, entry: JournalEntry): void {
  if (!path) return;
  try {
    appendFileSync(path, serializeJournalEntry(entry), { mode: 0o600 });
  } catch {
    /* live journal is best-effort */
  }
}

export type JournalParseResult = { lines: Obj[]; total: number };

/**
 * Parse a live journal for polling readers. Torn-tail rule (shared with the
 * hub's /api/runs/live): the first malformed line ends the read AND is not
 * counted in `total`, so the next poll re-reads it whole. `maxLines` caps the
 * read — never trust a file size.
 */
export function parseJournalText(text: string, maxLines = 5_000): JournalParseResult {
  const raw = text.split("\n").filter(Boolean).slice(0, maxLines);
  let total = raw.length;
  const lines: Obj[] = [];
  for (const line of raw) {
    try {
      lines.push(asObject(JSON.parse(line)));
    } catch {
      total -= 1;
      break;
    }
  }
  return { lines, total };
}

export type JournalCall = { name: string; arguments: unknown; status?: string };

/**
 * Extract the tool-call events a contract accumulator scores. Legacy
 * tolerance: `arguments` recorded as a JSON string (the 800-char summary) is
 * parsed back when possible, kept raw otherwise.
 */
export function journalCalls(lines: Obj[]): JournalCall[] {
  const calls: JournalCall[] = [];
  for (const line of lines) {
    if (line.kind !== "call") continue;
    let args: unknown = line.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        /* keep the summary string */
      }
    }
    calls.push({ name: String(line.tool ?? ""), arguments: args, ...(line.status === "error" ? { status: "error" } : {}) });
  }
  return calls;
}

/* ------------------------------------------------------------------ */
/* Run events (<benchmark>/runs/events.jsonl)                          */
/* ------------------------------------------------------------------ */

export type RunEvent = Obj & { schema_version?: string; ts?: string; run_id?: string; type?: string };

export function serializeRunEvent(event: RunEvent): string {
  return serializeJsonlLine(event);
}

/** Tolerant read of runs/events.jsonl, dropping rows without the v1 stamp. */
export function readRunEvents(file: string): { events: RunEvent[]; skipped: number } {
  const { items, skipped } = readJsonlFile<RunEvent>(file);
  return { events: items.filter((event) => event?.schema_version === RUN_EVENT_SCHEMA), skipped };
}

/* ------------------------------------------------------------------ */
/* Reviews (<benchmark>/reviews.jsonl — append-only, newest per task wins) */
/* ------------------------------------------------------------------ */

export const REVIEW_DECISIONS = ["accept", "restrict", "needs_more", "reject"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export type BenchmarkReview = {
  schema_version: typeof BENCHMARK_REVIEW_SCHEMA;
  /** Foundry output dir slug (directory basename), NOT a benchmark.v1 benchmark_id. */
  benchmark_id: string;
  task_id: string;
  decision: ReviewDecision;
  note: string;
  created_at: string;
  /**
   * Additive: who recorded the decision. "auto" = the hub's exception-review
   * auto-accept policy (applied only on an explicit user click, never on page
   * load); absent/"human" = a human clicked the review bar. Reversible either
   * way — the append-only newest-per-task rule is unchanged.
   */
  source?: "auto" | "human";
};

/** The reader-side acceptance test for one reviews.jsonl row. */
export function isBenchmarkReview(row: unknown): row is BenchmarkReview {
  const r = asObject(row);
  return (
    r.schema_version === BENCHMARK_REVIEW_SCHEMA &&
    typeof r.task_id === "string" &&
    REVIEW_DECISIONS.includes(r.decision as ReviewDecision)
  );
}

/** The ONE constructor every review producer uses. */
export function makeBenchmarkReview(input: {
  benchmark_id: string;
  task_id: string;
  decision: ReviewDecision;
  note?: string | null;
  created_at?: string;
  source?: "auto" | "human";
}): BenchmarkReview {
  return {
    schema_version: BENCHMARK_REVIEW_SCHEMA,
    benchmark_id: input.benchmark_id,
    task_id: input.task_id,
    decision: input.decision,
    note: typeof input.note === "string" ? input.note : "",
    created_at: input.created_at ?? new Date().toISOString(),
    // Additive: omitted entirely when unspecified so legacy lines stay byte-identical.
    ...(input.source ? { source: input.source } : {}),
  };
}

export function serializeReviewLine(review: BenchmarkReview): string {
  return serializeJsonlLine(review);
}

/** Valid reviews from a reviews.jsonl file (invalid rows dropped, lines tolerant). */
export function readReviews(file: string): { reviews: BenchmarkReview[]; skipped: number } {
  const { items, skipped } = readJsonlFile(file);
  return { reviews: items.filter(isBenchmarkReview), skipped };
}

/** Superseding rule: append-only file, newest line per task_id wins. */
export function latestReviewByTask(reviews: BenchmarkReview[]): Record<string, BenchmarkReview> {
  const latest: Record<string, BenchmarkReview> = {};
  for (const review of reviews) latest[review.task_id] = review;
  return latest;
}

/* ------------------------------------------------------------------ */
/* Task feedback (<benchmark>/feedback.jsonl — append-only sidecar)    */
/* ------------------------------------------------------------------ */

/**
 * understudy.task_feedback.v1 — one free-text "what's wrong with this task"
 * line from the hub's conversational edit box. The hub only RECORDS the
 * feedback and hands the user a copyable agent prompt (the hub never
 * executes); a coding agent — or a future daemon verb — consumes open lines
 * and runs `understudy traces regenerate-env` after editing the task. No
 * absolute paths are recorded (portability rule): benchmark_id is the foundry
 * output dir basename, same convention as reviews.jsonl.
 */
export type TaskFeedback = {
  schema_version: typeof TASK_FEEDBACK_SCHEMA;
  /** Foundry output dir slug (directory basename), NOT a benchmark.v1 benchmark_id. */
  benchmark_id: string;
  task_id: string;
  /** The reviewer's own words describing what is wrong / should change. */
  feedback: string;
  created_at: string;
  /** Producing surface ("hub" for the review UI; agents may append with their own label). */
  source: string;
  /** Lifecycle for a future consumer verb: open → addressed. Append-only file; newest line per task_id wins. */
  status: "open" | "addressed";
};

/** Reader-side acceptance test for one feedback.jsonl row. */
export function isTaskFeedback(row: unknown): row is TaskFeedback {
  const r = asObject(row);
  return (
    r.schema_version === TASK_FEEDBACK_SCHEMA &&
    typeof r.benchmark_id === "string" &&
    typeof r.task_id === "string" &&
    typeof r.feedback === "string" &&
    (r.status === "open" || r.status === "addressed")
  );
}

/** The ONE constructor every feedback producer uses. */
export function makeTaskFeedback(input: {
  benchmark_id: string;
  task_id: string;
  feedback: string;
  source?: string;
  status?: "open" | "addressed";
  created_at?: string;
}): TaskFeedback {
  return {
    schema_version: TASK_FEEDBACK_SCHEMA,
    benchmark_id: input.benchmark_id,
    task_id: input.task_id,
    feedback: input.feedback,
    created_at: input.created_at ?? new Date().toISOString(),
    source: input.source ?? "hub",
    status: input.status ?? "open",
  };
}

export function serializeTaskFeedbackLine(feedback: TaskFeedback): string {
  return serializeJsonlLine(feedback);
}

/** Valid feedback rows from a feedback.jsonl file (invalid rows dropped, lines tolerant). */
export function readTaskFeedback(file: string): { feedback: TaskFeedback[]; skipped: number } {
  const { items, skipped } = readJsonlFile(file);
  return { feedback: items.filter(isTaskFeedback), skipped };
}

/* ------------------------------------------------------------------ */
/* Review policy (<benchmark>/review-policy.json — optional sidecar)   */
/* ------------------------------------------------------------------ */

/**
 * understudy.review_policy.v1 — configures the exception-review auto-accept
 * bar. A SIDECAR (not a manifest field) on purpose: manifest.json is
 * machine-written by the foundry and regenerated on rebuilds, while the
 * policy is human/operator-owned post-generation state — the same ownership
 * split as reviews.jsonl and feedback.jsonl. Absent/invalid file = defaults,
 * which reproduce the pre-policy behavior exactly.
 */
export type MachineConfidence = "high" | "medium" | "low";

export type ReviewPolicy = {
  schema_version: typeof REVIEW_POLICY_SCHEMA;
  /** Lowest machine_confidence that can auto-accept (close_call still always excepts). */
  min_confidence: MachineConfidence;
  /** When false, an incumbent calibration failure no longer blocks auto-accept. */
  require_incumbent_pass: boolean;
};

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  schema_version: REVIEW_POLICY_SCHEMA,
  min_confidence: "high",
  require_incumbent_pass: true,
};

const CONFIDENCE_RANK: Record<MachineConfidence, number> = { high: 2, medium: 1, low: 0 };

/** True when `level` clears the policy's min_confidence bar (high > medium > low). */
export function meetsConfidenceBar(level: string | null | undefined, minConfidence: MachineConfidence): boolean {
  const rank = CONFIDENCE_RANK[level as MachineConfidence];
  return rank !== undefined && rank >= CONFIDENCE_RANK[minConfidence];
}

export function reviewPolicyPath(benchmarkDir: string): string {
  return join(benchmarkDir, "review-policy.json");
}

/**
 * Read the policy in force for a benchmark dir. TOLERANT + field-wise
 * additive: a missing/unreadable/wrong-schema file yields the defaults, and
 * recognized fields override the defaults individually (unknown values are
 * ignored, never fatal — a typo'd policy must not silently loosen the bar).
 */
export function readReviewPolicy(benchmarkDir: string): ReviewPolicy {
  let parsed: Obj;
  try {
    parsed = asObject(JSON.parse(readFileSync(reviewPolicyPath(benchmarkDir), "utf8")));
  } catch {
    return { ...DEFAULT_REVIEW_POLICY };
  }
  if (parsed.schema_version !== REVIEW_POLICY_SCHEMA) return { ...DEFAULT_REVIEW_POLICY };
  return {
    ...DEFAULT_REVIEW_POLICY,
    ...(parsed.min_confidence === "high" || parsed.min_confidence === "medium" || parsed.min_confidence === "low"
      ? { min_confidence: parsed.min_confidence }
      : {}),
    ...(typeof parsed.require_incumbent_pass === "boolean"
      ? { require_incumbent_pass: parsed.require_incumbent_pass }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Experiments (<benchmark>/experiments.jsonl — append-only sidecar)   */
/* ------------------------------------------------------------------ */

/**
 * understudy.experiment.v1 — one machine-readable record of an experiment's
 * full lineage: what data was selected (a curate-trajectories selection hash),
 * how a candidate was trained (method + config + explicit approval gates
 * BEFORE any provider spend — the und-289 shape), what artifact the training
 * produced, which eval runs scored it against which baseline, and the final
 * verdict (promote / shadow / collect / stop — the distill-classifier
 * four-way). Stored append-only next to the benchmark manifest; the newest
 * line per experiment_id supersedes older ones (same superseding rule as
 * reviews.jsonl). Eval rows link back via run_request.experiment_id → run_id.
 */
export const EXPERIMENT_STATUSES = ["draft", "training", "evaluating", "concluded", "abandoned"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const EXPERIMENT_METHODS = ["sft", "lora", "distill", "rl", "prompt_only", "none"] as const;
export type ExperimentMethod = (typeof EXPERIMENT_METHODS)[number];

export const EXPERIMENT_DECISIONS = ["promote", "shadow", "collect", "stop"] as const;
export type ExperimentDecision = (typeof EXPERIMENT_DECISIONS)[number];

/** One cleared approval gate (e.g. "consensus_audit", "customer_data_upload", "provider_training_spend"). */
export type ExperimentApproval = { gate: string; approved_by: string; at: string };

export type Experiment = {
  schema_version: typeof EXPERIMENT_SCHEMA;
  experiment_id: string;
  created_at: string;
  /** The falsifiable claim the experiment tests, in the author's words. */
  hypothesis: string;
  status: ExperimentStatus;
  /** What training/eval data was selected, by provenance hash — never by path. */
  data_selection: {
    /** curate-trajectories selection hash (or an equivalent content hash of the selection). */
    selection_hash: string;
    /** Where the rows came from (dataset name, capture export, foundry dir slug…). */
    source: string;
    /** Optional: sha256 of the frozen train/dev/holdout split artifact. */
    splits_sha256?: string;
  };
  training: {
    method: ExperimentMethod;
    base_model: string;
    /** Freeform provider/tool config (epochs, lr, lora_rank, max_context_length…). */
    config: Record<string, unknown>;
    /** Training location: "local" or a provider id ("fireworks", "tinker"…). */
    provider: string;
    /** Optional freeform estimate (number = USD, or a structured breakdown object). */
    cost_estimate?: number | Record<string, unknown>;
    /**
     * Approval gates CLEARED so far, in order. Gates before provider spend are
     * first-class: a consumer must refuse to upload/train while the record
     * lacks the corresponding gate entry.
     */
    approvals: ExperimentApproval[];
  };
  /** What the training produced (absent until it exists). */
  produced_artifact?: { kind: string; ref: string; sha256: string };
  /** The frozen-incumbent baseline run this experiment is judged against. */
  baseline_run_id?: string;
  /** understudy.run_request.v1 run_ids that evaluated the produced artifact. */
  eval_run_ids: string[];
  /** Final judgment (absent until concluded). */
  verdict?: { decision: ExperimentDecision; summary: string; decided_at: string };
};

export function experimentsPath(benchmarkDir: string): string {
  return join(benchmarkDir, "experiments.jsonl");
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Field-level validation for one experiment record. Returns human-readable
 * errors; empty means valid. Shared by makeExperiment/appendExperiment, the
 * hub-core write ops, the CLI, and the MCP tools — one implementation.
 */
export function validateExperiment(row: unknown): string[] {
  const errors: string[] = [];
  const r = asObject(row);
  if (r.schema_version !== EXPERIMENT_SCHEMA) errors.push(`schema_version must be ${EXPERIMENT_SCHEMA}`);
  if (!isNonEmptyString(r.experiment_id) || !/^[A-Za-z0-9_.-]+$/.test(r.experiment_id as string)) {
    errors.push("experiment_id must be a non-empty string of [A-Za-z0-9_.-]");
  }
  if (!isNonEmptyString(r.created_at)) errors.push("created_at must be an ISO-8601 string");
  if (!isNonEmptyString(r.hypothesis)) errors.push("hypothesis must be a non-empty string");
  if (!EXPERIMENT_STATUSES.includes(r.status as ExperimentStatus)) {
    errors.push(`status must be one of ${EXPERIMENT_STATUSES.join(", ")}`);
  }
  const ds = asObject(r.data_selection);
  if (!isNonEmptyString(ds.selection_hash)) errors.push("data_selection.selection_hash must be a non-empty string");
  if (!isNonEmptyString(ds.source)) errors.push("data_selection.source must be a non-empty string");
  if (ds.splits_sha256 !== undefined && !isNonEmptyString(ds.splits_sha256)) {
    errors.push("data_selection.splits_sha256 must be a non-empty string when present");
  }
  const tr = asObject(r.training);
  if (!EXPERIMENT_METHODS.includes(tr.method as ExperimentMethod)) {
    errors.push(`training.method must be one of ${EXPERIMENT_METHODS.join(", ")}`);
  }
  if (!isNonEmptyString(tr.base_model)) errors.push("training.base_model must be a non-empty string");
  if (tr.config === undefined || tr.config === null || typeof tr.config !== "object" || Array.isArray(tr.config)) {
    errors.push("training.config must be an object (may be empty)");
  }
  if (!isNonEmptyString(tr.provider)) errors.push('training.provider must be "local" or a provider id string');
  if (
    tr.cost_estimate !== undefined &&
    typeof tr.cost_estimate !== "number" &&
    (tr.cost_estimate === null || typeof tr.cost_estimate !== "object" || Array.isArray(tr.cost_estimate))
  ) {
    errors.push("training.cost_estimate must be a number (USD) or an object when present");
  }
  if (!Array.isArray(tr.approvals)) {
    errors.push("training.approvals must be an array (empty = no gates cleared yet)");
  } else {
    tr.approvals.forEach((a, i) => {
      const g = asObject(a);
      if (!isNonEmptyString(g.gate) || !isNonEmptyString(g.approved_by) || !isNonEmptyString(g.at)) {
        errors.push(`training.approvals[${i}] must be {gate, approved_by, at} non-empty strings`);
      }
    });
  }
  if (r.produced_artifact !== undefined) {
    const pa = asObject(r.produced_artifact);
    if (!isNonEmptyString(pa.kind) || !isNonEmptyString(pa.ref) || !isNonEmptyString(pa.sha256)) {
      errors.push("produced_artifact must be {kind, ref, sha256} non-empty strings when present");
    }
  }
  if (r.baseline_run_id !== undefined && !isNonEmptyString(r.baseline_run_id)) {
    errors.push("baseline_run_id must be a non-empty string when present");
  }
  if (!Array.isArray(r.eval_run_ids) || !(r.eval_run_ids as unknown[]).every(isNonEmptyString)) {
    errors.push("eval_run_ids must be an array of run_id strings (empty until runs exist)");
  }
  if (r.verdict !== undefined) {
    const v = asObject(r.verdict);
    if (!EXPERIMENT_DECISIONS.includes(v.decision as ExperimentDecision)) {
      errors.push(`verdict.decision must be one of ${EXPERIMENT_DECISIONS.join(", ")}`);
    }
    if (!isNonEmptyString(v.summary)) errors.push("verdict.summary must be a non-empty string");
    if (!isNonEmptyString(v.decided_at)) errors.push("verdict.decided_at must be an ISO-8601 string");
  }
  return errors;
}

/** Reader-side acceptance test for one experiments.jsonl row. */
export function isExperiment(row: unknown): row is Experiment {
  return validateExperiment(row).length === 0;
}

export type ExperimentInput = {
  experiment_id?: string;
  created_at?: string;
  hypothesis: string;
  status?: ExperimentStatus;
  data_selection: Experiment["data_selection"];
  training: {
    method: ExperimentMethod;
    base_model: string;
    config?: Record<string, unknown>;
    provider: string;
    cost_estimate?: number | Record<string, unknown>;
    approvals?: ExperimentApproval[];
  };
  produced_artifact?: Experiment["produced_artifact"];
  baseline_run_id?: string;
  eval_run_ids?: string[];
  verdict?: Experiment["verdict"];
};

/**
 * The ONE constructor every experiment producer uses. Fills the stamp,
 * a deterministic-enough id when absent, and the lifecycle defaults
 * (status draft, no approvals, no eval runs), then VALIDATES — throws on an
 * invalid record so a malformed experiment can never reach the sidecar.
 */
export function makeExperiment(input: ExperimentInput): Experiment {
  const createdAt = input.created_at ?? new Date().toISOString();
  const experiment: Experiment = {
    schema_version: EXPERIMENT_SCHEMA,
    experiment_id:
      input.experiment_id ??
      `exp-${createHash("sha256").update(JSON.stringify({ input, createdAt, nonce: Math.random() })).digest("hex").slice(0, 12)}`,
    created_at: createdAt,
    hypothesis: input.hypothesis,
    status: input.status ?? "draft",
    data_selection: input.data_selection,
    training: {
      method: input.training?.method,
      base_model: input.training?.base_model,
      config: input.training?.config ?? {},
      provider: input.training?.provider,
      ...(input.training?.cost_estimate !== undefined ? { cost_estimate: input.training.cost_estimate } : {}),
      approvals: input.training?.approvals ?? [],
    },
    ...(input.produced_artifact !== undefined ? { produced_artifact: input.produced_artifact } : {}),
    ...(input.baseline_run_id !== undefined ? { baseline_run_id: input.baseline_run_id } : {}),
    eval_run_ids: input.eval_run_ids ?? [],
    ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
  };
  const errors = validateExperiment(experiment);
  if (errors.length > 0) throw new Error(`invalid experiment: ${errors.join("; ")}`);
  return experiment;
}

export function serializeExperimentLine(experiment: Experiment): string {
  return serializeJsonlLine(experiment);
}

/**
 * Validate + append one experiment line to <benchmarkDir>/experiments.jsonl.
 * Append-only: updates append a FULL superseding record for the same
 * experiment_id (never rewrite the file). Throws on an invalid record.
 */
export function appendExperiment(benchmarkDir: string, experiment: Experiment): string {
  const errors = validateExperiment(experiment);
  if (errors.length > 0) throw new Error(`invalid experiment: ${errors.join("; ")}`);
  const file = experimentsPath(benchmarkDir);
  appendJsonlRows(file, [experiment]);
  return file;
}

/** Valid experiments from an experiments.jsonl file (invalid rows dropped, lines tolerant). */
export function readExperiments(file: string): { experiments: Experiment[]; skipped: number } {
  const { items, skipped } = readJsonlFile(file);
  return { experiments: items.filter(isExperiment), skipped };
}

/** Superseding rule: append-only file, newest line per experiment_id wins. */
export function latestExperiments(experiments: Experiment[]): Record<string, Experiment> {
  const latest: Record<string, Experiment> = {};
  for (const experiment of experiments) latest[experiment.experiment_id] = experiment;
  return latest;
}

/* ------------------------------------------------------------------ */
/* Capture bodies (viewer/data/captures/<hash>.json)                   */
/* ------------------------------------------------------------------ */

export type CapturePointer = { capture_id: string; sha256: string };

/**
 * Deterministic capture-body file id — hash({capture_id, source_sha256})
 * .slice(0, 40). The foundry names files with it at write time; the hub
 * RECOMPUTES it from the pointer instead of trusting any recorded or
 * client-supplied path.
 */
export function captureFileId(ref: CapturePointer): string {
  return createHash("sha256")
    .update(JSON.stringify({ capture_id: ref.capture_id, source_sha256: ref.sha256 }))
    .digest("hex")
    .slice(0, 40);
}

/** Benchmark-dir-relative capture body path (POSIX separators — recordable). */
export function captureBodyRelPath(ref: CapturePointer): string {
  return `viewer/data/captures/${captureFileId(ref)}.json`;
}

/** Absolute on-disk capture body path for a benchmark dir. */
export function captureBodyPath(benchmarkDir: string, ref: CapturePointer): string {
  return join(benchmarkDir, "viewer", "data", "captures", `${captureFileId(ref)}.json`);
}

/* ------------------------------------------------------------------ */
/* Recorded-path portability                                           */
/* ------------------------------------------------------------------ */

/**
 * The one resolver for paths RECORDED INSIDE artifacts: benchmark-dir-relative
 * with POSIX separators, so a benchmark directory can be relocated (or move
 * into ~/.understudy/) without baking machine-specific absolute paths in.
 * A target outside baseDir stays absolute (never record a lying "../..").
 */
export function toPortablePath(baseDir: string, target: string): string {
  const rel = relative(resolve(baseDir), resolve(target));
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return resolve(target);
  return rel.split(sep).join("/");
}

/**
 * Resolve a recorded path against the artifact's own directory. Legacy
 * tolerance: absolute paths (old artifacts baked them) pass through untouched.
 */
export function fromPortablePath(baseDir: string, recorded: string): string {
  if (isAbsolute(recorded)) return recorded;
  return resolve(baseDir, recorded.split("/").join(sep));
}

/* ------------------------------------------------------------------ */
/* Shared write helpers (owner-only modes everywhere)                  */
/* ------------------------------------------------------------------ */

/** Append rows to a JSONL file (creates parent dirs; no-op on empty input). */
export function appendJsonlRows(path: string, rows: unknown[]): void {
  if (rows.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
}
