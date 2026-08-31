import { z } from "zod";

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const CatalogSelectionSchema = z.object({
  from: z.string(),
  to: z.string(),
  limit: z.number().int().positive(),
  sample_seed: z.string(),
  requested_model: z.string().nullable(),
  served_model: z.string().nullable(),
  status_code: z.number().int().nullable(),
  requires_tools: z.boolean(),
  requires_structured_output: z.boolean(),
});

export const CohortSelectionSchema = z.object({
  source: z.literal("explicit_capture_references"),
  description: z.string().min(1).max(1000).optional(),
  sampling_seed: z.string().min(1).max(200).optional(),
});

export const CatalogItemSchema = z.object({
  capture_key: z.string(),
  request_id: z.string(),
  content_sha256: Sha256Schema,
  captured_at: z.string(),
  provider: z.string(),
  requested_model: z.string(),
  served_model: z.string(),
  status_code: z.number().int(),
  latency_ms: z.number().nonnegative(),
  has_tools: z.boolean(),
  has_structured_output: z.boolean(),
});

export const CatalogResponseSchema = z.object({
  captures: z.array(CatalogItemSchema),
  selection: CatalogSelectionSchema,
});

export const CohortSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  project_id: z.string(),
  workload_id: z.string(),
  name: z.string().min(1).max(120),
  operation_id: z.string().uuid().nullable().optional(),
  selection: CohortSelectionSchema,
  capture_count: z.number().int().positive(),
  cohort_sha256: Sha256Schema,
  created_at: z.string(),
}).passthrough();

export const CohortExportSchema = z.object({
  export_id: z.string(),
  cohort_id: z.string(),
  cohort_sha256: Sha256Schema,
  expires_at: z.string().datetime(),
  captures: z.array(z.object({
    request_id: z.string(),
    content_sha256: Sha256Schema,
    url: z.string().url(),
  })).min(1).max(500),
});

export const WorkloadCaptureExportScopeSchema = z.object({
  schema_version: z.literal("understudy.export-scope.v1"),
  selector: z.literal("workload-window"),
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  workload_id: z.string().min(1),
  from: z.string().datetime(),
  to: z.string().datetime(),
  ingestion_cutoff: z.string().datetime(),
});

export const WorkloadCaptureExportManifestItemSchema = z.object({
  request_id: z.string().min(1),
  key: z.string().min(1),
  size: z.number().int().nonnegative(),
  url: z.string().url(),
});

export const WorkloadCaptureExportManifestHeaderSchema = z.object({
  record_type: z.literal("understudy_capture_export_chain_v1"),
  chain_id: z.string().min(1),
  segment_id: Sha256Schema,
  segment_index: z.number().int().nonnegative(),
  previous_manifest_sha256: Sha256Schema.nullable(),
  cumulative_scanned: z.number().int().nonnegative(),
  cumulative_matched: z.number().int().nonnegative(),
  cumulative_exported: z.number().int().nonnegative(),
  cumulative_total_bytes: z.number().int().nonnegative(),
  terminal: z.boolean(),
});

export const WorkloadCaptureExportResponseSchema = z.object({
  export_id: z.string().min(1),
  count: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  manifest_url: z.string().url(),
  expires_at: z.string().datetime(),
  truncated: z.boolean(),
  resume_cursor: z.string().min(1).optional(),
  canonical_scope: WorkloadCaptureExportScopeSchema,
  chain: z.object({
    chain_id: z.string().min(1),
    segment_id: Sha256Schema,
    segment_index: z.number().int().nonnegative(),
    previous_manifest_sha256: Sha256Schema.nullable(),
    manifest_sha256: Sha256Schema,
    cumulative_scanned: z.number().int().nonnegative(),
    cumulative_matched: z.number().int().nonnegative(),
    cumulative_exported: z.number().int().nonnegative(),
    cumulative_total_bytes: z.number().int().nonnegative(),
    terminal: z.boolean(),
    terminal_receipt: z.string().min(1).optional(),
  }),
});

export const VerifyWorkloadCaptureExportReceiptResponseSchema = z.object({
  verified: z.literal(true),
  scope_hash: Sha256Schema,
  chain_id: z.string().min(1),
  segment_id: Sha256Schema,
  segment_index: z.number().int().nonnegative(),
  manifest_sha256: Sha256Schema,
  previous_manifest_sha256: Sha256Schema.nullable(),
  cumulative_scanned: z.number().int().nonnegative(),
  cumulative_matched: z.number().int().nonnegative(),
  cumulative_exported: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  expires_at: z.string().datetime(),
  canonical_scope: WorkloadCaptureExportScopeSchema,
});

export const VerifiedWorkloadCaptureFileSchema = z.object({
  schema_version: z.literal("understudy.eval-source-capture.v1"),
  request_id: z.string().min(1),
  capture_key: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  content_sha256: Sha256Schema,
  local_path: z.string().min(1),
});

