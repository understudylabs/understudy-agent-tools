/**
 * Shared shapes for the benchmark hub (contract: schemas/*.schema.json at the
 * repo root). LIFTED from apps/benchmark-hub/lib/types.ts into the CLI
 * package so the compiled dist is the single source of truth — the Next app
 * re-imports this module from dist/ (anti-drift pattern), never forks it.
 */

export type TaskSplit = "train" | "dev" | "holdout" | "none";

/**
 * The production model that produced the source captures (additive; recorded
 * by the trace foundry from capture request metadata). `models` lists every
 * observed model when the capture set was multi-model, dominant first.
 */
export type IncumbentInfo = {
  model: string;
  provider?: string | null;
  observed_calls?: number;
  models?: { model: string; provider?: string | null; observed_calls?: number }[];
};

export type ManifestTask = {
  task_id: string;
  category_id: string;
  seed?: number | null;
  genesis: "replayed" | "synthesized" | "imported";
  generator_ref?: string | null;
  split: TaskSplit;
  gold?: { kind: "final-state" | "rubric" | "reference"; ref: string } | null;
  /** Per-task incumbent (additive; null/absent on pre-incumbent builds). */
  incumbent?: IncumbentInfo | null;
};

export type TaxonomyCategory = {
  category_id: string;
  name?: string | null;
  description?: string | null;
  difficulty?: "easy" | "medium" | "hard" | null;
  derived_from?: {
    tool_signature?: string[];
    intent_summary?: string | null;
    source_trace_ids?: string[];
  } | null;
};

export type BenchmarkManifest = {
  schema_version: "understudy.benchmark.v1";
  benchmark_id: string;
  name?: string | null;
  description?: string | null;
  created_at?: string | null;
  /** Benchmark-wide incumbent roll-up (additive; absent on pre-incumbent builds). */
  incumbent?: IncumbentInfo | null;
  provenance: {
    origin: "derived-from-traces" | "imported" | "authored";
    source_refs?: string[];
    imported_from?: {
      format: string;
      ref: string;
      version?: string | null;
      license?: string | null;
    } | null;
  };
  taxonomy: TaxonomyCategory[];
  tasks: ManifestTask[];
  environment: {
    format: string;
    package_ref: string;
    package_sha256?: string | null;
    tool_surface?: string[];
    runtime?: string | null;
    verifiers_version_pin?: string | null;
  };
  verifier: {
    kind: string;
    strict_metric: string;
    dense_metric?: string | null;
    replayable?: boolean | null;
  };
  splits?: {
    boundary?: string | null;
    splits_sha256?: string | null;
    contamination?: "clean" | "contaminated" | "unknown" | null;
  } | null;
  linked_eval?: { eval_id?: string | null; splits_sha256?: string | null } | null;
  results_contract?: {
    row_schema?: string;
    trace_artifact?: string | null;
    branch_projection?: string | null;
  } | null;
};

/** understudy.eval_result.v1 row (extension fields included). */
export type EvalRow = {
  schema_version: string;
  run_id: string;
  task_id: string;
  split?: TaskSplit | null;
  score?: number | null;
  subscores?: Record<string, number | null> | null;
  status: "ok" | "error" | "skipped" | "unscored";
  model?: string | null;
  /** Additive arm label from the executor: "incumbent" rerun, "candidate", or a trivial calibration arm ("null_agent" / "spam_agent"). */
  arm_kind?: "incumbent" | "candidate" | "null_agent" | "spam_agent" | null;
  route?: string | null;
  latency_ms?: number | null;
  created_at?: string | null;
  benchmark_id?: string;
  category_id?: string | null;
  trace_ref?: { branch_leaf?: string; branch_depth?: number } | null;
  /** Structural rollout sentinel that fired (executor-side). Anomalous rows are excluded from aggregates by default — marked, never dropped. */
  anomaly?: { kind: string; detail: string } | null;
  [key: string]: unknown;
};

export type FlagReason = "bad-gold" | "ambiguous" | "leakage" | "too-easy" | "broken-env" | "other";
export const FLAG_REASONS: FlagReason[] = ["bad-gold", "ambiguous", "leakage", "too-easy", "broken-env", "other"];

/** understudy.benchmark_flag.v1 — one line of flags.jsonl. */
export type BenchmarkFlag = {
  schema_version: "understudy.benchmark_flag.v1";
  benchmark_id: string;
  /** null flags the whole benchmark. */
  task_id: string | null;
  reason: FlagReason;
  note: string;
  created_at: string;
  status: "open" | "resolved";
};

/**
 * One line of an optional versions.jsonl next to benchmark.json (newest last).
 * Viewer-side convention for now — candidate for benchmark.v1.1.
 */
