import { z } from "zod";

import {
  Sha256Schema,
  VerifiedWorkloadCaptureFileSchema,
  VerifyWorkloadCaptureExportReceiptResponseSchema,
  WorkloadCaptureExportScopeSchema,
} from "./contracts.js";

const TimestampSchema = z.string().datetime();
const RelativeArtifactPathSchema = z.string().min(1).refine(
  (value) => !value.startsWith("/") && !value.includes("\\") && !/^[A-Za-z]:[\\/]/.test(value) && !value.split("/").includes(".."),
  "artifact paths must be project-relative and cannot contain '..'",
);

export const EvalProjectArtifactsSchema = z.object({
  workload_profile: RelativeArtifactPathSchema,
  coverage: RelativeArtifactPathSchema,
  harness: RelativeArtifactPathSchema,
  environment: RelativeArtifactPathSchema,
  metric: RelativeArtifactPathSchema,
  splits: RelativeArtifactPathSchema,
  tasks: RelativeArtifactPathSchema,
  execution_index: RelativeArtifactPathSchema,
  analysis: RelativeArtifactPathSchema,
  verifier: RelativeArtifactPathSchema,
  approval: RelativeArtifactPathSchema,
  check_report: RelativeArtifactPathSchema,
}).strict();

export const WorkloadEvalProjectSchema = z.object({
  schema_version: z.literal("understudy.eval-project.v2"),
  eval_id: z.string().regex(/^eval_[a-f0-9]{24}$/),
  name: z.string().min(1).max(120),
  status: z.enum(["source_materialized", "authoring", "checked"]),
  created_at: TimestampSchema,
  identity: z.object({
    org_id: z.string().min(1),
    project_id: z.string().min(1),
    workload_id: z.string().min(1),
    workload_name: z.string().min(1),
  }).strict(),
  source: z.object({
    window: WorkloadCaptureExportScopeSchema.strict(),
    capture_count: z.number().int().nonnegative(),
    size_bytes: z.number().int().nonnegative(),
    index: RelativeArtifactPathSchema,
    index_sha256: Sha256Schema,
    export_proof: RelativeArtifactPathSchema,
    export_proof_sha256: Sha256Schema,
    exported_capture_count: z.number().int().nonnegative(),
    exported_total_bytes: z.number().int().nonnegative(),
    terminal_receipt_verified: z.literal(true),
  }).strict(),
  artifacts: EvalProjectArtifactsSchema,
  authoring: z.object({
    owner: z.literal("coding_agent"),
    semantic_preparation_performed: z.boolean(),
  }).strict(),
  privacy: z.object({
    local_only: z.literal(true),
    contains_customer_payloads: z.literal(true),
    upload_performed: z.literal(false),
    provider_called: z.literal(false),
  }).strict(),
}).strict();

export const EvalSourceRowSchema = VerifiedWorkloadCaptureFileSchema.strict();

export const EvalExportProofSchema = z.object({
  schema_version: z.literal("understudy.eval-export-proof.v1"),
  canonical_scope: WorkloadCaptureExportScopeSchema.strict(),
  segment_manifest_sha256: z.array(Sha256Schema).min(1),
  terminal_receipt: z.string().min(1),
  verified_receipt: VerifyWorkloadCaptureExportReceiptResponseSchema.extend({
    canonical_scope: WorkloadCaptureExportScopeSchema.strict(),
  }).strict(),
}).strict();

const EvalExecutionSourceFileSchema = z.object({
  local_path: RelativeArtifactPathSchema,
  content_sha256: Sha256Schema,
}).strict();

const EvalExecutionIndexBaseSchema = z.object({
  schema_version: z.literal("understudy.eval-execution-index-row.v1"),
  capture_count: z.number().int().positive(),
  source_files: z.array(EvalExecutionSourceFileSchema).min(1),
}).strict();

export const EvalExecutionIndexRowSchema = z.discriminatedUnion("source_status", [
  EvalExecutionIndexBaseSchema.extend({
    source_status: z.literal("included"),
    execution_group: z.string().min(1),
    lineage_status: z.enum(["complete", "ambiguous", "unlinked"]),
    task_id: z.string().min(1).nullable(),
    exclusion_reasons: z.array(z.string().min(1)),
  }).strict(),
  EvalExecutionIndexBaseSchema.extend({
    source_status: z.literal("excluded"),
    execution_group: z.null(),
    lineage_status: z.null(),
    task_id: z.null(),
    exclusion_reasons: z.array(z.string().min(1)).min(1),
  }).strict(),
]);

