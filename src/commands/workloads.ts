import { Command } from "commander";
import kleur from "kleur";

import { request } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { resolveProject, type ProjectResolutionOptions } from "../internal/projects.js";
import { trackControlPlaneAction } from "../internal/telemetry.js";
import {
  listWorkloads,
  parseTrafficPct,
  resolveWorkload,
  setWorkloadRoute,
  WorkloadSchema,
  WORKLOAD_NAME_PATTERN,
  type Workload,
} from "../internal/workloads.js";

const CreateWorkloadResponseSchema = WorkloadSchema;
const UpdateWorkloadResponseSchema = WorkloadSchema;

interface WorkloadOpts extends ProjectResolutionOptions {}

interface CreateOpts extends WorkloadOpts {
  capture?: boolean;
}

interface UpdateOpts extends WorkloadOpts {
  name?: string;
  capture?: "on" | "off";
}

interface RouteOpts extends WorkloadOpts {
  modelId?: string;
  trafficPct?: string;
  clear?: boolean;
}

export function registerWorkloadsCommand(program: Command): void {
  const workloads = program
    .command("workloads")
    .description("Manage project workload route configuration.");

  addProjectOptions(workloads.command("list")
    .description("List workloads in a project."))
    .action(async function (this: Command, opts: WorkloadOpts) {
      await runAction(this, () => runList(this, opts));
    });

  addProjectOptions(workloads.command("create <name>")
    .description("Create a workload in a project.")
    .option("--capture", "Enable hosted capture for this workload.")
    .option("--no-capture", "Disable hosted capture for this workload."))
    .action(async function (this: Command, name: string, opts: CreateOpts) {
      await runAction(this, () => runCreate(this, name, opts));
    });

  addProjectOptions(workloads.command("show <workload>")
    .description("Show one workload by id or name."))
    .action(async function (this: Command, workload: string, opts: WorkloadOpts) {
      await runAction(this, () => runShow(this, workload, opts));
    });

  addProjectOptions(workloads.command("update <workload>")
    .description("Update workload name or capture setting.")
    .option("--name <name>", "New workload name.")
    .option("--capture <on|off>", "Turn hosted capture on or off."))
    .action(async function (this: Command, workload: string, opts: UpdateOpts) {
      await runAction(this, () => runUpdate(this, workload, opts));
    });

  addProjectOptions(workloads.command("route <workload>")
    .description("Set or clear an Understudy model traffic route for a workload.")
    .option("--model-id <id>", "Public Understudy model id from `understudy models list`.")
    .option("--traffic-pct <0-100>", "Percent of traffic to send to the selected Understudy model.", "10")
    .option("--clear", "Clear the Understudy model route and return to passthrough/frontier."))
    .action(async function (this: Command, workload: string, opts: RouteOpts) {
      await runAction(this, () => runRoute(this, workload, opts));
    });
}

function addProjectOptions(command: Command): Command {
  return command
    .option("--project-id <id>", "Project id from `understudy projects list --json`.")
    .option("--project <slug>", "Project slug to resolve to an id.")
    .option("--org <id>", "Org id to use (default: local config or only org in credentials).");
}

async function runList(cmd: Command, opts: WorkloadOpts): Promise<void> {
  const project = await resolveProject(opts);
  const workloads = await listWorkloads(project);
  trackControlPlaneAction({
    resource: "workloads",
    action: "listed",
    orgId: project.auth.orgId,
    projectSlug: project.projectSlug,
    resultCount: workloads.length,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify({ project_id: project.projectId, project_slug: project.projectSlug, workloads })}\n`);
    return;
  }
  printWorkloadTable(workloads);
}

async function runCreate(cmd: Command, name: string, opts: CreateOpts): Promise<void> {
  validateWorkloadName(name);
  const project = await resolveProject(opts);
  const captureEnabled = Boolean(opts.capture);
  const res = await request(
    {
      url: `/customer/v1/orgs/${project.auth.orgId}/projects/${encodeURIComponent(project.projectId)}/workloads`,
      orgId: project.auth.orgId,
      method: "POST",
      body: { name, capture_enabled: captureEnabled },
    },
    CreateWorkloadResponseSchema,
  );
  trackControlPlaneAction({
    resource: "workloads",
    action: "created",
    orgId: project.auth.orgId,
    projectSlug: project.projectSlug,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  process.stdout.write(`${kleur.green("✓")} Created workload ${kleur.bold(res.data.name)} (${res.data.id})\n`);
  process.stdout.write(`capture: ${res.data.capture_enabled ? "on" : "off"}\n`);
  process.stdout.write(`next: understudy gateway probe --provider anthropic --project ${project.projectSlug ?? project.projectId} --workload ${res.data.name}\n`);
}

async function runShow(cmd: Command, workloadValue: string, opts: WorkloadOpts): Promise<void> {
  const project = await resolveProject(opts);
  const workload = await resolveWorkload(project, workloadValue);
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify({ project_id: project.projectId, workload })}\n`);
    return;
  }
  printWorkloadBlock(project.projectId, workload);
}