export type BenchmarkVersion = {
  created_at: string;
  splits_sha256: string | null;
  contamination: "clean" | "contaminated" | "unknown" | null;
  note?: string | null;
};

export type EvidenceWarning = {
  kind: "contamination" | "no-linked-eval" | "no-license" | "no-splits";
  label: string;
  detail: string;
};

/** Loader diagnostics per entry (rendered as a `//` footnote on the detail page). */
export type EntryDiagnostics = {
  /** JSONL lines that failed to parse (rows + flags + versions files). */
  skippedLines: number;
  /** Rows dropped for a wrong/missing eval_result schema_version. */
  droppedRows: number;
  /** Rows dropped because row.benchmark_id ≠ manifest.benchmark_id. */
  foreignRows: number;
  /** Flags dropped because flag.benchmark_id ≠ manifest.benchmark_id. */
  foreignFlags: number;
};

/** A directory whose benchmark.json failed validation — rendered, not hidden. */
export type InvalidHubEntry = {
  kind: "invalid";
  slug: string;
  source: "data-dir" | "demo" | "fixture";
  dir: string;
  manifestPath: string;
  /** Human-readable errors from validateBenchmarkManifest (or JSON parse). */
  errors: string[];
};

/* ---- Proposed stage (trace-foundry output dirs) ---- */

/**
 * Foundry task splits. Upstream uses construction/fit/heldout where promoted
 * benchmark.v1 manifests use train/dev/holdout; the split chip component
 * understands both enums until the naming is reconciled upstream.
 */
export type FoundrySplit = "construction" | "fit" | "heldout";

export type ReviewDecision = "accept" | "restrict" | "needs_more" | "reject";
export const REVIEW_DECISIONS: ReviewDecision[] = ["accept", "restrict", "needs_more", "reject"];

/** understudy.benchmark_review.v1 — one line of reviews.jsonl next to the foundry manifest. Newest line per task_id wins. */
export type BenchmarkReview = {
  schema_version: "understudy.benchmark_review.v1";
  /** Foundry output dir slug (directory basename), NOT a benchmark.v1 benchmark_id. */
  benchmark_id: string;
  task_id: string;
  decision: ReviewDecision;
  note: string;
  created_at: string;
  /** Additive: "auto" = hub auto-accept policy (user-triggered apply); absent/"human" = review bar. */
  source?: "auto" | "human";
};

/** understudy.trace_foundry.v1 manifest.json (subset the hub renders). */
export type FoundryManifest = {
  schema_version: "understudy.trace_foundry.v1";
  source?: string;
  freshness: { max_age_days: number; cutoff_utc: string; newest_capture_utc: string };
  counts: {
    source_files: number;
    captures: number;
    tasks: number;
    edges: number;
    stale_filtered: number;
    /** Compat: historical bucket name — the total of ALL non-normalizable captures, not just timestamp ones. */
    invalid_timestamp_filtered: number;
    /** Additive: honest total of captures normalize() dropped (all reasons). */
    not_normalizable_filtered?: number;
    /** Additive: accurate per-reason breakdown. */
    filtered_reasons?: { missing_timestamp: number; malformed_timestamp: number };
  };
  privacy?: {
    local_only?: boolean;
    contains_customer_payloads?: boolean;
    upload_performed?: boolean;
    provider_called?: boolean;
  } | null;
  [key: string]: unknown;
};

export type FoundryClaim = {
  kind: "observed" | "inferred";
  claim: string;
  confidence?: string | null;
  source_call_id?: string | null;
};

export type FoundryContractItem = {
  type?: string;
  tool?: string;
  observed_arguments?: unknown;
  matching?: string;
  confidence?: string;
  [key: string]: unknown;
};

export type CaptureRef = { capture_id: string; pointer: string; sha256: string };

export type SourceDagEdge = {
  from: string;
  to: string;
  type: "retry" | "prefix_append" | "branch" | "destructive_mutation";
  execution_group: string;
  confidence: string;
  evidence?: { common_prefix_messages?: number } | null;
};

export type SourceDagNode = {
  id: string;
  execution_group: string;
  captured_at: string;
  message_count: number;
  has_error?: boolean;
  source?: { pointer?: string; sha256?: string } | null;
};

export type SourceDag = {
  schema_version: string;
  nodes: SourceDagNode[];
  edges: SourceDagEdge[];
  groups: { id: string; capture_count: number; edge_count: number; roots: string[] }[];
};

/**
 * understudy.task_authoring.v1 — the LLM-authored, grounding-verified block
 * `understudy traces author-tasks` writes onto a foundry task. The authored
 * intent_summary wins as the task's display name everywhere; the
 * deterministic contract stays authoritative (grounding cross-validates).
 */
export type AuthoredContractEntry = {
  tool?: string;
  arguments_semantic?: Record<string, unknown>;
  maps_to_observed?: string[];
  reason?: string;
  [key: string]: unknown;
};

