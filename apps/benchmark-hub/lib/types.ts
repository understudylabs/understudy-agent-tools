/** Shared shapes for the benchmark hub viewer (contract: schemas/*.schema.json at repo root). */

export type TaskSplit = "train" | "dev" | "holdout" | "none";

export type ManifestTask = {
  task_id: string;
  category_id: string;
  seed?: number | null;
  genesis: "replayed" | "synthesized" | "imported";
  generator_ref?: string | null;
  split: TaskSplit;
  gold?: { kind: "final-state" | "rubric" | "reference"; ref: string } | null;
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
  route?: string | null;
  latency_ms?: number | null;
  created_at?: string | null;
  benchmark_id?: string;
  category_id?: string | null;
  trace_ref?: { branch_leaf?: string; branch_depth?: number } | null;
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
    invalid_timestamp_filtered: number;
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
  [key: string]: unknown;
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
  /** All review lines, oldest first (append-only; newest per task wins). */
  reviews: BenchmarkReview[];
  /** Latest review per task_id. */
  latestReviewByTask: Record<string, BenchmarkReview>;
  diagnostics: EntryDiagnostics;
  /** task_ids where tasks.jsonl and the colliding benchmark.json disagree. */
  crossCheckErrors: string[];
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
};
