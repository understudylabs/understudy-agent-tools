export type CorrectSupervisorAction = "continue" | "nudge" | "interrupt" | "stop";

export type ReviewJudgment = {
  helpful: boolean;
  correct_action?: CorrectSupervisorAction | null;
  justification?: string | null;
  created_at: string;
};

export type ReviewToolResult = {
  name: string;
  raw_args: string;
  parsed_ok: boolean;
  validation_error?: string | null;
  result: string;
  result_ok: boolean;
};

export type SupervisionReviewItem = {
  marker_id: string;
  legacy_marker: boolean;
  session_id: string;
  run_id: string;
  stage: "nudge" | "take_over";
  created_at: string;
  user_request: string;
  small_model: string;
  small_status: string;
  small_output: string;
  after_model: string;
  after_authorship: string;
  after_output: string;
  reason: string;
  reason_source: string;
  supervisor_raw?: string | null;
  boundary_ordinal?: number | null;
  decision_phase?: "streaming" | "final" | null;
  verdict_logprobs?: Record<string, number> | null;
  intervention_at?: number | null;
  tool_rounds_before_decision: number;
  tool_results: ReviewToolResult[];
  judgment?: ReviewJudgment | null;
};

export type SupervisionReviewQueue = {
  schema: "understudy.supervision.review_queue.v2";
  total: number;
  reviewed: number;
  pending: number;
  incomplete: number;
  truncated_interventions: number;
  invalid_journals: number;
  missing_journals: number;
  truncated_journals: number;
  items: SupervisionReviewItem[];
};

export type TiebreakerStatus = {
  enabled: boolean;
  gateway_ready: boolean;
  route_configured: boolean;
  provider?: "lilac" | "fireworks" | null;
  project?: string | null;
  workload?: string | null;
  model: "glm-5.2";
  disclosure: string;
};

export type TiebreakerAnalysis = {
  schema_version: "understudy.supervision.tiebreaker_analysis.v1";
  marker_id: string;
  evidence_sha256: string;
  analysis_sha256: string;
  model: string;
  provider: "lilac" | "fireworks";
  expected_served_model: string;
  served_model?: string | null;
  gateway_mode?: string | null;
  gateway_route?: string | null;
  effective_model?: string | null;
  route_project: string;
  route_workload: string;
  recommended_action?: "continue" | "nudge" | "interrupt" | "stop" | "unclear" | null;
  assessment?: "agree" | "disagree" | "unclear" | null;
  confidence?: number | null;
  reason?: string | null;
  reason_quality?: "grounded" | "partly_grounded" | "unsupported" | "missing" | "unclear" | null;
  status: "ok" | "error";
  error?: string | null;
  latency_ms: number;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  created_at: string;
  cache_hit: boolean;
  user_helpful?: boolean | null;
  remote_call_performed: boolean;
};

export type ReviewEvidenceGroup = {
  key: string;
  representative: SupervisionReviewItem;
  items: SupervisionReviewItem[];
  pending: SupervisionReviewItem[];
};

export type VerdictProbability = {
  verdict: string;
  probability: number;
};

const VERDICT_ORDER = ["interrupt", "nudge", "continue", "stop"];

export function verdictProbabilities(
  evidence?: Record<string, number> | null,
): VerdictProbability[] {
  const entries = Object.entries(evidence ?? {}).filter(
    (entry): entry is [string, number] => Number.isFinite(entry[1]),
  );
  if (!entries.length) return [];
  const alreadyProbabilities = entries.some(([, value]) => value > 0);
  const weighted = alreadyProbabilities
    ? entries.map(([verdict, value]) => ({ verdict, weight: Math.max(0, value) }))
    : (() => {
        const max = Math.max(...entries.map(([, value]) => value));
        return entries.map(([verdict, value]) => ({
          verdict,
          weight: Math.exp(value - max),
        }));
      })();
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  return weighted
    .map(({ verdict, weight }) => ({
      verdict,
      probability: total ? weight / total : 0,
    }))
    .sort((left, right) => {
      const leftIndex = VERDICT_ORDER.indexOf(left.verdict);
      const rightIndex = VERDICT_ORDER.indexOf(right.verdict);
      return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
    });
}

/** Stable visible-evidence identity. Capture ids and timing are intentionally excluded. */
export function reviewEvidenceKey(item: SupervisionReviewItem) {
  return JSON.stringify({
    stage: item.stage,
    user_request: item.user_request,
    small_model: item.small_model,
    small_output: item.small_output,
    after_model: item.after_model,
    after_authorship: item.after_authorship,
    after_output: item.after_output,
    reason: item.reason,
    reason_source: item.reason_source,
    tool_results: item.tool_results,
  });
}

export function reviewEvidenceGroups(items: SupervisionReviewItem[]): ReviewEvidenceGroup[] {
  const grouped = new Map<string, SupervisionReviewItem[]>();
  for (const item of items) {
    const key = reviewEvidenceKey(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return [...grouped.entries()].map(([key, members]) => {
    const pending = members.filter((item) => !item.judgment);
    return {
      key,
      representative: pending[0] ?? members[0],
      items: members,
      pending,
    };
  });
}
