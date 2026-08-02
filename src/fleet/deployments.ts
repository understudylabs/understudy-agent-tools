// Provider-shaped deployment records normalized into one costed row shape.

import { type DeploymentTags, expiryIso, isReapable, parseDeploymentTags } from "./tags.js";

// Rough on-demand per-GPU-hour rates (USD). Estimates only — provider billing is
// authoritative. Used to surface relative burn, not to reconcile invoices.
export const RATE_USD_PER_GPU_HR: Record<string, number> = {
  NVIDIA_B200_180GB: 15.0,
  NVIDIA_H200_141GB: 7.0,
  NVIDIA_H100_80GB: 5.5,
  NVIDIA_A100_80GB: 3.0,
};
export const DEFAULT_RATE_USD_PER_GPU_HR = 8.0;

export interface RawDeployment {
  name?: string;
  baseModel?: string;
  description?: string;
  createTime?: string;
  acceleratorType?: string;
  acceleratorCount?: number;
  desiredReplicaCount?: number;
  annotations?: Record<string, unknown> | null;
  labels?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface DeploymentRow {
  name: string;
  baseModel: string;
  replicas: number;
  gpus: number;
  accel: string;
  usdPerHr: number;
  live: boolean;
  createTime: string | null;
  ageHours: number | null;
  tags: DeploymentTags;
  tagged: boolean;
  expiresAt: string | null;
}

export function usdPerHour(replicas: number, gpus: number, accel: string): number {
  const rate = RATE_USD_PER_GPU_HR[accel] ?? DEFAULT_RATE_USD_PER_GPU_HR;
  return replicas * gpus * rate;
}

export function normalizeDeployment(raw: RawDeployment, now = Date.now()): DeploymentRow {
  const replicas = raw.desiredReplicaCount ?? 0;
  const gpus = raw.acceleratorCount ?? 0;
  const accel = raw.acceleratorType ?? "";
  const createTime = raw.createTime ?? null;
  const created = createTime ? Date.parse(createTime) : Number.NaN;
  const tags = parseDeploymentTags(raw);
  return {
    name: (raw.name ?? "").split("/").pop() ?? "",
    baseModel: (raw.baseModel ?? "").split("/").pop() ?? "",
    replicas,
    gpus,
    accel,
    usdPerHr: usdPerHour(replicas, gpus, accel),
    live: replicas > 0,
    createTime,
    ageHours: Number.isNaN(created) ? null : (now - created) / 3_600_000,
    tags,
    tagged: isReapable(tags),
    expiresAt: expiryIso(tags, createTime),
  };
}

export function normalizeDeployments(raw: RawDeployment[], now = Date.now()): DeploymentRow[] {
  return raw.map((entry) => normalizeDeployment(entry, now));
}

/** Pull the deployment array out of a provider list response or a plain array. */
export function readDeploymentList(body: unknown): RawDeployment[] {
  if (Array.isArray(body)) return body as RawDeployment[];
  if (body && typeof body === "object") {
    const list = (body as { deployments?: unknown }).deployments;
    if (Array.isArray(list)) return list as RawDeployment[];
  }
  throw new Error("expected an array of deployments or { deployments: [...] }");
}
