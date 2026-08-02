import { z } from "zod";

export const METHOD_LADDER_INPUT_SCHEMA = "understudy.method_ladder.input.v1";
export const METHOD_LADDER_RECOMMENDATION_SCHEMA = "understudy.method_ladder.recommendation.v1";

export const METHOD_LADDER_RUNGS = ["gepa", "sft", "dpo", "grpo"] as const;
export type MethodLadderRung = (typeof METHOD_LADDER_RUNGS)[number];

/**
 * Order-of-magnitude cost priors (USD, all-in: compute plus operator time) and
 * observed score-gain bands per rung. They are deliberately coarse: the policy
 * only needs them to order rungs and to decide whether a rung can plausibly
 * clear the remaining gap. Override per workload when you have local receipts.
 */
export const METHOD_LADDER_PRIORS: Readonly<
  Record<MethodLadderRung, { cost_usd: number; gain_min: number; gain_max: number }>
> = Object.freeze({
  gepa: Object.freeze({ cost_usd: 50, gain_min: 0, gain_max: 0.15 }),
  sft: Object.freeze({ cost_usd: 300, gain_min: 0.05, gain_max: 0.3 }),
  dpo: Object.freeze({ cost_usd: 600, gain_min: 0.02, gain_max: 0.1 }),
  grpo: Object.freeze({ cost_usd: 3000, gain_min: 0.05, gain_max: 0.25 }),
});

export const DEFAULT_QUALITY_TOLERANCE = 0.02;
export const DEFAULT_MINIMUM_HOLDOUT_ROWS = 100;
export const DEFAULT_MATERIAL_DELTA = 0.02;
export const DEFAULT_MAX_ATTEMPTS_PER_RUNG = 2;
export const DEFAULT_PAYBACK_HORIZON_MONTHS = 6;

const TaskKindSchema = z.enum([
  "classification",
  "extraction",
  "chat",
  "structured_generation",
  "tool_sequence",
  "agentic_multi_step",
]);

const FailureModeSchema = z.enum([
  "format_or_instruction",
  "selection_between_plausible",
  "knowledge_or_style",
  "sequence_control",
  "tool_choice",
  "unknown",
]);

const WorkloadSchema = z.object({
  name: z.string().min(1),
  task_kind: TaskKindSchema,
  failure_mode: FailureModeSchema,
  verifier: z.enum(["programmatic", "rubric_llm", "human_only", "none"]),
  environment: z.enum(["stateless", "stateful_simulated", "stateful_production"]),
  monthly_calls: z.number().nonnegative(),
  incumbent_cost_usd_per_month: z.number().nonnegative(),
  candidate_cost_usd_per_month: z.number().nonnegative(),
});

const AttemptSchema = z.object({
  rung: z.enum(METHOD_LADDER_RUNGS),
  score_after: z.number().min(0).max(1),
  spend_usd: z.number().nonnegative().default(0),
});

const EvidenceSchema = z.object({
  metric_name: z.string().min(1),
  sealed_holdout_rows: z.number().int().nonnegative(),
  incumbent_score: z.number().min(0).max(1),
  candidate_score: z.number().min(0).max(1),
  headroom_rows: z.number().int().nonnegative(),
  frontier_also_fails: z.boolean().default(false),
  labeled_examples: z.number().int().nonnegative().default(0),
  preference_pairs: z.number().int().nonnegative().default(0),
  rollout_harness_ready: z.boolean().default(false),
  attempts: z.array(AttemptSchema).default([]),
});

const ConstraintsSchema = z.object({
  max_spend_usd: z.number().nonnegative().optional(),
  gpu_available: z.boolean().default(false),
  quality_tolerance: z.number().min(0).max(1).default(DEFAULT_QUALITY_TOLERANCE),
  minimum_holdout_rows: z.number().int().positive().default(DEFAULT_MINIMUM_HOLDOUT_ROWS),
  payback_horizon_months: z.number().positive().default(DEFAULT_PAYBACK_HORIZON_MONTHS),
});

export const MethodLadderInputSchema = z.object({
  schema_version: z.literal(METHOD_LADDER_INPUT_SCHEMA),
  workload: WorkloadSchema,
  evidence: EvidenceSchema,
  constraints: ConstraintsSchema.default({
    gpu_available: false,
    quality_tolerance: DEFAULT_QUALITY_TOLERANCE,
    minimum_holdout_rows: DEFAULT_MINIMUM_HOLDOUT_ROWS,
    payback_horizon_months: DEFAULT_PAYBACK_HORIZON_MONTHS,
  }),
});

