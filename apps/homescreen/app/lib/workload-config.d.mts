export type OverrideKind = "primary" | "override" | "split" | "hold";

export type WorkloadRecord = {
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

export type OverrideState = {
  kind: OverrideKind;
  modelId: string | null;
  trafficPct: number;
};

export type RoutingPatchBody = {
  model_id?: string | null;
  route_traffic_pct?: number;
};

export const PRIMARY: string;

export function deriveOverrideState(workload: WorkloadRecord): OverrideState;

export function validateTrafficPct(
  value: string | number,
): { ok: true; pct: number } | { ok: false; error: string };

export function planRouteSave(input: {
  workload: WorkloadRecord;
  selectedModel: string;
  trafficPct: string | number;
}):
  | { ok: false; error: string }
  | { ok: true; dirty: false }
  | { ok: true; dirty: true; body: RoutingPatchBody };

export function planRollback(): { model_id: null };

export function initialTrafficPct(workload: WorkloadRecord): number;

export function afterSaveLabel(selectedModel: string, parsedPct: number): string;