async function runUpdate(cmd: Command, workloadValue: string, opts: UpdateOpts): Promise<void> {
  if (!opts.name && !opts.capture) {
    throw new Error("Pass --name <name> and/or --capture on|off.");
  }
  if (opts.name) validateWorkloadName(opts.name);
  if (opts.capture && opts.capture !== "on" && opts.capture !== "off") {
    throw new Error("Expected --capture on|off.");
  }

  const project = await resolveProject(opts);
  const workload = await resolveWorkload(project, workloadValue);
  const body: Record<string, unknown> = {};
  if (opts.name) body.name = opts.name;
  if (opts.capture) body.capture_enabled = opts.capture === "on";

  const res = await request(
    {
      url: `/customer/v1/orgs/${project.auth.orgId}/projects/${encodeURIComponent(project.projectId)}/workloads/${encodeURIComponent(workload.id)}`,
      orgId: project.auth.orgId,
      method: "PATCH",
      body,
    },
    UpdateWorkloadResponseSchema,
  );
  trackControlPlaneAction({
    resource: "workloads",
    action: "updated",
    orgId: project.auth.orgId,
    projectSlug: project.projectSlug,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }
  process.stdout.write(`${kleur.green("✓")} Updated workload ${kleur.bold(res.data.name)} (${res.data.id})\n`);
  process.stdout.write(`capture: ${res.data.capture_enabled ? "on" : "off"}\n`);
}

async function runRoute(cmd: Command, workloadValue: string, opts: RouteOpts): Promise<void> {
  if (opts.clear && opts.modelId) {
    throw new Error("Use either --clear or --model-id, not both.");
  }
  if (!opts.clear && !opts.modelId) {
    throw new Error("Pass --model-id <id> to set a route or --clear to remove it.");
  }
  const project = await resolveProject(opts);
  const workload = await resolveWorkload(project, workloadValue);
  const body = opts.clear
    ? { model_id: null }
    : { model_id: opts.modelId!, route_traffic_pct: parseTrafficPct(opts.trafficPct, 10) };
  const result = await setWorkloadRoute(project, workload, body);
  trackControlPlaneAction({
    resource: "workload_routes",
    action: opts.clear ? "cleared" : "updated",
    orgId: project.auth.orgId,
    projectSlug: project.projectSlug,
    resultCount: opts.clear ? 0 : 1,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify({ ...result, workload_id: workload.id, workload_name: workload.name })}\n`);
    return;
  }
  printRouteResult(opts.clear, workload, result.route_model_id ?? result.model_id ?? body.model_id, result.route_traffic_pct ?? body.route_traffic_pct ?? null);
}

function validateWorkloadName(name: string): void {
  if (!WORKLOAD_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid workload name "${name}". Must match /^[a-z0-9][a-z0-9_-]{0,62}$/.`);
  }
}

function printWorkloadTable(workloads: Workload[]): void {
  if (workloads.length === 0) {
    process.stdout.write(`${kleur.gray("No workloads in this project.")} Run ${kleur.cyan("understudy workloads create <name>")} to create one.\n`);
    return;
  }
  const rows = workloads.map((w) => ({
    id: w.id,
    name: w.name,
    capture: w.capture_enabled ? "on" : "off",
    route_model: w.route_model_id ?? "passthrough",
    traffic_pct: w.route_traffic_pct == null ? "" : String(w.route_traffic_pct),
    default: w.is_default ? "yes" : "",
    created_at: w.created_at ?? "",
  }));
  printRows(rows, ["id", "name", "capture", "route_model", "traffic_pct", "default", "created_at"]);
}

function printWorkloadBlock(projectId: string, workload: Workload): void {
  process.stdout.write(`${kleur.bold("workload")}       ${workload.name}\n`);
  process.stdout.write(`${kleur.bold("id")}             ${workload.id}\n`);
  process.stdout.write(`${kleur.bold("project_id")}     ${workload.project_id ?? projectId}\n`);
  process.stdout.write(`${kleur.bold("capture_enabled")} ${workload.capture_enabled ? "true" : "false"}\n`);
  process.stdout.write(`${kleur.bold("route_model_id")} ${workload.route_model_id ?? "passthrough"}\n`);
  process.stdout.write(`${kleur.bold("route_traffic_pct")} ${workload.route_traffic_pct ?? 0}\n`);
  process.stdout.write(`${kleur.bold("is_default")}     ${workload.is_default ? "true" : "false"}\n`);
}

function printRouteResult(clear: boolean | undefined, workload: Workload, modelId: string | null | undefined, trafficPct: number | null): void {
  if (clear) {
    process.stdout.write(`${kleur.green("✓")} Cleared route for workload ${kleur.bold(workload.name)} (${workload.id})\n`);
    process.stdout.write(`route: passthrough\n`);
    return;
  }
  process.stdout.write(`${kleur.green("✓")} Routed ${kleur.bold(`${trafficPct ?? 10}%`)} of workload ${kleur.bold(workload.name)} (${workload.id}) to ${kleur.bold(String(modelId))}\n`);
  process.stdout.write(`${kleur.gray("Inference calls keep using the normal Understudy gateway path.")}\n`);
}

function printRows(rows: Array<Record<string, string>>, headers: string[]): void {
  const widths = headers.map((h) => Math.max(h.length, ...rows.map((r) => r[h]!.length)));
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  process.stdout.write(`${headers.map((h, i) => kleur.bold(pad(h, widths[i]!))).join("  ")}\n`);
  for (const row of rows) {
    process.stdout.write(`${headers.map((h, i) => pad(row[h]!, widths[i]!)).join("  ")}\n`);
  }
}
