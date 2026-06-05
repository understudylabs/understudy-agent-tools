import { Command } from "commander";
import kleur from "kleur";
import { z } from "zod";

import { request, resolveAuth } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { trackControlPlaneAction } from "../internal/telemetry.js";

const RouteResponseSchema = z.object({
  workload_id: z.string().optional(),
  project_id: z.string().optional(),
  model_id: z.string().nullable().optional(),
  route_traffic_pct: z.number().nullable().optional(),
}).passthrough();

interface OrgOpt {
  org?: string;
}

interface RouteOpts extends OrgOpt {
  projectId: string;
  modelId?: string;
  trafficPct?: string;
  clear?: boolean;
}

export function registerWorkloadsCommand(program: Command): void {
  const workloads = program
    .command("workloads")
    .description("Manage project workload route configuration.");

  workloads
    .command("route <workload-id>")
    .description("Set or clear an Understudy model traffic route for a workload.")
    .requiredOption("--project-id <id>", "Project id from `understudy projects list --json`.")
    .option("--model-id <id>", "Public Understudy model id from `understudy models list`.")
    .option("--traffic-pct <0-100>", "Percent of traffic to send to the selected Understudy model.", "10")
    .option("--clear", "Clear the Understudy model route and return to passthrough/frontier.")
    .option("--org <id>", "Org id to use (default: only org in credentials).")
    .action(async function (this: Command, workloadId: string, opts: RouteOpts) {
      await runAction(this, () => runRoute(this, workloadId, opts));
    });
}

async function runRoute(cmd: Command, workloadId: string, opts: RouteOpts): Promise<void> {
  if (!workloadId) {
    throw new Error("workload-id is required.");
  }
  if (opts.clear && opts.modelId) {
    throw new Error("Use either --clear or --model-id, not both.");
  }
  if (!opts.clear && !opts.modelId) {
    throw new Error("Pass --model-id <id> to set a route or --clear to remove it.");
  }

  const auth = resolveAuth(opts.org);
  const body = opts.clear
    ? { model_id: null }
    : {
        model_id: opts.modelId,
        route_traffic_pct: parseTrafficPct(opts.trafficPct ?? "10"),
      };
  const res = await request(
    {
      url: `/admin/v1/orgs/${auth.orgId}/projects/${encodeURIComponent(opts.projectId)}/workloads/${encodeURIComponent(workloadId)}/route`,
      orgId: auth.orgId,
      method: "PUT",
      body,
    },
    RouteResponseSchema,
  );
  trackControlPlaneAction({
    resource: "workload_routes",
    action: opts.clear ? "cleared" : "updated",
    orgId: auth.orgId,
    resultCount: opts.clear ? 0 : 1,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }

  if (opts.clear) {
    process.stdout.write(`${kleur.green("✓")} Cleared route for workload ${kleur.bold(workloadId)}\n`);
    return;
  }
  process.stdout.write(
    `${kleur.green("✓")} Routed ${kleur.bold(`${body.route_traffic_pct}%`)} of workload ${kleur.bold(workloadId)} to ${kleur.bold(String(body.model_id))}\n`,
  );
  process.stdout.write(`${kleur.gray("Inference calls keep using the normal Understudy gateway path.")}\n`);
}

function parseTrafficPct(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Expected --traffic-pct between 0 and 100, got: ${value}`);
  }
  return parsed;
}