export type MethodLadderInput = z.infer<typeof MethodLadderInputSchema>;

export type MethodLadderBlocker = { requirement: string; observed: string; needed: string };

export type MethodLadderRecommendation = {
  schema_version: typeof METHOD_LADDER_RECOMMENDATION_SCHEMA;
  workload: string;
  decision: "collect_evidence" | "run_rung" | "blocked" | "promote" | "stop";
  recommended_rung: MethodLadderRung | null;
  remaining_gap: number;
  promotion_bar: {
    metric: string;
    minimum_score: number;
    minimum_delta_vs_incumbent: number;
    minimum_holdout_rows: number;
    maximum_cost_usd_per_month: number;
  };
  expected_gain: { min: number; max: number } | null;
  estimated_cost_usd: number | null;
  rationale: string[];
  blockers: MethodLadderBlocker[];
  skipped: { rung: MethodLadderRung; reason: string }[];
  cautions: string[];
  stop_rules: string[];
};

/** Minimum training-signal volume before a rung is worth attempting. */
function dataMinimum(rung: MethodLadderRung, taskKind: MethodLadderInput["workload"]["task_kind"]): number {
  if (rung === "gepa") return 60;
  if (rung === "sft") {
    if (taskKind === "classification") return 200;
    if (taskKind === "tool_sequence" || taskKind === "structured_generation") return 3000;
    return 1000;
  }
  if (rung === "dpo") return 500;
  return 0;
}

const RUNG_FAILURE_MODES: Readonly<Record<MethodLadderRung, ReadonlySet<string>>> = Object.freeze({
  gepa: new Set(["format_or_instruction", "tool_choice", "selection_between_plausible", "unknown"]),
  sft: new Set([
    "format_or_instruction",
    "knowledge_or_style",
    "tool_choice",
    "sequence_control",
    "selection_between_plausible",
    "unknown",
  ]),
  dpo: new Set(["selection_between_plausible", "knowledge_or_style"]),
  grpo: new Set(["sequence_control", "tool_choice", "unknown"]),
});

function attemptsFor(input: MethodLadderInput, rung: MethodLadderRung) {
  return input.evidence.attempts.filter((attempt) => attempt.rung === rung);
}

function exhausted(input: MethodLadderInput, rung: MethodLadderRung): string | null {
  const attempts = attemptsFor(input, rung);
  if (attempts.length === 0) return null;
  if (attempts.length >= DEFAULT_MAX_ATTEMPTS_PER_RUNG) {
    return `attempted ${attempts.length} times (cap ${DEFAULT_MAX_ATTEMPTS_PER_RUNG})`;
  }
  const best = Math.max(...attempts.map((attempt) => attempt.score_after));
  const gained = best - input.evidence.incumbent_score;
  if (attempts.length > 0 && gained < DEFAULT_MATERIAL_DELTA) {
    return `last attempt moved the metric by ${gained.toFixed(3)} (< ${DEFAULT_MATERIAL_DELTA} material delta)`;
  }
  return null;
}

/** Eligibility that no amount of extra data can fix, e.g. RL without a verifier. */
function ineligible(input: MethodLadderInput, rung: MethodLadderRung): string | null {
  const { workload } = input;
  if (!RUNG_FAILURE_MODES[rung].has(workload.failure_mode)) {
    return `does not address the observed failure mode ${workload.failure_mode}`;
  }
  if (rung === "gepa" && input.evidence.headroom_rows === 0) {
    return "no failing-but-promptable rows to optimize against";
  }
  if (rung === "grpo") {
    if (workload.verifier !== "programmatic") {
      return `needs a programmatic verifier, workload verifier is ${workload.verifier}`;
    }
    if (workload.environment === "stateful_production") {
      return "rollouts would run against production state; build a simulated environment first";
    }
  }
  return null;
}

