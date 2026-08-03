import { createHash } from "node:crypto";
import { z } from "zod";

export const METHOD_LADDER_INPUT_SCHEMA = "understudy.method_ladder.input.v2" as const;
export const METHOD_LADDER_RECOMMENDATION_SCHEMA = "understudy.method_ladder.recommendation.v2" as const;
export const OUTCOMES = ["target_met", "continue_gepa", "escalate_sft", "escalate_dpo", "escalate_grpo", "blocked"] as const;
export type Outcome = (typeof OUTCOMES)[number];

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Score = z.number().min(0).max(1);

const Binding = z.object({
  source_binding_sha256: Hash,
  verifier_sha256: Hash,
  benchmark_sha256: Hash,
  split_manifest_sha256: Hash,
}).strict();

const DevReceipt = Binding.extend({
  receipt_sha256: Hash,
  split: z.literal("dev"),
  aggregate_score: Score,
  family_scores: z.record(z.string().min(1), Score),
}).strict();

const BoundStatus = Binding.extend({
  receipt_sha256: Hash,
  status: z.enum(["pass", "fail"]),
}).strict();

const VerifierTrust = BoundStatus.extend({
  trusted: z.boolean(),
}).strict();

const Difficulty = Binding.extend({
  receipt_sha256: Hash,
  status: z.enum(["sufficient", "insufficient", "blocked"]),
  headroom_rows: z.number().int().nonnegative(),
  frontier_also_fails: z.boolean(),
}).strict();

const ProtectedFamily = z.object({
  family: z.string().min(1),
  target_score: Score,
  max_regression: z.number().min(0).max(1),
}).strict();

const Rung = z.object({
  available: z.boolean(),
  exhausted: z.boolean(),
  cost_usd: z.number().nonnegative(),
  expected_gain: z.number().min(0).max(1),
}).strict();

const Input = z.object({
  schema_version: z.literal(METHOD_LADDER_INPUT_SCHEMA),
  target_score: Score,
  baseline: DevReceipt,
  optimized: DevReceipt,
  expected_receipt_hashes: z.object({ baseline: Hash, optimized: Hash }).strict(),
  verifier_trust: VerifierTrust,
  difficulty: Difficulty,
  arm_evidence: BoundStatus,
  serving_parity: BoundStatus,
  protected_families: z.array(ProtectedFamily),
  budget: z.object({
    remaining_usd: z.number().nonnegative(),
    rungs: z.object({
      gepa: Rung,
      sft: Rung,
      dpo: Rung,
      grpo: Rung,
    }).strict(),
  }).strict(),
}).strict();

export type MethodLadderInput = z.infer<typeof Input>;
export type Recommendation = {
  schema_version: typeof METHOD_LADDER_RECOMMENDATION_SCHEMA;
  outcome: Outcome;
  rationale: string[];
  estimates_are_estimates: true;
  input_sha256: string;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function sameBinding(expected: z.infer<typeof Binding>, actual: z.infer<typeof Binding>): boolean {
  return expected.source_binding_sha256 === actual.source_binding_sha256
    && expected.verifier_sha256 === actual.verifier_sha256
    && expected.benchmark_sha256 === actual.benchmark_sha256
    && expected.split_manifest_sha256 === actual.split_manifest_sha256;
}

function bindingOf(value: z.infer<typeof Binding>): z.infer<typeof Binding> {
  return {
    source_binding_sha256: value.source_binding_sha256,
    verifier_sha256: value.verifier_sha256,
    benchmark_sha256: value.benchmark_sha256,
    split_manifest_sha256: value.split_manifest_sha256,
  };
}

export function recommendMethod(input: unknown): Recommendation {
  const parsed = Input.parse(input);
  const input_sha256 = sha256(parsed);
  const result = (outcome: Outcome, rationale: string[]): Recommendation => ({
    schema_version: METHOD_LADDER_RECOMMENDATION_SCHEMA,
    outcome,
    rationale,
    estimates_are_estimates: true,
    input_sha256,
  });
  const blocked = (reason: string): Recommendation => result("blocked", [reason]);

  if (parsed.baseline.receipt_sha256 !== parsed.expected_receipt_hashes.baseline
      || parsed.optimized.receipt_sha256 !== parsed.expected_receipt_hashes.optimized) {
    return blocked("receipt hash mismatch");
  }

  const expectedBinding = bindingOf(parsed.baseline);
  const boundEvidence = [parsed.optimized, parsed.verifier_trust, parsed.difficulty, parsed.arm_evidence, parsed.serving_parity];
  if (boundEvidence.some((evidence) => !sameBinding(expectedBinding, bindingOf(evidence)))) {
    return blocked("source, verifier, benchmark, or split binding mismatch");
  }
  if (!parsed.verifier_trust.trusted || parsed.verifier_trust.status !== "pass") {
    return blocked("verifier trust is not established");
  }
  if (parsed.difficulty.status !== "sufficient" || parsed.difficulty.headroom_rows === 0) {
    return blocked("difficulty calibration does not prove usable headroom");
  }
  if (parsed.difficulty.frontier_also_fails) {
    return blocked("frontier also fails the same dev rows; repair or re-scope the task");
  }
  if (parsed.arm_evidence.status !== "pass") return blocked("arm evidence gate did not pass");
  if (parsed.serving_parity.status !== "pass") return blocked("serving parity did not pass");
  if (parsed.optimized.aggregate_score < parsed.baseline.aggregate_score) {
    return blocked("optimized aggregate dev score regressed");
  }

  for (const gate of parsed.protected_families) {
    const baseline = parsed.baseline.family_scores[gate.family];
    const optimized = parsed.optimized.family_scores[gate.family];
    if (baseline === undefined || optimized === undefined) {
      return blocked(`protected family ${gate.family} is missing from a receipt`);
    }
    if (baseline - optimized > gate.max_regression) {
      return blocked(`protected family ${gate.family} regressed beyond its allowance`);
    }
  }

  const protectedTargetsMet = parsed.protected_families.every(
    (gate) => (parsed.optimized.family_scores[gate.family] ?? -1) >= gate.target_score,
  );
  if (parsed.optimized.aggregate_score >= parsed.target_score && protectedTargetsMet) {
    return result("target_met", ["optimized canonical dev target and protected-family gates are met"]);
  }

  const gap = Math.max(0, parsed.target_score - parsed.optimized.aggregate_score);
  const choices: Array<[Exclude<Outcome, "target_met" | "blocked">, keyof MethodLadderInput["budget"]["rungs"]]> = [
    ["continue_gepa", "gepa"],
    ["escalate_sft", "sft"],
    ["escalate_dpo", "dpo"],
    ["escalate_grpo", "grpo"],
  ];
  for (const [outcome, name] of choices) {
    const rung = parsed.budget.rungs[name];
    if (!rung.available || rung.exhausted) continue;
    if (rung.cost_usd > parsed.budget.remaining_usd) continue;
    if (rung.expected_gain < gap) continue;
    return result(outcome, [`${name} is the first available, unexhausted rung whose estimates fit the dev gap and budget`]);
  }

  return blocked("no available unexhausted rung has sufficient estimated gain within budget");
}
