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

export type ProjectSummary = {
  project: Project;
  workloads: Workload[];
  statuses: { workload_id: string; status: "healthy" | "degraded" | "idle" }[];
  error: string | null;
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
export function loadOrgSummary(
  adminGet: (path: string) => Promise<any>,
): Promise<OrgSummary>;