export const EvalBuildStateBaseSchema = z.object({
  schema_version: z.literal("understudy.eval-build-state.v1"),
  created_at: z.string().datetime(),
  name: z.string().min(1).max(120),
  identity: z.object({
    org_id: z.string(),
    project_id: z.string(),
    workload_id: z.string(),
    workload_name: z.string(),
  }),
  compile: z.object({
    max_age_days: z.number().int().positive(),
    batch_size: z.number().int().positive(),
  }),
  selection: z.object({
    last: z.string(),
    limit: z.number().int().min(1).max(100),
    seed: z.string(),
    description: z.string().min(1).max(1000).nullable(),
    requested_model: z.string().nullable(),
    served_model: z.string().nullable(),
    status_code: z.number().int().min(100).max(599).nullable(),
    requires_tools: z.boolean(),
    requires_structured_output: z.boolean(),
  }),
});

export const FrozenCohortSchema = z.object({
  id: z.string(),
  cohort_sha256: Sha256Schema,
  capture_count: z.number().int().positive(),
});

export const EvalBuildCreatingStateSchema = EvalBuildStateBaseSchema.extend({
  status: z.literal("cohort_creating"),
  create_request: z.object({
    operation_id: z.string().uuid(),
    name: z.string().min(1).max(120),
    selection: CohortSelectionSchema,
    captures: z.array(z.object({
      capture_key: z.string(),
      request_id: z.string(),
      content_sha256: Sha256Schema,
    })).min(1).max(500),
  }),
});

export const EvalBuildFrozenStateSchema = EvalBuildStateBaseSchema.extend({
  status: z.enum(["cohort_frozen", "complete"]),
  cohort: FrozenCohortSchema,
});

export const EvalLegacyBuildStateSchema = z.discriminatedUnion("status", [
  EvalBuildCreatingStateSchema,
  EvalBuildFrozenStateSchema,
]);

export const EvalWorkloadBuildStateSchema = z.object({
  schema_version: z.literal("understudy.eval-build-state.v2"),
  status: z.enum(["downloading", "receipt_pending", "complete"]),
  created_at: z.string().datetime(),
  name: z.string().min(1).max(120),
  identity: z.object({
    org_id: z.string().min(1),
    project_id: z.string().min(1),
    workload_id: z.string().min(1),
    workload_name: z.string().min(1),
  }),
  source: z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    ingestion_cutoff: z.string().datetime(),
  }),
  compile: z.object({
    max_age_days: z.number().int().positive(),
    batch_size: z.number().int().positive(),
  }),
  transport: z.object({
    resume_cursor: z.string().min(1).nullable(),
    chain_id: z.string().min(1).nullable(),
    next_segment_index: z.number().int().nonnegative(),
    previous_manifest_sha256: Sha256Schema.nullable(),
    segment_manifest_sha256: z.array(Sha256Schema),
    cumulative_exported: z.number().int().nonnegative(),
    cumulative_total_bytes: z.number().int().nonnegative(),
    terminal_receipt: z.string().min(1).nullable(),
    verified_files: z.array(VerifiedWorkloadCaptureFileSchema),
  }),
});

export const EvalBuildStateSchema = z.union([
  EvalLegacyBuildStateSchema,
  EvalWorkloadBuildStateSchema,
]);

export type CatalogItem = z.infer<typeof CatalogItemSchema>;
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;
export type Cohort = z.infer<typeof CohortSchema>;
export type CohortExport = z.infer<typeof CohortExportSchema>;
export type EvalBuildState = z.infer<typeof EvalBuildStateSchema>;
export type EvalLegacyBuildState = z.infer<typeof EvalLegacyBuildStateSchema>;
export type EvalBuildCreatingState = z.infer<typeof EvalBuildCreatingStateSchema>;
export type EvalBuildIdentity = z.infer<typeof EvalBuildStateBaseSchema>["identity"];
export type EvalBuildSelection = z.infer<typeof EvalBuildStateBaseSchema>["selection"];
export type FrozenCohort = z.infer<typeof FrozenCohortSchema>;
export type WorkloadCaptureExportScope = z.infer<typeof WorkloadCaptureExportScopeSchema>;
export type WorkloadCaptureExportManifestItem = z.infer<typeof WorkloadCaptureExportManifestItemSchema>;
export type WorkloadCaptureExportManifestHeader = z.infer<typeof WorkloadCaptureExportManifestHeaderSchema>;
export type WorkloadCaptureExportResponse = z.infer<typeof WorkloadCaptureExportResponseSchema>;
export type VerifyWorkloadCaptureExportReceiptResponse = z.infer<typeof VerifyWorkloadCaptureExportReceiptResponseSchema>;
export type VerifiedWorkloadCaptureFile = z.infer<typeof VerifiedWorkloadCaptureFileSchema>;
export type EvalWorkloadBuildState = z.infer<typeof EvalWorkloadBuildStateSchema>;
