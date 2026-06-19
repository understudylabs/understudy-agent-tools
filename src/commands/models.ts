import { Command } from "commander";
import kleur from "kleur";
import { join } from "node:path";
import { z } from "zod";

import { request, resolveAuth } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { trackControlPlaneAction } from "../internal/telemetry.js";
import {
  DEFAULT_MODELS_DIR,
  VERIFIED_SNAPSHOT_MODELS,
  pullSnapshotModel,
  resolveSnapshotPlan,
  snapshotModelIds,
} from "../model-snapshots.js";

const PublicModelSchema = z.object({
  id: z.string(),
  display_name: z.string().optional(),
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

interface PullOpts {
  all?: boolean;
  dest?: string;
  dryRun?: boolean;
  sessionUrl?: string;
  logDir?: string;
  json?: boolean;
}

export function registerModelsCommand(program: Command): void {
  const models = program
    .command("models")
    .description("List routeable models and manage local Understudy model snapshots.");

  models
    .command("list")
    .description("List routeable public Understudy model ids.")
    .option("--org <id>", "Org id to use (default: only org in credentials).")
    .action(async function (this: Command, opts: OrgOpt) {
      await runAction(this, () => runList(this, opts));
    });

  models
    .command("snapshots")
    .description("List downloadable local Understudy model snapshots.")
    .option("--json", "Output JSON.")
    .action(function (this: Command, opts: { json?: boolean }) {
      runSnapshotList(this, opts);
    });

  models
    .command("pull [model]")
    .description("Download verified local model snapshot files from models.understudylabs.com.")
    .option("--all", "Pull every verified snapshot model in the CLI catalog.")
    .option("--dest <path>", "Destination dir. With --all, this is the model cache root.", DEFAULT_MODELS_DIR)
    .option("--dry-run", "Print the pull plan without downloading.")
    .option("--session-url <url>", "Custom signed session URL for one model.")
    .option("--log-dir <path>", "Directory for pull logs.")
    .option("--json", "Output JSON.")
    .action(async function (this: Command, model: string | undefined, opts: PullOpts) {
      await runAction(this, () => runPull(this, model, opts));
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
    name: model.display_name ?? model.name ?? "",
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

function runSnapshotList(cmd: Command, opts: { json?: boolean }): void {
  const models = snapshotModelIds().map((id) => ({
    id,
    name: VERIFIED_SNAPSHOT_MODELS[id]?.name ?? id,
    approx_gb: VERIFIED_SNAPSHOT_MODELS[id]?.approxGb ?? null,
    loader: VERIFIED_SNAPSHOT_MODELS[id]?.loader ?? null,
    default: VERIFIED_SNAPSHOT_MODELS[id]?.defaultRung === true,
  }));
  if (opts.json || isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify({ models }, null, 2)}\n`);
    return;
  }
  const headers = ["id", "approx_gb", "loader", "default"];
  const rows = models.map((model) => ({
    id: model.id,
    approx_gb: model.approx_gb == null ? "" : String(model.approx_gb),
    loader: model.loader ?? "",
    default: model.default ? "yes" : "",
  }));
  const widths = headers.map((h) =>
    Math.max(
      h.length,
      ...rows.map((r) => r[h as keyof typeof r].length),
    ),
  );
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  process.stdout.write(`${headers.map((h, i) => kleur.bold(pad(h, widths[i]!))).join("  ")}\n`);
  for (const row of rows) {
    process.stdout.write(`${headers.map((h, i) => pad(row[h as keyof typeof row], widths[i]!)).join("  ")}\n`);
  }
}

async function runPull(cmd: Command, model: string | undefined, opts: PullOpts): Promise<void> {
  if (opts.all && model) {
    throw new Error("Pass either a model id or --all, not both.");
  }
  if (opts.all && opts.sessionUrl) {
    throw new Error("--session-url can only be used with one model id.");
  }
  if (!opts.all && !model) {
    throw new Error("Usage: understudy models pull <model-id> or understudy models pull --all");
  }
  const ids = opts.all ? snapshotModelIds() : [model!];
  const results = [];
  for (const id of ids) {
    const modelInfo = VERIFIED_SNAPSHOT_MODELS[id];
    const dest = opts.all
      ? join(opts.dest ?? DEFAULT_MODELS_DIR, modelInfo?.destName ?? id)
      : opts.dest === DEFAULT_MODELS_DIR
        ? undefined
        : opts.dest;
    if (opts.dryRun) {
      const planned = resolveSnapshotPlan({
        modelId: id,
        dest,
        sessionUrl: opts.sessionUrl,
        logDir: opts.logDir,
        dryRun: true,
      });
      results.push(planned);
      continue;
    }
    const result = await pullSnapshotModel({
      modelId: id,
      dest,
      sessionUrl: opts.sessionUrl,
      logDir: opts.logDir,
      onLog: (line) => {
        if (!opts.json && !isJsonMode(cmd)) process.stdout.write(`${line}\n`);
      },
    });
    results.push(result);
  }

  if (opts.json || isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify({ models: results }, null, 2)}\n`);
    return;
  }
  if (opts.dryRun) {
    for (const result of results) {
      process.stdout.write(`dry-run ${result.model}\n`);
      process.stdout.write(`  session: ${result.sessionUrl}\n`);
      process.stdout.write(`  dest: ${result.dest}\n`);
      process.stdout.write(`  log: ${result.logFile}\n`);
    }
    return;
  }
  for (const result of results) {
    process.stdout.write(`pulled ${result.model}\n`);
    process.stdout.write(`  dest: ${result.dest}\n`);
    process.stdout.write(`  files: ${result.files}\n`);
    process.stdout.write(`  log: ${result.logFile}\n`);
  }
}
