import { z } from "zod";

/**
 * Training/evidence promotion is intentionally separate from
 * src/serving-registry.ts. That module describes serving placement; this
 * registry stores training lineage and promotion proof and only references
 * serving adapter names as strings.
 */
export const ADAPTER_PORTFOLIO_REGISTRY_SCHEMA =
  "understudy.adapter_portfolio_registry.v1" as const;
export const ADAPTER_PROMOTION_DECISION_SCHEMA =
  "understudy.adapter_promotion_decision.v1" as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const TimestampSchema = z.string().datetime({ offset: true });

export const AdapterMethodSchema = z.enum(["sft-lora", "rlvr-grpo", "prompt", "other"]);
export const AdapterStatusSchema = z.enum(["draft", "candidate", "promoted", "retired"]);
export const SplitSchema = z.enum(["dev", "holdout"]);

export const HoldoutSchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
  row_count: z.number().int().positive(),
});

export const EvidenceRowSchema = z.object({
  evidence_id: z.string().min(1),
  recorded_at: TimestampSchema,
  subject: z.enum(["base", "adapter"]),
  adapter_name: z.string().min(1).optional(),
  suite: z.string().min(1),
  split: SplitSchema,
  dataset_sha256: Sha256Schema,
  row_count: z.number().int().positive(),
  metric: z.string().min(1),
  score: z.number().finite(),
  seed: z.number().int().optional(),
  run_id: z.string().min(1).optional(),
  fixture_sha256: Sha256Schema.optional(),
  context: z.object({ loaded_adapters: z.array(z.string().min(1)) }),
  notes: z.string().optional(),
}).superRefine((row, ctx) => {
  if (row.subject === "adapter" && !row.adapter_name) {
    ctx.addIssue({ code: "custom", path: ["adapter_name"], message: "adapter_name is required for adapter evidence" });
  }
  if (row.subject === "base" && row.adapter_name) {
    ctx.addIssue({ code: "custom", path: ["adapter_name"], message: "base evidence cannot name an adapter" });
  }
});

export const AdapterRecordSchema = z.object({
  name: z.string().min(1),
  adapter_path: z.string().min(1),
  base_model: z.string().min(1),
  method: AdapterMethodSchema,
  status: AdapterStatusSchema,
  suite: z.string().min(1),
  holdout: HoldoutSchema.nullable(),
  evidence: z.array(EvidenceRowSchema),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});

export const PromotionPolicySchema = z.object({
  metric: z.string().min(1),
  min_dev_score: z.number().finite().optional(),
  min_holdout_score: z.number().finite().optional(),
  min_lift_vs_base: z.number().finite().default(0),
  max_regression: z.number().finite().nonnegative().default(0),
});

export const AdapterPortfolioRegistrySchema = z.object({
  schema_version: z.literal(ADAPTER_PORTFOLIO_REGISTRY_SCHEMA),
  base_models: z.record(z.string(), z.string()).optional(),
  policy: PromotionPolicySchema,
  adapters: z.record(z.string().min(1), AdapterRecordSchema),
});

export const PromotionCheckSchema = z.object({
  check: z.enum(["status", "dev_pass", "holdout_pass", "holdout_sealed", "no_forgetting"]),
  status: z.enum(["pass", "fail", "missing_evidence"]),
  detail: z.string().min(1),
});

export const AdapterPromotionDecisionSchema = z.object({
  schema_version: z.literal(ADAPTER_PROMOTION_DECISION_SCHEMA),
  candidate: z.string().min(1),
  evaluated_at: TimestampSchema,
  policy: PromotionPolicySchema,
  checks: z.array(PromotionCheckSchema),
  decision: z.enum(["promote", "blocked"]),
});

export type AdapterMethod = z.infer<typeof AdapterMethodSchema>;
export type AdapterStatus = z.infer<typeof AdapterStatusSchema>;
export type EvidenceRow = z.infer<typeof EvidenceRowSchema>;
export type Holdout = z.infer<typeof HoldoutSchema>;
export type AdapterRecord = z.infer<typeof AdapterRecordSchema>;
export type PromotionPolicy = z.infer<typeof PromotionPolicySchema>;
export type AdapterPortfolioRegistry = z.infer<typeof AdapterPortfolioRegistrySchema>;
export type PromotionCheck = z.infer<typeof PromotionCheckSchema>;
export type AdapterPromotionDecision = z.infer<typeof AdapterPromotionDecisionSchema>;
