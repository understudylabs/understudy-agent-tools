export type ComparisonProjectionCandidate = {
  candidate_id: string;
  label: string;
  run_id: string;
  rows: number;
  executed: number;
  ok_rows: number;
  error_rows: number;
  skipped_rows: number;
  terminal_rows: number;
  score_coverage: number;
  capture_coverage: number;
  avg_score: number | null;
  avg_latency_ms: number | null;
  avg_tokens: number | null;
  cost_usd: number | null;
  models: string[];
  task_mode_keys: string[];
  runtime_backends: string[];
};

export type MatchedComparisonProjection = {
  parent_run_id: string;
  newest_id: number;
  candidates: ComparisonProjectionCandidate[];
  matched_slice: boolean;
  harness_sha256: string | null;
  split_sha256: string | null;
  promotion_ready: boolean;
  blockers: string[];
  winner_id: string | null;
};

export function identifyCandidateRun(
  runId: string,
  candidates: Array<{ id: string }>,
): { candidate_id: string; parent_run_id: string } | null;

export function listMatchedComparisons(
  rows: Array<Record<string, unknown>>,
  candidates: Array<{ id: string; label: string }>,
): MatchedComparisonProjection[];

export function comparisonNextAction(
  comparison: MatchedComparisonProjection | null,
): { title: string; body: string };