/** Prerequisites the team can go and satisfy, reported as blockers. */
function blockersFor(input: MethodLadderInput, rung: MethodLadderRung): MethodLadderBlocker[] {
  const blockers: MethodLadderBlocker[] = [];
  const { evidence, workload, constraints } = input;
  const minimum = dataMinimum(rung, workload.task_kind);
  if (rung === "dpo") {
    if (evidence.preference_pairs < minimum) {
      blockers.push({
        requirement: "preference pairs",
        observed: String(evidence.preference_pairs),
        needed: `>= ${minimum} verifier-scored or human-corrected pairs`,
      });
    }
  } else if (minimum > 0 && evidence.labeled_examples < minimum) {
    blockers.push({
      requirement: "labeled examples",
      observed: String(evidence.labeled_examples),
      needed: `>= ${minimum} for ${workload.task_kind}`,
    });
  }
  if (rung === "grpo" && !evidence.rollout_harness_ready) {
    blockers.push({
      requirement: "rollout environment",
      observed: "not ready",
      needed: "a stateful simulated environment with programmatic reward",
    });
  }
  if (rung === "grpo" && !constraints.gpu_available) {
    blockers.push({
      requirement: "training compute",
      observed: "no GPU declared",
      needed: "GPU capacity or a hosted RL backend",
    });
  }
  const cost = METHOD_LADDER_PRIORS[rung].cost_usd;
  if (constraints.max_spend_usd !== undefined && cost > constraints.max_spend_usd) {
    blockers.push({
      requirement: "spend budget",
      observed: `$${constraints.max_spend_usd}`,
      needed: `~$${cost} for ${rung}`,
    });
  }
  return blockers;
}

function cautionsFor(input: MethodLadderInput, rung: MethodLadderRung | null): string[] {
  const cautions: string[] = [];
  const { workload, evidence } = input;
  if (rung === "sft" && (workload.task_kind === "tool_sequence" || workload.task_kind === "structured_generation")) {
    cautions.push(
      "Variable-length structured or tool-call generation trained by SFT on a small base tends to learn item identity but not sequence-length control (repetition loops). Gate on full-sequence outcome correctness, not per-item accuracy, and prefer a larger base, more data, or explicit length/structure constraints.",
    );
  }
  if (workload.verifier === "human_only") {
    cautions.push("Human-only grading caps iteration speed; add a programmatic or rubric proxy before climbing past SFT.");
  }
  if (evidence.sealed_holdout_rows < 300) {
    cautions.push(
      `Sealed holdout is ${evidence.sealed_holdout_rows} rows; report the confidence interval and avoid single-point promotion claims.`,
    );
  }
  return cautions;
}

function stopRules(input: MethodLadderInput, bar: MethodLadderRecommendation["promotion_bar"]): string[] {
  return [
    `Stop and promote as soon as the sealed holdout shows >= ${bar.minimum_score.toFixed(3)} ${bar.metric} over >= ${bar.minimum_holdout_rows} rows at <= $${bar.maximum_cost_usd_per_month}/month.`,
    `Stop climbing a rung after ${DEFAULT_MAX_ATTEMPTS_PER_RUNG} attempts or when an attempt moves the metric by < ${DEFAULT_MATERIAL_DELTA}.`,
    `Stop the whole ladder when the next rung's cost cannot pay back inside ${input.constraints.payback_horizon_months} months of measured savings.`,
    "Stop and re-scope the task if a frontier model fails the same rows: the gap is task definition, not model capacity.",
    "Stop and re-collect evidence if the holdout is touched, the metric changes, or the split contract is regenerated mid-climb.",
  ];
}

export function methodLadderPromotionBar(input: MethodLadderInput): MethodLadderRecommendation["promotion_bar"] {
  const { evidence, workload, constraints } = input;
  const minimumScore = Math.max(0, evidence.incumbent_score - constraints.quality_tolerance);
  return {
    metric: evidence.metric_name,
    minimum_score: minimumScore,
    minimum_delta_vs_incumbent: -constraints.quality_tolerance,
    minimum_holdout_rows: constraints.minimum_holdout_rows,
    maximum_cost_usd_per_month: Math.min(
      workload.incumbent_cost_usd_per_month,
      Math.max(workload.candidate_cost_usd_per_month, workload.incumbent_cost_usd_per_month * 0.5),
    ),
  };
}

/**
 * Recommend the cheapest ladder rung that could clear a predeclared promotion
 * bar given the workload's characteristics and the evidence collected so far.
 */
