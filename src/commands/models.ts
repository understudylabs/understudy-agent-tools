import { Command } from "commander";
import kleur from "kleur";
import { z } from "zod";

import { request, resolveAuth } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { trackControlPlaneAction } from "../internal/telemetry.js";

const PublicModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  context_window: z.number().nullable().optional(),
});

const ListModelsResponseSchema = z.object({
  models: z.array(PublicModelSchema),
});

interface OrgOpt {
  org?: string;
}

export function registerModelsCommand(program: Command): void {
  const models = program
    .command("models")
    .description("List public Understudy model options without supplier details.");

  models
    .command("list")
    .description("List routeable public Understudy model ids.")
    .option("--org <id>", "Org id to use (default: only org in credentials).")
    .action(async function (this: Command, opts: OrgOpt) {
      await runAction(this, () => runList(this, opts));
    });
}

async function runList(cmd: Command, opts: OrgOpt): Promise<void> {
  const auth = resolveAuth(opts.org);
  const res = await request(
    { url: `/admin/v1/orgs/${auth.orgId}/models`, orgId: auth.orgId },
    ListModelsResponseSchema,
  );
  trackControlPlaneAction({
    resource: "models",
    action: "listed",
    orgId: auth.orgId,
    resultCount: res.data.models.length,
  });

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(res.data)}\n`);
    return;
  }

  if (res.data.models.length === 0) {
    process.stdout.write(`${kleur.gray("No public Understudy models are currently available for this org.")}\n`);
    return;
  }

  const rows = res.data.models.map((model) => ({
    id: model.id,
    name: model.name ?? "",
    capabilities: model.capabilities?.join(",") ?? "",
    context_window: model.context_window == null ? "" : String(model.context_window),
  }));
  const headers = ["id", "name", "capabilities", "context_window"];
  const widths = headers.map((h) =>
    Math.max(
      h.length,
      ...rows.map((r) => r[h as keyof typeof r].length),
    ),
  );
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  process.stdout.write(`${headers.map((h, i) => kleur.bold(pad(h, widths[i]!))).join("  ")}\n`);
  for (const r of rows) {
    process.stdout.write(`${headers.map((h, i) => pad(r[h as keyof typeof r], widths[i]!)).join("  ")}\n`);
  }
}
