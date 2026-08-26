import { z } from "zod";

// Customer-safe response contracts mirrored from the hosted admin API schemas.
// The public CLI validates this wire boundary locally so it can remain a
// standalone package.

export const ReportingWindowSchema = z.enum(["24h", "7d", "30d", "custom"]);
export const ReportingGranularitySchema = z.enum(["minute", "hour", "day"]);
export const ReportingGroupBySchema = z.enum(["project", "workload", "model"]);
export const UsageGroupBySchema = z.enum(["workload", "model", "day"]);

export const ReportingTotalsSchema = z.object({
  requests: z.number().int(),
  input_tokens: z.number().int(),
  cache_read_input_tokens: z.number().int(),
  cache_creation_input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  total_tokens: z.number().int(),
  customer_cost_usd: z.number(),
}).passthrough();

export const OrganizationReportingResponseSchema = z.object({
  org_id: z.string(),
  window: ReportingWindowSchema,
  window_start: z.string(),
  window_end: z.string(),
  granularity: ReportingGranularitySchema,
  group_by: ReportingGroupBySchema,
  filters: z.object({
    project_id: z.string().nullable(),
    workload_id: z.string().nullable(),
    exclude_project_ids: z.array(z.string()),
  }).passthrough(),
  totals: ReportingTotalsSchema,
  series: z.array(ReportingTotalsSchema.extend({
    bucket: z.string(),
    project_id: z.string().nullable(),
    project: z.string().nullable(),
    workload_id: z.string().nullable(),
    workload: z.string().nullable(),
    model: z.string().nullable(),
  }).passthrough()),
  generated_at: z.string(),
}).passthrough();
export type OrganizationReportingResponse = z.infer<
  typeof OrganizationReportingResponseSchema
>;

export const UsageSummaryResponseSchema = z.object({
  project_id: z.string(),
  window: z.string(),
  window_start: z.string(),
  window_end: z.string(),
  group_by: z.array(UsageGroupBySchema),
  groups: z.array(z.object({
    workload_id: z.string().nullable(),
    workload: z.string().nullable(),
    model: z.string().nullable(),
    day: z.string().nullable(),
    requests: z.number().int(),
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    cache_read_input_tokens: z.number().int(),
    cache_creation_input_tokens: z.number().int(),
    cache_read_pct: z.number(),
    customer_cost_usd: z.number(),
    error_rate: z.number(),
  }).passthrough()),
  generated_at: z.string(),
}).passthrough();
export type UsageSummaryResponse = z.infer<typeof UsageSummaryResponseSchema>;

export const CoverageSchema = z.object({
  source_timestamp: z.string().nullable(),
  data_completeness: z.number().min(0).max(1),
  known_gaps: z.array(z.string()),
}).passthrough();
export type Coverage = z.infer<typeof CoverageSchema>;

export const TokenCountsSchema = z.object({
  input_tokens: z.number().int(),
  cache_creation_input_tokens: z.number().int(),
  cache_read_input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  reasoning_output_tokens: z.number().int(),
}).passthrough();

export const CostCategoriesSchema = z.object({
  uncached_input_usd: z.number(),
  cache_write_usd: z.number(),
  cache_read_usd: z.number(),
  output_usd: z.number(),
}).passthrough();

export const CallCostResponseSchema = z.object({
  org_id: z.string(),
  request_id: z.string(),
  ts: z.string(),
  project_id: z.string(),
  workload_id: z.string(),
  provider: z.enum(["anthropic", "openai", "managed"]),
  served_model: z.string(),
  tokens: TokenCountsSchema,
  pricing_status: z.enum(["priced", "unpriced"]),
  unpriced_reason: z.string().nullable(),
  customer_cost_usd: z.number().nullable(),
  cost_categories: CostCategoriesSchema.nullable(),
  coverage: CoverageSchema,
  generated_at: z.string(),
}).passthrough();
export type CallCostResponse = z.infer<typeof CallCostResponseSchema>;

const CostBreakdownCategoriesSchema = CostCategoriesSchema.extend({
  total_usd: z.number(),
}).passthrough();

export const CostBreakdownResponseSchema = z.object({
  project_id: z.string(),
  window: z.string(),
  window_start: z.string(),
  window_end: z.string(),
  workload_id: z.string().nullable(),
  workloads: z.array(z.object({
    workload_id: z.string(),
    workload: z.string().nullable(),
    requests: z.number().int(),
    priced_requests: z.number().int(),
    cost: CostBreakdownCategoriesSchema,
  }).passthrough()),
  totals: CostBreakdownCategoriesSchema.extend({
    requests: z.number().int(),
    priced_requests: z.number().int(),
  }).passthrough(),
  coverage: CoverageSchema,
  generated_at: z.string(),
}).passthrough();