export function recommendNextRung(rawInput: unknown): MethodLadderRecommendation {
  const input = MethodLadderInputSchema.parse(rawInput);
  const { evidence, workload, constraints } = input;
  const bar = methodLadderPromotionBar(input);
  const gap = Math.max(0, bar.minimum_score - evidence.candidate_score);
  const base: MethodLadderRecommendation = {
    schema_version: METHOD_LADDER_RECOMMENDATION_SCHEMA,
    workload: workload.name,
    decision: "stop",
    recommended_rung: null,
    remaining_gap: Number(gap.toFixed(4)),
    promotion_bar: bar,
    expected_gain: null,
    estimated_cost_usd: null,
    rationale: [],
    blockers: [],
    skipped: [],
    cautions: cautionsFor(input, null),
    stop_rules: stopRules(input, bar),
  };

  if (workload.verifier === "none" || evidence.sealed_holdout_rows < constraints.minimum_holdout_rows) {
    return {
      ...base,
      decision: "collect_evidence",
      rationale: [
        `No rung is decidable yet: verifier is ${workload.verifier} and the sealed holdout has ${evidence.sealed_holdout_rows} rows (need >= ${constraints.minimum_holdout_rows}).`,
        "Collect a sealed holdout and a scorer before spending on optimization or training.",
      ],
      blockers: [
        {
          requirement: "sealed holdout",
          observed: `${evidence.sealed_holdout_rows} rows, verifier ${workload.verifier}`,
          needed: `>= ${constraints.minimum_holdout_rows} rows with a programmatic or rubric verifier`,
        },
      ],
    };
  }

  if (gap === 0) {
    return {
      ...base,
      decision: "promote",
      rationale: [
        `Candidate scores ${evidence.candidate_score.toFixed(3)} against a bar of ${bar.minimum_score.toFixed(3)}; the cheapest rung that clears the bar is the one already run.`,
        "Promote behind a ramp with live monitoring instead of climbing further.",
      ],
    };
  }

  if (evidence.frontier_also_fails) {
    return {
      ...base,
      decision: "stop",
      rationale: [
        "A frontier model fails the same rows, so the gap is task definition or data quality, not model capacity.",
        "Re-scope the task, repair the metric, or fix upstream data before climbing the ladder.",
      ],
    };
  }

  const monthlySavings = Math.max(0, workload.incumbent_cost_usd_per_month - workload.candidate_cost_usd_per_month);
  const paybackBudget = monthlySavings * constraints.payback_horizon_months;

  const skipped: { rung: MethodLadderRung; reason: string }[] = [];
  for (const rung of METHOD_LADDER_RUNGS) {
    const exhaustedReason = exhausted(input, rung);
    if (exhaustedReason) {
      skipped.push({ rung, reason: exhaustedReason });
      continue;
    }
    const ineligibleReason = ineligible(input, rung);
    if (ineligibleReason) {
      skipped.push({ rung, reason: ineligibleReason });
      continue;
    }
    const prior = METHOD_LADDER_PRIORS[rung];
    if (prior.cost_usd > paybackBudget) {
      skipped.push({
        rung,
        reason: `~$${prior.cost_usd} cannot pay back inside ${constraints.payback_horizon_months} months of $${monthlySavings}/month savings`,
      });
      continue;
    }
    const blockers = blockersFor(input, rung);
    const rationale = [
      `${rung.toUpperCase()} is the cheapest remaining rung that addresses ${workload.failure_mode} (~$${prior.cost_usd}, historical gain ${prior.gain_min}-${prior.gain_max}).`,
      `Remaining gap to the bar is ${gap.toFixed(3)} ${evidence.metric_name}.`,
    ];
    const cautions = cautionsFor(input, rung);
    if (gap > prior.gain_max) {
      cautions.push(
        `A single ${rung.toUpperCase()} pass is unlikely to close a ${gap.toFixed(3)} gap; plan to stack rungs or revisit the task scope rather than skipping ahead.`,
      );
    }
    return {
      ...base,
      decision: blockers.length > 0 ? "blocked" : "run_rung",
      recommended_rung: rung,
      expected_gain: { min: prior.gain_min, max: prior.gain_max },
      estimated_cost_usd: prior.cost_usd,
      rationale:
        blockers.length > 0
          ? [...rationale, "Satisfy the listed prerequisites before spending on this rung."]
          : rationale,
      blockers,
      skipped,
      cautions,
    };
  }

  return {
    ...base,
    decision: "stop",
    rationale: [
      "Every rung is exhausted, ineligible for the observed failure mode, or unable to pay back inside the horizon.",
      "Keep the incumbent route, bank the evidence, and revisit when volume, data, or model options change.",
    ],
    skipped,
  };
}
