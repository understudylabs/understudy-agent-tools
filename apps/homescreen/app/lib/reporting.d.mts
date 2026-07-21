// Types for reporting.mjs — the org Analytics pane's pure logic
// (ported from the web control plane's reporting surface).

export type ReportingWindow = "24h" | "7d" | "30d" | "custom";
export type ReportingGranularity = "minute" | "hour" | "day";
export type ReportingGroupBy = "project" | "workload" | "model";
export type ReportingMetric = "usage" | "caching" | "cost";
export type ReportingRange =
  | "24h"
  | "7d"
  | "30d"
  | "month-to-date"
  | "last-month"
  | "custom";
export type BreakdownColumn =
  | "label"
  | "requests"
  | "totalTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "cacheReadPct"
  | "costUsd";
export type SortDirection = "asc" | "desc";
export type SortState = { column: BreakdownColumn; direction: SortDirection };

export type ReportingSeriesPoint = {
  bucket: string;
  project?: string | null;
  project_id?: string | null;
  workload?: string | null;
  workload_id?: string | null;
  model?: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  customer_cost_usd: number;
};

export type ReportingTotals = {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  customer_cost_usd: number;
};

export type ReportingResponse = {
  org_id: string;
  window: ReportingWindow;
  window_start: string;
  window_end: string;
  granularity: ReportingGranularity;
  group_by: ReportingGroupBy;
  filters: { project_id?: string | null; workload_id?: string | null };
  totals: ReportingTotals;
  series: ReportingSeriesPoint[];
};

export type ReportingOptionsResponse = {
  projects: { id: string; name: string }[];
  workloads: { id: string; project_id: string; name: string }[];
};

export type ReportingData = {
  reporting: ReportingResponse;
  options: ReportingOptionsResponse;
};

export type ReportingResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; request_id: string | null };

export type SanitizedReportingQuery = {
  window: ReportingWindow;
  from?: string;
  to?: string;
  granularity: ReportingGranularity;
  group_by: ReportingGroupBy;
  project_id?: string;
  workload_id?: string;
};

export function cleanDate(value: string | null | undefined): string | undefined;
export function cleanFilter(value: string | null | undefined): string | undefined;
export function sanitizeReportingQuery(input: {
  window: string;
  from?: string | null;
  to?: string | null;
  granularity: string;
  groupBy: string;
  projectId?: string | null;
  workloadId?: string | null;
}): SanitizedReportingQuery;

export function dateInputValue(value: string): string;
export function dateDaysAgo(days: number, now?: Date): string;
export function presetRangeState(
  range: Exclude<ReportingRange, "custom">,
  now?: Date,
): { range: ReportingRange; window: ReportingWindow; from: string; to: string };
export function granularityOptions(
  from: string,
  to: string,
): readonly (readonly [string, string])[];
export function defaultGranularity(
  from: string,
  to: string,
  current: ReportingGranularity,
): ReportingGranularity;

export type ChartSeries = {
  key: string;
  label: string;
  identity: string;
  color: string;
};
export type ChartBucket = {
  bucket: string;
  label: string;
  values: Record<string, number>;
};
export function groupedChart(
  rows: ReportingSeriesPoint[],
  groupBy: ReportingGroupBy,
  metric: ReportingMetric,
  granularity: ReportingGranularity,
  palette: readonly string[],
): { rows: ChartBucket[]; series: ChartSeries[] };

export type BreakdownRow = {
  id: string;
  label: string;
  requests: number;
  inputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheReadPct: number;
  costUsd: number;
};
export function aggregateBreakdown(
  rows: ReportingSeriesPoint[],
  groupBy: ReportingGroupBy,
): BreakdownRow[];

export function defaultSort(metric: ReportingMetric): SortState;
export function sortIsVisible(metric: ReportingMetric, column: BreakdownColumn): boolean;
export function sortBreakdown(rows: BreakdownRow[], sort: SortState): BreakdownRow[];
export function toggleSeries(current: Set<string>, identity: string): Set<string>;
export function cacheReadShare(row: {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  inputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number;

export function formatTokens(value: number): string;
export function formatUSD(value: number): string;
export function formatPercent(value: number): string;
export function granularityLabel(granularity: ReportingGranularity): string;
export function formatBucket(bucket: string, granularity: ReportingGranularity): string;
export function formatRange(start: string, end: string, inclusiveEnd?: boolean): string;
export function groupByLabel(groupBy: ReportingGroupBy): string;
