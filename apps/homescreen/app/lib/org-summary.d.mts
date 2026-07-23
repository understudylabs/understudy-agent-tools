export const OVERVIEW_PROJECT_LIMIT: number;

export type OverrideKind = "primary" | "override" | "split" | "hold";
export type OverrideState = {
  kind: OverrideKind;
  modelId: string | null;
  trafficPct: number;
};

export type Project = {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  created_at: string;
};

export type Workload = {
  id: string;
  project_id: string;
  name: string;
  capture_enabled: boolean;
  route_deployment_id: string | null;
  route_model_id: string | null;
  route_traffic_pct: number;
  capture_sample_rate: number;
  is_default: boolean;
  created_at: string;
};

export type WorkloadHealth = "healthy" | "degraded" | "idle" | "unavailable";

export type ReportingSeriesPoint = {
  bucket: string;
  workload_id: string | null;
  requests: number;
  customer_cost_usd: number;
};

export type OrganizationReporting = {
  totals: { customer_cost_usd: number };
  series: ReportingSeriesPoint[];
};

export type BillingBalance = {
  billing_mode: "prepaid" | "postpaid";
  status: string;
  balance_usd: number;
  grants: { total_remaining_usd: number };
};

export type WorkloadUsage = { requests: number; costUsd: number };

export type WorkloadCardData = {
  workload: Workload;
  project: Project;
  usage: WorkloadUsage | undefined;
  healthStatus: WorkloadHealth;
};

/** One row of the admin usage-summary `groups` payload. */
export type UsageGroupRow = {
  workload_id?: string | null;
  workload?: string | null;
  day?: string | null;
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  customer_cost_usd?: number;
};

export type ProjectUsage = {
  /** 30d `group_by=workload,day` rows ([] when the call failed). */
  workloadDay: UsageGroupRow[];
  /** 30d `group_by=day` rows ([] when the call failed). */
  byDay: UsageGroupRow[];
};

export type ProjectSummary = {
  project: Project;
  workloads: Workload[];
  /** Raw 24h workload-status rows — the fields the panes actually read. */
  statuses: {
    workload_id: string;
    status: "healthy" | "degraded" | "idle";
    requests?: number;
    error_rate?: number;
    route_shares?: { primary: number; understudy: number; fallback: number };
  }[];
  usage: ProjectUsage;
  error: string | null;
};

export type StackRow = { day: string; values: Record<string, number> };
export type Stack = { keys: string[]; rows: StackRow[] };
export type TokenStack = Stack & { dimension: "workload" | "project" };

export type UsageDayRow = {
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheRatePct: number | null;
};

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheRatePct: number | null;
};

export type WorkloadUsageDetail = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheRatePct: number | null;
};

export type CacheLeader = {
  name: string;
  cacheReadTokens: number;
  inputTokens: number;
  cacheRatePct: number;
};

export type OrgSummary =
  | { ok: false; error: string }
  | {
      ok: true;
      projects: Project[];
      summaries: ProjectSummary[];
      reporting: OrganizationReporting | null;
      /** 30d daily series for the spend range picker (chart only). */
      reporting30: OrganizationReporting | null;
      balance: BillingBalance | null;
      cards: WorkloadCardData[];
      metrics: {
        totalSpendUsd: number | null;
        activeWorkloads: number | null;
        captureEnabledCount: number;
        workloadCount: number;
      };
      partialErrors: string[];
    };

export function deriveOverrideState(workload: Workload): OverrideState;
export function routeSummary(route: OverrideState): string;
export function aggregateUsage(rows: ReportingSeriesPoint[]): Map<string, WorkloadUsage>;
export function spendTrendPoints(rows: ReportingSeriesPoint[]): [string, number][];
export function buildWorkloadCards(
  summaries: { project: Project; workloads: Workload[] }[],
  usageByWorkload: Map<string, WorkloadUsage>,
  statusByWorkload: Map<string, "healthy" | "degraded" | "idle" | "unavailable">,
): WorkloadCardData[];
export function healthLabel(status: WorkloadHealth): string;
export function availableBalance(balance: BillingBalance): number;
export function balanceDetail(balance: BillingBalance): string;
export function formatUSD(usd: number): string;
export function formatTokens(n: number): string;
export function formatDay(day: string): string;
export function workloadNameMap(summaries: { workloads: Workload[] }[]): Map<string, string>;
export function spendStack(
  series: ReportingSeriesPoint[] | null | undefined,
  names: Map<string, string>,
): Stack;
export function tokenStack(
  summaries: { project: Project; usage?: ProjectUsage }[],
  names: Map<string, string>,
): TokenStack;
export function stackTotals(rows: StackRow[]): { byKey: Map<string, number>; total: number };
export function usageDaySeries(summaries: { usage?: ProjectUsage }[]): UsageDayRow[];
export function cacheRatePct(cacheReadTokens: number, inputTokens: number): number | null;
export function usageTotals(rows: UsageDayRow[]): UsageTotals;
export function workloadUsageDetails(
  summaries: { usage?: ProjectUsage }[],
  sinceDay?: string | null,
): Map<string, WorkloadUsageDetail>;
export function cacheLeaders(
  summaries: { usage?: ProjectUsage }[],
  names: Map<string, string>,
): CacheLeader[];
export function loadOrgSummary(
  adminGet: (path: string) => Promise<any>,
): Promise<OrgSummary>;
