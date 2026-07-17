export type RoutingEntryLike = {
  workload_id: string;
  display_name?: string;
  environment?: string | null;
  route_mode: string;
  active_traffic_pct?: number;
  provider_label?: string | null;
  model?: string | null;
};

export type HealthEntryLike = {
  workload: string;
  provider?: string;
  model?: string;
  request_count?: number;
  error_5xx_count?: number;
  timeout_count?: number;
  fallback_count?: number;
  example_request_ids?: string[];
};

export type WorkloadMonitorRow = {
  workloadId: string;
  name: string;
  environment: string | null;
  routeMode: string;
  trafficPercent: number;
  provider: string | null;
  model: string | null;
  requests: number;
  errors: number;
  timeouts: number;
  fallbacks: number;
  requestIds: string[];
};

export function buildWorkloadRows(
  routingEntries?: RoutingEntryLike[],
  healthEntries?: HealthEntryLike[],
): WorkloadMonitorRow[];

export function monitoringState(health?: {
  total_requests?: number;
  total_errors?: number;
  providers?: HealthEntryLike[];
}): {
  tone: "attention" | "watch" | "quiet" | "healthy";
  label: string;
  detail: string;
  errors: number;
  timeouts: number;
  fallbacks: number;
};

export function cacheReusePercent(summary?: {
  tokens?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
} | null): number | null;

export function topModelRows<T extends { cost_usd?: number }>(rows?: T[], limit?: number): T[];

export function displayModelName(value?: unknown): string;