const CoverageEntrySchema = z.object({
  name: z.string().min(1),
  observed_count: z.number().int().nonnegative(),
  task_ids: z.array(z.string().min(1)),
  disposition: z.enum(["covered", "owner_accepted_uncovered"]),
  owner_note: z.string().min(1).optional(),
}).strict().superRefine((entry, context) => {
  if (entry.disposition === "covered" && entry.task_ids.length === 0) {
    context.addIssue({ code: "custom", message: "covered entries require at least one task id" });
  }
  if (entry.disposition === "owner_accepted_uncovered" && !entry.owner_note) {
    context.addIssue({ code: "custom", message: "owner-accepted uncovered entries require an owner note" });
  }
});

export const EvalCoverageSchema = z.object({
  schema_version: z.literal("understudy.eval-coverage.v1"),
  lineage: z.object({
    execution_index_sha256: Sha256Schema,
    counts: z.object({
      complete: z.number().int().nonnegative(),
      ambiguous: z.number().int().nonnegative(),
      unlinked: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  execution_modes: z.array(CoverageEntrySchema).min(1),
  failure_classes: z.array(CoverageEntrySchema),
}).strict().superRefine((coverage, context) => {
  for (const entries of [coverage.execution_modes, coverage.failure_classes]) {
    for (const entry of entries) {
      if (new Set(entry.task_ids).size !== entry.task_ids.length) context.addIssue({ code: "custom", message: `${entry.name} contains duplicate task ids` });
      if (entry.disposition === "owner_accepted_uncovered" && entry.task_ids.length > 0) context.addIssue({ code: "custom", message: `${entry.name} is uncovered and cannot list task ids` });
    }
  }
});

export const EvalMetricSchema = z.object({
  schema_version: z.literal("understudy.eval-metric.v1"),
  name: z.string().min(1),
  description: z.string().min(1),
  validator: z.object({
    kind: z.literal("local_verifier"),
    entrypoint: RelativeArtifactPathSchema,
  }).strict(),
  pass_threshold: z.number().min(0).max(1),
  failure_taxonomy: z.array(z.string().min(1)).min(1),
  approved: z.literal(true),
  approved_by: z.string().min(1),
  approved_at: TimestampSchema,
}).strict();

export const EvalHarnessSchema = z.object({
  schema_version: z.literal("understudy.eval-harness.v1"),
  format: z.literal("local_module.v1"),
  environment_entrypoint: RelativeArtifactPathSchema,
  verifier_entrypoint: RelativeArtifactPathSchema,
  timeout_ms: z.number().int().positive().max(60_000),
}).strict();

export const EvalEnvironmentSchema = z.object({
  schema_version: z.literal("understudy.eval-environment.v1"),
  kind: z.enum(["basic", "seeded_simulation"]),
  description: z.string().min(1),
  adapter: RelativeArtifactPathSchema,
  fixtures: RelativeArtifactPathSchema,
  provider_calls: z.literal(false),
}).strict();

export const EvalSplitsSchema = z.object({
  schema_version: z.literal("understudy.eval-splits.v1"),
  construction: z.array(z.string().min(1)),
  fit: z.array(z.string().min(1)),
  heldout: z.array(z.string().min(1)),
}).strict();

export const IndependentOutcomeEvidenceSchema = z.object({
  kind: z.enum(["owner_confirmation", "terminal_state_receipt", "workload_invariant"]),
  reference: z.string().min(1),
  statement: z.string().min(1),
}).strict();

const FixtureBaseSchema = z.object({
  task_id: z.string().min(1),
  input_provenance: z.string().min(1),
  candidate: RelativeArtifactPathSchema,
  state: RelativeArtifactPathSchema.optional(),
}).strict();

export const EvalCheckFixturesSchema = z.object({
  schema_version: z.literal("understudy.eval-check-fixtures.v1"),
  representative: FixtureBaseSchema.extend({ correctness_evidence: IndependentOutcomeEvidenceSchema }),
  known_good: FixtureBaseSchema.extend({ correctness_evidence: IndependentOutcomeEvidenceSchema }),
  intentionally_wrong: FixtureBaseSchema.extend({ incorrectness_evidence: IndependentOutcomeEvidenceSchema }),
}).strict();

const FinalApprovalHashesSchema = z.object({
  eval_set_sha256: Sha256Schema,
  coverage_sha256: Sha256Schema,
  environment_sha256: Sha256Schema,
  verifier_sha256: Sha256Schema,
  check_report_sha256: Sha256Schema,
}).strict();

export const EvalApprovalSchema = z.object({
  schema_version: z.literal("understudy.eval-approval.v1"),
  approver: z.string().min(1),
  intent_confirmed_at: TimestampSchema,
  workload_profile_sha256: Sha256Schema,
  metric_sha256: Sha256Schema,
  approved_at: TimestampSchema.optional(),
  eval_set_sha256: Sha256Schema.optional(),
  coverage_sha256: Sha256Schema.optional(),
  environment_sha256: Sha256Schema.optional(),
  verifier_sha256: Sha256Schema.optional(),
  check_report_sha256: Sha256Schema.optional(),
}).strict().superRefine((approval, context) => {
  const finalFields = [
    approval.eval_set_sha256,
    approval.coverage_sha256,
    approval.environment_sha256,
    approval.verifier_sha256,
    approval.check_report_sha256,
  ];
  const hasAnyFinal = approval.approved_at !== undefined || finalFields.some((value) => value !== undefined);
  const hasAllFinal = approval.approved_at !== undefined && finalFields.every((value) => value !== undefined);
  if (hasAnyFinal && !hasAllFinal) {
    context.addIssue({ code: "custom", message: "final approval requires approved_at and every checked artifact hash" });
  }
});

const CheckOutcomeSchema = z.object({
  task_id: z.string().min(1),
  input_provenance: z.string().min(1),
  evidence: IndependentOutcomeEvidenceSchema,
  candidate_sha256: Sha256Schema,
  state_sha256: Sha256Schema.nullable(),
  replay_sha256: Sha256Schema,
  result: z.enum(["passed", "rejected"]),
  feedback: z.string().min(1),
}).strict();

export const EvalCheckReportSchema = z.object({
  schema_version: z.literal("understudy.eval-check.v1"),
  checked_at: TimestampSchema,
  status: z.literal("passed"),
  task_count: z.number().int().positive(),
  representative_replay: CheckOutcomeSchema.extend({
    result: z.literal("passed"),
    provider_called: z.literal(false),
  }),
  oracle_fixture: CheckOutcomeSchema.extend({ result: z.literal("passed") }),
  wrong_fixture: CheckOutcomeSchema.extend({ result: z.literal("rejected") }),
  source: z.object({
    scope: WorkloadCaptureExportScopeSchema.strict(),
    scope_sha256: Sha256Schema,
    index_sha256: Sha256Schema,
    export_proof_sha256: Sha256Schema,
    capture_count: z.number().int().nonnegative(),
    size_bytes: z.number().int().nonnegative(),
  }).strict(),
  check_input_sha256: Sha256Schema,
  eval_set_sha256: Sha256Schema,
  coverage_sha256: Sha256Schema,
  environment_sha256: Sha256Schema,
  verifier_sha256: Sha256Schema,
}).strict();

export const FinalApprovalHashes = FinalApprovalHashesSchema;

export type WorkloadEvalProject = z.infer<typeof WorkloadEvalProjectSchema>;
export type EvalCoverage = z.infer<typeof EvalCoverageSchema>;
export type EvalMetric = z.infer<typeof EvalMetricSchema>;
export type EvalHarness = z.infer<typeof EvalHarnessSchema>;
export type EvalEnvironment = z.infer<typeof EvalEnvironmentSchema>;
export type EvalCheckFixtures = z.infer<typeof EvalCheckFixturesSchema>;
export type EvalApproval = z.infer<typeof EvalApprovalSchema>;
export type EvalCheckReport = z.infer<typeof EvalCheckReportSchema>;
export type EvalExportProof = z.infer<typeof EvalExportProofSchema>;
export type EvalExecutionIndexRow = z.infer<typeof EvalExecutionIndexRowSchema>;