export const WorkloadStatusResponseSchema = z.object({
  project_id: z.string(),
  window: z.string(),
  window_start: z.string(),
  window_end: z.string(),
  workloads: z.array(z.object({
    workload_id: z.string(),
    display_name: z.string(),
    status: z.enum(["healthy", "degraded", "idle"]),
    mode: z.enum(["anthropic", "openai", "managed"]).nullable(),
    declared: z.object({
      routed: z.enum(["pin", "steer", "none"]),
      split_pct: z.number().int().min(0).max(100),
    }).passthrough(),
    requests: z.number().int(),
    route_shares: z.object({
      primary: z.number(),
      understudy: z.number(),
      fallback: z.number(),
    }).passthrough(),
    error_rate: z.number(),
    last_error_at: z.string().nullable(),
    example_request_ids: z.array(z.string()),
    served_models: z.array(z.object({
      model: z.string(),
      provider_label: z.enum(["anthropic", "openai", "managed"]),
      requests: z.number().int(),
      share: z.number(),
    }).passthrough()),
    rerouted_pct: z.number(),
  }).passthrough()),
  workload_count: z.number().int(),
  generated_at: z.string(),
}).passthrough();
export type WorkloadStatusResponse = z.infer<typeof WorkloadStatusResponseSchema>;
export type CostBreakdownResponse = z.infer<typeof CostBreakdownResponseSchema>;

export const BillingTokenBreakdownSchema = z.object({
  input_tokens: z.number(),
  cache_creation_input_tokens: z.number(),
  cache_read_input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_output_tokens: z.number(),
  total_tokens: z.number(),
}).passthrough();

export const BillingBalanceResponseSchema = z.object({
  balance: z.object({
    org_id: z.string(),
    billing_mode: z.string(),
    status: z.string(),
    balance_usd: z.number(),
    currency: z.string(),
    low_balance_threshold_usd: z.number(),
    grants: z.object({
      total_granted_usd: z.number(),
      total_remaining_usd: z.number(),
      soonest_expiry: z.string().nullable(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();
export type BillingBalanceResponse = z.infer<typeof BillingBalanceResponseSchema>;

export const BillingSummaryResponseSchema = z.object({
  summary: z.object({
    org_id: z.string(),
    from: z.string(),
    to: z.string(),
    tokens: BillingTokenBreakdownSchema,
    metered_requests: z.number(),
    priced_events: z.number(),
    estimated_cost_usd: z.number(),
    blended_price_per_mtok: z.number(),
  }).passthrough(),
}).passthrough();
export type BillingSummaryResponse = z.infer<typeof BillingSummaryResponseSchema>;

export const BillingTrendResponseSchema = z.object({
  points: z.array(z.object({
    day: z.string(),
    tokens: BillingTokenBreakdownSchema,
    cost_usd: z.number(),
  }).passthrough()),
}).passthrough();
export type BillingTrendResponse = z.infer<typeof BillingTrendResponseSchema>;

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const SMALL_USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});
const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const PERCENT_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

export function parseDuration(value: string, label: string, maxMinutes: number): string {
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    throw new Error(`${label} must be a duration such as 6h, 24h, 7d, or 30d.`);
  }
  const count = Number(match[1]);
  const unit = match[2];
  const minutes = count * (unit === "m" ? 1 : unit === "h" ? 60 : 1_440);
  if (count < 1 || minutes > maxMinutes) {
    throw new Error(`${label} must be greater than zero and no longer than ${Math.floor(maxMinutes / 1_440)}d.`);
  }
  return normalized;
}

export function parseBillingWindow(from: string, to: string): { from: string; to: string } {
  const explicitTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  const normalizedFrom = from.trim();
  const normalizedTo = to.trim();
  if (!explicitTimezone.test(normalizedFrom) || !explicitTimezone.test(normalizedTo)) {
    throw new Error("--from and --to must be ISO timestamps with Z or a numeric UTC offset.");
  }
  const fromMs = Date.parse(normalizedFrom);
  const toMs = Date.parse(normalizedTo);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error("--from and --to must be valid ISO UTC timestamps.");
  }
  if (toMs <= fromMs) {
    throw new Error("--from must be strictly before --to.");
  }
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

export function parseCustomReportingRange(
  from: string | undefined,
  to: string | undefined,
): { from: string; to: string } | null {
  if (from === undefined && to === undefined) return null;
  if (!from || !to) {
    throw new Error("Pass both --from and --to for a custom reporting range.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error("--from and --to must use YYYY-MM-DD for custom reporting ranges.");
  }
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    new Date(fromMs).toISOString().slice(0, 10) !== from ||
    new Date(toMs).toISOString().slice(0, 10) !== to
  ) {
    throw new Error("--from and --to must be valid UTC calendar dates.");
  }
  const inclusiveDays = Math.floor((toMs - fromMs) / 86_400_000) + 1;
  if (!Number.isFinite(inclusiveDays) || inclusiveDays < 1 || inclusiveDays > 366) {
    throw new Error("Custom reporting ranges must be ordered and no longer than 366 days.");
  }
  return { from, to };
}

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.000001) return "<$0.000001";
  const formatter = value !== 0 && Math.abs(value) < 0.01
    ? SMALL_USD_FORMATTER
    : USD_FORMATTER;
  return formatter.format(value);
}

export function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value);
}

export function formatPercent(value: number): string {
  return PERCENT_FORMATTER.format(value);
}

export function sanitizeForTerminal(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  });
}
