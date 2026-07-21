// Types for reporting-format.mjs plus the reporting API shapes the pane
// consumes (mirrors understudy-platform packages/types reporting.ts).

export type ServedModelShare = {
  model: string;
  provider_label: "anthropic" | "openai" | "managed";
  requests: number;
  share: number;
};

export type WorkloadStatusEntry = {
  workload_id: string;
  display_name: string;
  status: "healthy" | "degraded" | "idle";
  mode: "anthropic" | "openai" | "managed" | null;
  declared: { routed: "pin" | "steer" | "none"; split_pct: number };
  requests: number;
  route_shares: { primary: number; understudy: number; fallback: number };
  error_rate: number;
  last_error_at: string | null;
  example_request_ids: string[];
  served_models: ServedModelShare[];
  rerouted_pct: number;
};

export type WorkloadStatusResponse = {
  project_id: string;
  window: string;
  window_start: string;
  window_end: string;
  workloads: WorkloadStatusEntry[];
  workload_count: number;
  generated_at: string;
};

export type UsageSummaryGroup = {
  workload_id: string | null;
  workload: string | null;
  model: string | null;
  day: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_pct: number;
  customer_cost_usd: number;
  error_rate: number;
};

export type UsageWindow = "7d" | "30d";

export type UsageSummaryData = {
  window: UsageWindow;
  byDay: UsageSummaryGroup[];
  byWorkload: UsageSummaryGroup[];
};

/** Envelope shared with the Rust reporting commands. */
export type ReportingResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; request_id: string | null };

export type UsageTotals = {
  requests: number;
  costUsd: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export function formatUSD(usd: number): string;
export function formatTokens(n: number): string;
export function formatShare(share: number): string;
export function formatDayLabel(day: string): string;
export function formatTimestamp(iso: string): string;
export function dailySeries(
  byDay: UsageSummaryGroup[],
): { rawDay: string; label: string; requests: number }[];
export function totalsFrom(rows: UsageSummaryGroup[]): UsageTotals;
export function cacheReadShare(row: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number;
