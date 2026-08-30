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

export const EvalBuildStateSchema = z.discriminatedUnion("status", [
  EvalBuildCreatingStateSchema,
  EvalBuildFrozenStateSchema,
]);

export type CatalogItem = z.infer<typeof CatalogItemSchema>;
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;
export type Cohort = z.infer<typeof CohortSchema>;
export type CohortExport = z.infer<typeof CohortExportSchema>;
export type EvalBuildState = z.infer<typeof EvalBuildStateSchema>;
export type EvalBuildCreatingState = z.infer<typeof EvalBuildCreatingStateSchema>;
export type EvalBuildIdentity = EvalBuildState["identity"];
export type EvalBuildSelection = EvalBuildState["selection"];
export type FrozenCohort = z.infer<typeof FrozenCohortSchema>;
