import { Command } from "commander";
import kleur from "kleur";
import { join } from "node:path";
import { z } from "zod";

import { request, resolveAuth } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { trackControlPlaneAction } from "../internal/telemetry.js";
import {
  DEFAULT_MODELS_DIR,
  fetchSnapshotCatalog,
  pullSnapshotModel,
  resolveSnapshotPlan,
  type SnapshotCatalog,
} from "../model-snapshots.js";
import {
  doctorMlxVlmRuntime,
  installMlxVlmRuntime,
  MLX_VLM_COMMIT,
  MLX_VLM_RUNTIME_VERSION,
  MLX_VLM_SOURCE,
  mlxVlmRuntimeStatus,
} from "../runtime/mlx-vlm/lifecycle.js";

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
    .action(async function (this: Command, opts: { json?: boolean }) {
      await runSnapshotList(this, opts);
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

  const runtime = models
    .command("runtime")
    .description("Manage the pinned local MLX/VLM engine used by Understudy Desktop.");

  runtime
    .command("version")
    .description("Print the managed MLX/VLM source and exact commit pin.")
    .option("--json", "Output JSON.")
    .action(function (this: Command, opts: { json?: boolean }) {
      const payload = {
        runtime_version: MLX_VLM_RUNTIME_VERSION,
        commit: MLX_VLM_COMMIT,
        source: MLX_VLM_SOURCE,
      };
      if (opts.json || isJsonMode(this)) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        process.stdout.write(`${MLX_VLM_RUNTIME_VERSION}\n${MLX_VLM_SOURCE}\n`);
      }
    });

  runtime
    .command("status")
    .description("Check whether the managed MLX/VLM engine is installed and compatible.")
    .option("--json", "Output JSON.")
    .action(function (this: Command, opts: { json?: boolean }) {
      const status = mlxVlmRuntimeStatus();
      if (opts.json || isJsonMode(this)) {
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      } else {
        const mark = status.healthy ? kleur.green("✓") : kleur.yellow("△");
        process.stdout.write(`${mark} ${status.detail}\n${kleur.gray(status.root)}\n`);
      }
      if (!status.healthy) process.exitCode = 1;
    });

  runtime
    .command("doctor")
    .description("Diagnose uv, runtime provenance, server import, and Gemma compatibility.")
    .option("--json", "Output JSON.")
    .action(function (this: Command, opts: { json?: boolean }) {
      const report = doctorMlxVlmRuntime();
      if (opts.json || isJsonMode(this)) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${kleur.bold("managed MLX/VLM doctor")}\n`);
        for (const check of report.checks) {
          const mark = check.ok ? kleur.green("✓") : kleur.red("✗");
          process.stdout.write(`${mark} ${check.name} — ${check.detail}\n`);
        }
        if (!report.ok) process.stdout.write(`repair: ${report.repair_command}\n`);
      }
      if (!report.ok) process.exitCode = 1;
    });

  for (const [name, description, force] of [
    ["install", "Install the exact managed MLX/VLM runtime into ~/.understudy.", false],
    ["repair", "Reinstall and verify the exact managed MLX/VLM runtime.", true],
  ] as const) {
    runtime
      .command(name)
      .description(description)
      .option("--json", "Output JSON.")
      .action(async function (this: Command, opts: { json?: boolean }) {
        await runAction(this, async () => {
          const report = await installMlxVlmRuntime({
            force,
            onLog: (line) => {
              if (!opts.json && !isJsonMode(this)) process.stdout.write(`${line}\n`);
            },
          });
          if (opts.json || isJsonMode(this)) {
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          } else {
            process.stdout.write(`${kleur.green("✓")} ${report.status.detail}\n`);
            process.stdout.write(`${kleur.gray(report.status.server_binary)}\n`);
          }
        });
      });
  }
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

function catalogSourceLabel(catalog: SnapshotCatalog): string {
  return catalog.source === "live" ? `live catalog (${catalog.url})` : "bundled fallback";
}

async function runSnapshotList(cmd: Command, opts: { json?: boolean }): Promise<void> {
  const catalog = await fetchSnapshotCatalog();
  const models = Object.entries(catalog.models).map(([id, info]) => ({
    id,
    name: info.name,
    short_name: info.shortName ?? null,
    approx_gb: info.approxGb,
    loader: info.loader,
    default: info.defaultRung === true,
    certified: info.certified === true,
  }));
  if (opts.json || isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify({ source: catalog.source, catalog_url: catalog.url, models }, null, 2)}\n`);
    return;
  }
  const headers = ["id", "approx_gb", "loader", "default", "short_name"];
  const rows = models.map((model) => ({
    id: model.id,
    approx_gb: model.approx_gb == null ? "" : String(model.approx_gb),
    loader: model.loader ?? "",
    default: model.default ? "yes" : "",
    short_name: model.short_name ?? "",
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
  process.stdout.write(`${kleur.gray(`source: ${catalogSourceLabel(catalog)}`)}\n`);
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
  const catalog = await fetchSnapshotCatalog();
  if (!opts.json && !isJsonMode(cmd)) {
    process.stdout.write(`${kleur.gray(`catalog: ${catalogSourceLabel(catalog)}`)}\n`);
  }
  const ids = opts.all ? Object.keys(catalog.models) : [model!];
  const results = [];
  for (const id of ids) {
    const modelInfo = catalog.models[id];
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
        catalog: catalog.models,
      });
      results.push(planned);
      continue;
    }
    const result = await pullSnapshotModel({
      modelId: id,
      dest,
      sessionUrl: opts.sessionUrl,
      logDir: opts.logDir,
      catalog: catalog.models,
      onLog: (line) => {
        if (!opts.json && !isJsonMode(cmd)) process.stdout.write(`${line}\n`);
      },
    });
    results.push(result);
  }

  if (opts.json || isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify({ catalog_source: catalog.source, models: results }, null, 2)}\n`);
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
