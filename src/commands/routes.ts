import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import kleur from "kleur";

import { isJsonMode, runAction } from "../internal/output.js";
import { trackControlPlaneAction } from "../internal/telemetry.js";
import { resolveProject, type ProjectResolutionOptions } from "../internal/projects.js";
import {
  listWorkloads,
  parseTrafficPct,
  readRouteSnapshot,
  resolveWorkload,
  setWorkloadRoute,
  writeRouteSnapshot,
  type Workload,
} from "../internal/workloads.js";
import { validateRouteDecisionPacket } from "../route-decision.js";

interface RouteOpts extends ProjectResolutionOptions {}

interface SetOpts extends RouteOpts {
  modelId: string;
  trafficPct?: string;
}

interface PromoteOpts extends RouteOpts {
  from: string;
  workload?: string;
  modelId?: string;
  trafficPct?: string;
  yes?: boolean;
}

export function registerRoutesCommand(program: Command): void {
  const routes = program
    .command("routes")
    .description("Inspect, set, clear, promote, and rollback hosted workload routes.");

  addProjectOptions(routes.command("show <workload>")
    .description("Show the current hosted route for a workload."))
    .action(async function (this: Command, workload: string, opts: RouteOpts) {
      await runAction(this, () => runShow(this, workload, opts));
    });

  addProjectOptions(routes.command("set <workload>")
    .description("Route a small traffic percentage to an Understudy model.")
    .requiredOption("--model-id <id>", "Public Understudy model id.")
    .option("--traffic-pct <0-100>", "Traffic percentage.", "10"))
    .action(async function (this: Command, workload: string, opts: SetOpts) {
      await runAction(this, () => runSet(this, workload, opts));
    });

  addProjectOptions(routes.command("clear <workload>")
    .description("Clear a hosted route and return to passthrough."))
    .action(async function (this: Command, workload: string, opts: RouteOpts) {
      await runAction(this, () => runClear(this, workload, opts));
    });

  addProjectOptions(routes.command("rollback <workload>")
    .description("Restore the last route snapshot, or clear when no snapshot exists."))
    .action(async function (this: Command, workload: string, opts: RouteOpts) {
      await runAction(this, () => runRollback(this, workload, opts));
    });

  addProjectOptions(routes.command("promote")
    .description("Promote a hosted-ready route-decision packet.")
    .requiredOption("--from <path>", "Route decision packet JSON.")
    .option("--workload <name-or-id>", "Workload name or id when the packet lacks hosted ids.")
    .option("--model-id <id>", "Model id when the packet lacks hosted ids.")
    .option("--traffic-pct <0-100>", "Traffic percentage override.")
    .option("--yes", "Confirm hosted traffic mutation."))
    .action(async function (this: Command, opts: PromoteOpts) {
      await runAction(this, () => runPromote(this, opts));
    });
}

function addProjectOptions(command: Command): Command {
  return command
    .option("--project-id <id>", "Project id from `understudy projects list --json`.")
    .option("--project <slug>", "Project slug to resolve to an id.")
    .option("--org <id>", "Org id to use (default: local config or only org in credentials).");
}

async function runShow(cmd: Command, workloadValue: string, opts: RouteOpts): Promise<void> {
  const project = await resolveProject(opts);
  const workload = await resolveWorkloadWithState(project, workloadValue);
  const payload = routePayload(project.projectId, workload);
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  printRoute(payload);
}

async function runSet(cmd: Command, workloadValue: string, opts: SetOpts): Promise<void> {
  const project = await resolveProject(opts);
  const workload = await resolveWorkloadWithState(project, workloadValue);
  const trafficPct = parseTrafficPct(opts.trafficPct, 10);
  const snapshotPath = writeRouteSnapshot(project, workload);
  const result = await setWorkloadRoute(project, workload, { model_id: opts.modelId, route_traffic_pct: trafficPct });
  trackControlPlaneAction({ resource: "workload_routes", action: "updated", orgId: project.auth.orgId, projectSlug: project.projectSlug, resultCount: 1 });
  const payload = { ok: true, workload_id: workload.id, workload_name: workload.name, model_id: result.route_model_id ?? result.model_id ?? opts.modelId, route_traffic_pct: result.route_traffic_pct ?? trafficPct, snapshot_path: snapshotPath };
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`${kleur.green("✓")} Route set for ${workload.name} (${workload.id})\n`);
  process.stdout.write(`route: ${payload.model_id} at ${payload.route_traffic_pct}%\n`);
  process.stdout.write(`${kleur.gray("Inference calls keep using the normal Understudy gateway path.")}\n`);
}

async function runClear(cmd: Command, workloadValue: string, opts: RouteOpts): Promise<void> {
  const project = await resolveProject(opts);
  const workload = await resolveWorkloadWithState(project, workloadValue);
  const snapshotPath = writeRouteSnapshot(project, workload);
  await setWorkloadRoute(project, workload, { model_id: null });
  trackControlPlaneAction({ resource: "workload_routes", action: "cleared", orgId: project.auth.orgId, projectSlug: project.projectSlug, resultCount: 0 });
  const payload = { ok: true, workload_id: workload.id, workload_name: workload.name, model_id: null, route_traffic_pct: 0, snapshot_path: snapshotPath };
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`${kleur.green("✓")} Cleared route for ${workload.name} (${workload.id})\n`);
  process.stdout.write("route: passthrough\n");
}

