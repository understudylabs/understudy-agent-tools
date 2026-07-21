// Types for management.mjs plus the admin/v1 wire shapes returned by the
// mgmt_* Tauri commands (mirrors @understudy/types in understudy-platform).

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
  is_default: boolean;
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

export type WorkloadStatusEntry = {
  workload_id: string;
  display_name: string;
  status: "healthy" | "degraded" | "idle";
  mode: "anthropic" | "openai" | "managed" | null;
  declared: { routed: "pin" | "steer" | "none"; split_pct: number };
  requests: number;
};

export type BillingGrantSummary = {
  total_remaining_usd: number;
  soonest_expiry: string | null;
};

export type BillingBalance = {
  org_id: string;
  billing_mode: "prepaid" | "postpaid";
  status: "active" | "warning" | "suspended" | "delinquent";
  balance_usd: number;
  currency: string;
  low_balance_threshold_usd: number;
  grants: BillingGrantSummary;
};

export type OverrideKind = "primary" | "override" | "split" | "hold";
export type OverrideState = {
  kind: OverrideKind;
  modelId: string | null;
  trafficPct: number;
};

export function deriveOverrideState(workload: Workload): OverrideState;
export function routeSummary(state: OverrideState): string;
export function formatUSD(usd: number): string;
export function formatTokens(n: number): string;
export function totalSpend(groups: UsageSummaryGroup[]): number;
export function availableBalance(balance: BillingBalance): number;
export function balanceDetail(balance: BillingBalance | null): string;
export function formatTrendDay(day: string): string;
export function formatExpiry(iso: string): string;

export type SpendTrendPoint = { day: string; cost: number; heightPct: number };
export function spendTrendPoints(byDayGroups: UsageSummaryGroup[]): {
  points: SpendTrendPoint[];
  maximum: number;
};

export type ProjectContextCache<T> = {
  get(): Promise<T>;
  invalidate(): void;
  peek(): T | null;
};
export function createProjectContextCache<T>(
  loader: () => Promise<T>,
  ttlMs?: number,
  now?: () => number,
): ProjectContextCache<T>;
