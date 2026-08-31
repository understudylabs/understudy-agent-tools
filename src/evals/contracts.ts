import { z } from "zod";

import { EVAL_SOURCE_ROW_SCHEMA_VERSION } from "./source-index.js";

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
}).strict();

export const WorkloadTraceWindowBindingSchema = z.object({
  schema_version: z.literal("understudy.trace-export-window.v1"),
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  workload_id: z.string().min(1),
  from: z.string().datetime(),
  to: z.string().datetime(),
}).strict();

export const WorkloadSourceRowSchema = z.object({
  schema_version: z.literal(EVAL_SOURCE_ROW_SCHEMA_VERSION),
  request_id: z.string().min(1),
  capture_key: z.string().min(1),
  captured_at: z.string().datetime(),
  size_bytes: z.number().int().nonnegative(),
  content_sha256: Sha256Schema,
  local_path: z.string().min(1),
}).strict();

export const EvalBuildIdentitySchema = z.object({
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  workload_id: z.string().min(1),
  workload_name: z.string().min(1),
});

export type CatalogItem = z.infer<typeof CatalogItemSchema>;
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;
export type Cohort = z.infer<typeof CohortSchema>;
export type CohortExport = z.infer<typeof CohortExportSchema>;
export type EvalBuildIdentity = z.infer<typeof EvalBuildIdentitySchema>;
export type WorkloadCaptureExportScope = z.infer<typeof WorkloadCaptureExportScopeSchema>;
export type WorkloadSourceRow = z.infer<typeof WorkloadSourceRowSchema>;
export type WorkloadTraceWindowBinding = z.infer<typeof WorkloadTraceWindowBindingSchema>;
