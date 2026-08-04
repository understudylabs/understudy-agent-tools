import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { findProjectRoot } from "../config/paths.js";
import { request } from "./http.js";
import { type ResolvedProject } from "./projects.js";

export const WORKLOAD_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const WorkloadSchema = z.object({
  id: z.string(),
  project_id: z.string().optional(),
  name: z.string(),
  capture_enabled: z.boolean().optional(),
  route_model_id: z.string().nullable().optional(),
  route_traffic_pct: z.number().nullable().optional(),
  route_deployment_id: z.string().nullable().optional(),
  is_default: z.boolean().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();

const ListWorkloadsResponseSchema = z.object({
  workloads: z.array(WorkloadSchema),
  cursor: z.string().nullable().optional(),
}).passthrough();

const RouteResponseSchema = z.object({
  workload_id: z.string().optional(),
  project_id: z.string().optional(),
  model_id: z.string().nullable().optional(),
  route_model_id: z.string().nullable().optional(),
  route_traffic_pct: z.number().nullable().optional(),
}).passthrough();

export type Workload = z.infer<typeof WorkloadSchema>;
export type RouteResponse = z.infer<typeof RouteResponseSchema>;

export async function listWorkloads(project: ResolvedProject): Promise<Workload[]> {
  const res = await request(
    {
      url: `/admin/v1/orgs/${project.auth.orgId}/projects/${encodeURIComponent(project.projectId)}/workloads`,
      orgId: project.auth.orgId,
    },
    ListWorkloadsResponseSchema,
  );
  return res.data.workloads;
}

export async function resolveWorkload(project: ResolvedProject, value: string): Promise<Workload> {
  if (!value) {
    throw new Error("workload is required.");
  }
  if (value.startsWith("usp_")) {
    return {
      id: value,
      project_id: project.projectId,
      name: value,
    };
  }
  const workloads = await listWorkloads(project);
  const workload = workloads.find((candidate) => candidate.name === value);
  if (!workload) {
    const projectLabel = project.projectSlug ?? project.projectId;
    throw new Error(`No workload named ${value} in project ${projectLabel}. Run \`understudy workloads list\` or create it.`);
  }
  return workload;
}

export async function setWorkloadRoute(
  project: ResolvedProject,
  workload: Workload,
  body: { model_id: string | null; route_traffic_pct?: number },
): Promise<RouteResponse> {
  const res = await request(
    {
      url: `/admin/v1/orgs/${project.auth.orgId}/projects/${encodeURIComponent(project.projectId)}/workloads/${encodeURIComponent(workload.id)}/route`,
      orgId: project.auth.orgId,
      method: "PUT",
      body,
    },
    RouteResponseSchema,
  );
  return res.data;
}

export interface RouteSnapshot {
  schema_version: "understudy.route_snapshot.v1";
  org_id: string;
  project_id: string;
  workload_id: string;
  workload_name: string | null;
  previous: {
    route_model_id: string | null;
    route_traffic_pct: number | null;
  };
  created_at: string;
}

export function routeSnapshotPath(projectId: string, workloadId: string): string {
  return join(findProjectRoot(), ".understudy", "routes", projectId, workloadId, "last-route.json");
}

export function writeRouteSnapshot(project: ResolvedProject, workload: Workload): string {
  const path = routeSnapshotPath(project.projectId, workload.id);
  const snapshot: RouteSnapshot = {
    schema_version: "understudy.route_snapshot.v1",
    org_id: project.auth.orgId,
    project_id: project.projectId,
    workload_id: workload.id,
    workload_name: workload.name ?? null,
    previous: {
      route_model_id: workload.route_model_id ?? null,
      route_traffic_pct: workload.route_traffic_pct ?? null,
    },
    created_at: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return path;
}

export function readRouteSnapshot(projectId: string, workloadId: string): RouteSnapshot | null {
  const path = routeSnapshotPath(projectId, workloadId);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RouteSnapshot;
    if (parsed.schema_version !== "understudy.route_snapshot.v1") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseTrafficPct(value: string | number | undefined, fallback = 10): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Expected --traffic-pct between 0 and 100, got: ${String(value)}`);
  }
  return parsed;
}

const WorkloadCardNameSchema = z.object({
  schema_version: z.literal("understudy.workload_card.v1"),
  workload_id: z.string().optional().nullable(),
  workload_name: z.string().optional().nullable(),
}).passthrough();

/** Resolve a gateway workload name from a local workload-card.json. */
export function readWorkloadCardName(cardPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(cardPath, "utf8");
  } catch {
    throw new Error(`Could not read workload card at ${cardPath}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in workload card at ${cardPath}.`);
  }
  const card = WorkloadCardNameSchema.parse(parsed);
  const fromName = typeof card.workload_name === "string" ? card.workload_name.trim() : "";
  const fromId = typeof card.workload_id === "string" ? card.workload_id.trim() : "";
  const name = fromName || fromId;
  if (!name) {
    throw new Error(`Workload card at ${cardPath} has no usable workload_name or workload_id.`);
  }
  if (!WORKLOAD_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid workload name "${name}". Must match /^[a-z0-9][a-z0-9_-]{0,62}$/.`);
  }
  return name;
}
