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

export type AnyHubEntry = HubEntry | InvalidHubEntry;

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