export type AuthoredBlock = {
  schema_version: string;
  model?: string;
  authored_at?: string;
  grounding?: { status?: "verified" | "failed"; violations?: string[] } | null;
  statement?: string;
  success_criteria?: string[];
  category_proposal?: { id?: string; name?: string } | null;
  difficulty?: string;
  difficulty_reason?: string;
  intent_summary?: string;
  contract?: {
    required?: AuthoredContractEntry[];
    preserved?: AuthoredContractEntry[];
    forbidden?: AuthoredContractEntry[];
  } | null;
  confidence?: string;
  ambiguities?: string[];
  [key: string]: unknown;
};

/** understudy.benchmark_task.v1 — one line of tasks.jsonl. */
export type FoundryTask = {
  schema_version: "understudy.benchmark_task.v1";
  task_id: string;
  execution_group: string;
  title: string;
  status: "machine_proposed" | "needs_review";
  split: FoundrySplit;
  candidate_boundary: string;
  machine_confidence: "high" | "medium" | "low";
  close_call: boolean;
  /** How the execution group formed: trace_grouped/valid | trace_grouped/split | heuristic_grouped | singleton. Absent on pre-trace-grouping builds. */
  grouping_label?: string;
  tool_surface: string[];
  outcome_contract: {
    status?: string;
    required: FoundryContractItem[];
    preserved: FoundryContractItem[];
    forbidden: FoundryContractItem[];
    grading: string;
  };
  world_model: {
    status?: string;
    initial_state?: Record<string, unknown>;
    transitions?: FoundryContractItem[];
  };
  source: { node_ids: string[]; edges: SourceDagEdge[]; captures: CaptureRef[] };
  claims: FoundryClaim[];
  sentinels: unknown[];
  review: { decision: string };
  /** LLM-authored legible definition (understudy.task_authoring.v1), when `traces author-tasks` has run. */
  authored?: AuthoredBlock | null;
  /** Generation-time structural self-check stamped by the foundry (absent on older builds). */
  self_check?: { ok: boolean; failures: { check: string; detail: string }[] } | null;
  [key: string]: unknown;
};

/** Display name: authored intent_summary wins over the raw distinctive-line title. */
export function taskDisplayName(task: Pick<FoundryTask, "task_id" | "title" | "authored">): string {
  const summary = task.authored?.intent_summary;
  if (typeof summary === "string" && summary.trim()) return summary.trim();
  return task.title || task.task_id;
}

/**
 * understudy.benchmark_overview.v1 — the `--overview` authoring pass output
 * (benchmark-overview.json next to the manifest): the three-level "how this
 * became a benchmark" narrative. Narrative fields are null when the model
 * reply was unparseable; representative ids are always deterministic.
 */
export type BenchmarkOverviewCategory = {
  category_id: string;
  archetype_title: string | null;
  archetype_description: string | null;
  representative_task_ids: string[];
  task_count?: number | null;
};

/** Canonical-hash system-prompt cluster (uuids/ids/emails/numbers masked). */
export type SystemPromptCluster = {
  hash: string;
  count: number;
  coverage: number;
  representative_excerpt: string;
};

export type ToolUsageRow = { tool: string; defined: boolean; calls: number };

/** Per-task complexity metrics — computed deterministically, never authored. */
export type TaskComplexity = {
  approx_context_tokens: number;
  turn_count: number;
  tool_call_count: number;
  distinct_tools: number;
  error_retry_events: number;
  frontier: boolean;
  frontier_axes: string[];
};

export type BenchmarkOverview = {
  schema_version: string;
  model?: string | null;
  authored_at?: string | null;
  workload_summary: string | null;
  categories: BenchmarkOverviewCategory[];
  /** Deterministic layer — computed from captures/tasks, no LLM. */
  system_prompt_clusters?: SystemPromptCluster[];
  tool_usage?: ToolUsageRow[];
  task_complexity?: Record<string, TaskComplexity>;
};

/** A trace-foundry output dir awaiting human review (stage: proposed). */
export type ProposedHubEntry = {
  kind: "proposed";
  slug: string;
  source: "data-dir" | "demo" | "fixture";
  readOnly: boolean;
  dir: string;
  /** manifest.json (understudy.trace_foundry.v1). */
  manifestPath: string;
  foundry: FoundryManifest;
  tasks: FoundryTask[];
  dag: SourceDag | null;
  /** Capture pointers only — bodies stay on disk until /api/captures fetches one. */
  captureIndex: CaptureRef[];
  /** Pre-promotion run rows (accepted tasks are runnable): rows-*.jsonl in the foundry dir. */
  rows: EvalRow[];
  /** All review lines, oldest first (append-only; newest per task wins). */
  reviews: BenchmarkReview[];
  /** Latest review per task_id. */
  latestReviewByTask: Record<string, BenchmarkReview>;
  diagnostics: EntryDiagnostics;
  /** task_ids where tasks.jsonl and the colliding benchmark.json disagree. */
  crossCheckErrors: string[];
  /** benchmark-overview.json (understudy.benchmark_overview.v1) when the --overview pass has run. */
  overview: BenchmarkOverview | null;
  /** understudy.calibration.v1 sidecar from a pre-promotion incumbent rerun, when present (additive). */
  calibration?: CalibrationSummary | null;
  /** understudy.review_policy.v1 in force (review-policy.json, defaults when absent — additive). */
  reviewPolicy?: ReviewPolicy;
};