async function runRollback(cmd: Command, workloadValue: string, opts: RouteOpts): Promise<void> {
  const project = await resolveProject(opts);
  const workload = await resolveWorkloadWithState(project, workloadValue);
  const snapshot = readRouteSnapshot(project.projectId, workload.id);
  const previous = snapshot?.previous ?? { route_model_id: null, route_traffic_pct: null };
  const body = previous.route_model_id
    ? { model_id: previous.route_model_id, route_traffic_pct: previous.route_traffic_pct ?? 10 }
    : { model_id: null };
  const result = await setWorkloadRoute(project, workload, body);
  trackControlPlaneAction({ resource: "workload_routes", action: previous.route_model_id ? "updated" : "cleared", orgId: project.auth.orgId, projectSlug: project.projectSlug, resultCount: previous.route_model_id ? 1 : 0 });
  const payload = {
    ok: true,
    restored_from_snapshot: Boolean(snapshot),
    workload_id: workload.id,
    workload_name: workload.name,
    model_id: result.route_model_id ?? result.model_id ?? body.model_id,
    route_traffic_pct: result.route_traffic_pct ?? ("route_traffic_pct" in body ? body.route_traffic_pct : 0),
  };
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (!snapshot) {
    process.stdout.write(`${kleur.yellow("no snapshot")} cleared route for ${workload.name} (${workload.id})\n`);
    return;
  }
  process.stdout.write(`${kleur.green("✓")} Rolled back route for ${workload.name} (${workload.id})\n`);
}

async function runPromote(cmd: Command, opts: PromoteOpts): Promise<void> {
  const packet = readPacket(opts.from);
  validateRouteDecisionPacket(packet);
  const decision = stringValue(packet.decision);
  if (decision === "evaluate-first" || decision === "local-only") {
    throw new Error("Route packet is evaluate-first, not hosted-promotion-ready. Run local evaluation or pass explicit route inputs after review.");
  }
  const project = await resolveProject({
    org: opts.org,
    projectId: opts.projectId ?? stringValue(packet.project_id),
    project: opts.project ?? stringValue(packet.project_slug),
  });
  const workloadValue = opts.workload ?? stringValue(packet.workload_id) ?? stringValue(packet.workload_name);
  const modelId = opts.modelId ?? stringValue(packet.model_id) ?? stringValue(packet.route_model_id);
  if (!workloadValue || !modelId) {
    throw new Error("Packet lacks hosted workload/model fields. Pass --workload and --model-id after reviewing the packet.");
  }
  if (!opts.yes) {
    throw new Error("Promoting a route mutates hosted traffic. Re-run with --yes after reviewing the packet.");
  }
  const workload = await resolveWorkloadWithState(project, workloadValue);
  const trafficPct = parseTrafficPct(opts.trafficPct ?? numberValue(packet.route_traffic_pct), 10);
  const snapshotPath = writeRouteSnapshot(project, workload);
  const result = await setWorkloadRoute(project, workload, { model_id: modelId, route_traffic_pct: trafficPct });
  trackControlPlaneAction({ resource: "workload_routes", action: "updated", orgId: project.auth.orgId, projectSlug: project.projectSlug, resultCount: 1 });
  const payload = { ok: true, workload_id: workload.id, workload_name: workload.name, model_id: result.route_model_id ?? result.model_id ?? modelId, route_traffic_pct: result.route_traffic_pct ?? trafficPct, snapshot_path: snapshotPath };
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`${kleur.green("✓")} Promoted route for ${workload.name} (${workload.id})\n`);
  process.stdout.write(`route: ${payload.model_id} at ${payload.route_traffic_pct}%\n`);
}

async function resolveWorkloadWithState(project: Awaited<ReturnType<typeof resolveProject>>, value: string): Promise<Workload> {
  if (!value.startsWith("usp_")) {
    return resolveWorkload(project, value);
  }
  const workloads = await listWorkloads(project);
  return workloads.find((candidate) => candidate.id === value) ?? resolveWorkload(project, value);
}

function routePayload(projectId: string, workload: Workload) {
  return {
    project_id: projectId,
    workload_id: workload.id,
    workload_name: workload.name,
    route_model_id: workload.route_model_id ?? null,
    route_traffic_pct: workload.route_traffic_pct ?? 0,
    capture_enabled: Boolean(workload.capture_enabled),
    is_default: Boolean(workload.is_default),
  };
}

function printRoute(payload: ReturnType<typeof routePayload>): void {
  process.stdout.write(`workload: ${payload.workload_name} (${payload.workload_id})\n`);
  if (payload.route_model_id) {
    process.stdout.write(`route: ${payload.route_model_id} at ${payload.route_traffic_pct}%\n`);
    process.stdout.write(`passthrough: ${100 - payload.route_traffic_pct}%\n`);
  } else {
    process.stdout.write("route: passthrough\n");
  }
  process.stdout.write(`capture_enabled: ${payload.capture_enabled ? "true" : "false"}\n`);
  process.stdout.write(`is_default: ${payload.is_default ? "true" : "false"}\n`);
}

function readPacket(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(`Route decision packet not found: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Route decision packet must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}