export type AnyHubEntry = HubEntry | InvalidHubEntry | ProposedHubEntry;

/** One benchmark as discovered on disk. */
export type HubEntry = {
  kind: "ok";
  /** URL-safe unique key (directory or fixture derived, not benchmark_id). */
  slug: string;
  source: "data-dir" | "demo" | "fixture";
  readOnly: boolean;
  /** Absolute dir the manifest lives in (fixtures: the fixtures dir). */
  dir: string;
  manifestPath: string;
  manifest: BenchmarkManifest;
  rows: EvalRow[];
  traceFiles: string[];
  flags: BenchmarkFlag[];
  warnings: EvidenceWarning[];
  /** Split-freeze history from versions.jsonl (oldest first); [] if absent. */
  versions: BenchmarkVersion[];
  /** Loader diagnostics: skipped/dropped/foreign line counts. */
  diagnostics: EntryDiagnostics;
  /** understudy.promotion_record.v1 — present when this benchmark was promoted from a trace-foundry proposal in the same dir. */
  promotionRecord?: Record<string, unknown> | null;
  /** Review history carried over from the proposal stage (reviews.jsonl, oldest first). */
  reviews?: BenchmarkReview[];
  /** benchmark-overview.json carried over from the proposal stage, when present. */
  overview?: BenchmarkOverview | null;
  /** understudy.calibration.v1 sidecar from the latest incumbent rerun, when present. */
  calibration?: CalibrationSummary | null;
};

/**
 * understudy.calibration.v1 — calibration.json sidecar written by
 * `understudy runs execute` after a run with an incumbent arm finishes.
 * Tasks in failed_task_ids are rendered as suspect (incumbent_failed).
 */
export type CalibrationSummary = {
  schema_version: "understudy.calibration.v1";
  benchmark_id: string;
  run_id: string;
  incumbent_models: string[];
  threshold: number;
  started_at: string | null;
  finished_at: string | null;
  tasks: { task_id: string; score: number | null; passed: boolean; rollouts: number }[];
  passed_count: number;
  failed_count: number;
  failed_task_ids: string[];
  /** Additive: null-agent floor (absent when the run carried no null_agent arm). */
  null_floor?: TrivialFloor;
  /** Additive: spam-agent floor (absent when the run carried no spam_agent arm). */
  spam_floor?: TrivialFloor;
};

/**
 * Per-benchmark trivial-arm floor (mirrors run-executor's TrivialFloor): the
 * fraction of selected tasks a do-nothing (null) or ritual-tool-calling
 * (spam) agent passes at the calibration threshold. floor > the executor's
 * TRIVIAL_FLOOR_LIMIT stamps floor_exceeded — the benchmark's contracts are
 * trivially satisfiable and the passing tasks are suspect.
 */
export type TrivialFloor = {
  arm_kind: "null_agent" | "spam_agent";
  /** passed / selected tasks at the calibration threshold; null when the arm produced no rows. */
  floor: number | null;
  /** Every selected task the trivial arm passes — the offending tasks. */
  passed_task_ids: string[];
  floor_exceeded: boolean;
};

/** Machine-confidence enum, ordered high > medium > low. */
export type MachineConfidence = "high" | "medium" | "low";

/**
 * understudy.review_policy.v1 — optional review-policy.json sidecar next to
 * the foundry manifest. Configures the attention/auto-accept bar and the
 * default effective decision; absent file = the defaults (min_confidence
 * "high", require_incumbent_pass true, default_decision "accept").
 */
export type ReviewPolicy = {
  schema_version: "understudy.review_policy.v1";
  /** Lowest machine_confidence that can auto-accept (close_call still always excepts). */
  min_confidence: MachineConfidence;
  /** When false, an incumbent calibration failure no longer blocks auto-accept. */
  require_incumbent_pass: boolean;
  /**
   * Effective decision for a task with no reviews.jsonl line: "accept"
   * (default — tasks are born accepted, machine signals are attention flags)
   * or "pending" (the older explicit-accept flow).
   */
  default_decision: "accept" | "pending";
};
