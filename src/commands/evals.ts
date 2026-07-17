import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import { Command } from "commander";
import kleur from "kleur";
import { z } from "zod";

import { request } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { resolveProject, type ProjectResolutionOptions } from "../internal/projects.js";
import { resolveWorkload } from "../internal/workloads.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CatalogItemSchema = z.object({
  capture_key: z.string(),
  request_id: z.string(),
  content_sha256: Sha256Schema,
  captured_at: z.string(),
  provider: z.string(),
  requested_model: z.string(),
  served_model: z.string(),
  status_code: z.number().int(),
  latency_ms: z.number().nonnegative(),
  has_tools: z.boolean(),
  has_structured_output: z.boolean(),
});
const CatalogResponseSchema = z.object({
  captures: z.array(CatalogItemSchema),
  selection: z.object({
    from: z.string(),
    to: z.string(),
    limit: z.number().int().positive(),
    sample_seed: z.string(),
    requested_model: z.string().nullable(),
    served_model: z.string().nullable(),
    status_code: z.number().int().nullable(),
    requires_tools: z.boolean(),
    requires_structured_output: z.boolean(),
  }),
});
const CohortSchema = z.object({
  id: z.string(),
  workload_id: z.string(),
  name: z.string(),
  capture_count: z.number().int().positive(),
  cohort_sha256: Sha256Schema,
  created_at: z.string(),
}).passthrough();
const CohortExportSchema = z.object({
  export_id: z.string(),
  cohort_id: z.string(),
  cohort_sha256: Sha256Schema,
  expires_at: z.string(),
  captures: z.array(z.object({
    request_id: z.string(),
    content_sha256: Sha256Schema,
    url: z.string().url(),
  })).min(1).max(500),
});

interface WorkloadOpts extends ProjectResolutionOptions {
  workload: string;
}
interface CatalogOpts extends WorkloadOpts {
  from: string;
  to: string;
  limit: string;
  seed: string;
  requestedModel?: string;
  servedModel?: string;
  statusCode?: string;
  requiresTools?: boolean;
  requiresStructuredOutput?: boolean;
  out?: string;
}
interface CohortCreateOpts extends WorkloadOpts {
  fromCatalog: string;
  name: string;
  description?: string;
}
interface CohortExportOpts extends WorkloadOpts {
  out: string;
  yes?: boolean;
}
interface GuidedCreateOpts extends WorkloadOpts {
  name: string;
  description?: string;
  last: string;
  limit: string;
  seed: string;
  requestedModel?: string;
  servedModel?: string;
  statusCode?: string;
  requiresTools?: boolean;
  requiresStructuredOutput?: boolean;
  out?: string;
  download: boolean;
  yes?: boolean;
}

export function registerEvalsCommand(program: Command): void {
  const evals = program.command("evals")
    .description("Select, freeze, and materialize workload-scoped evaluation cohorts.");

  addWorkloadOptions(evals.command("create")
    .description("Create a frozen eval set from a recent workload window.")
    .requiredOption("--name <name>", "Cohort name.")
    .option("--description <text>", "Why these captures were selected.")
    .option("--last <duration>", "Recent window, such as 14d or 12h (max 31d).", "14d")
    .option("--limit <n>", "Candidate limit, max 100.", "50")
    .option("--seed <seed>", "Deterministic sample seed.", "understudy-eval-catalog-v1")
    .option("--requested-model <id>", "Filter by requested model.")
    .option("--served-model <id>", "Filter by served model.")
    .option("--status-code <code>", "Filter by HTTP status code.")
    .option("--requires-tools", "Require a trace containing tools.")
    .option("--requires-structured-output", "Require structured output.")
    .option("--out <directory>", "Destination directory (default: .understudy/evals/<name>).")
    .option("--no-download", "Freeze the cohort without downloading trace bodies.")
    .option("--yes", "Approve freezing and local trace download without prompting."))
    .action(async function (this: Command, opts: GuidedCreateOpts) {
      await runAction(this, () => runGuidedCreate(this, opts));
    });

  addWorkloadOptions(evals.command("catalog")
    .description("List redacted capture candidates for one workload.")
    .requiredOption("--from <iso>", "Inclusive ISO-8601 window start.")
    .requiredOption("--to <iso>", "Exclusive ISO-8601 window end (max 31 days).")
    .option("--limit <n>", "Candidate limit, max 100.", "50")
    .option("--seed <seed>", "Deterministic sample seed.", "understudy-eval-catalog-v1")
    .option("--requested-model <id>", "Filter by requested model.")
    .option("--served-model <id>", "Filter by served model.")
    .option("--status-code <code>", "Filter by HTTP status code.")
    .option("--requires-tools", "Require a trace containing tools.")
    .option("--requires-structured-output", "Require structured output.")
    .option("--out <path>", "Also write the redacted catalog to a local JSON file."))
    .action(async function (this: Command, opts: CatalogOpts) {
      await runAction(this, () => runCatalog(this, opts));
    });

  const cohort = evals.command("cohort").description("Create or materialize immutable cohorts.");
  addWorkloadOptions(cohort.command("create")
    .description("Freeze an exact cohort from a saved redacted catalog.")
    .requiredOption("--from-catalog <path>", "Catalog JSON written by `understudy evals catalog --out`.")
    .requiredOption("--name <name>", "Cohort name.")
    .option("--description <text>", "Why these captures were selected."))
    .action(async function (this: Command, opts: CohortCreateOpts) {
      await runAction(this, () => runCohortCreate(this, opts));
    });

  addWorkloadOptions(cohort.command("export <cohort-id>")
    .description("Download one frozen cohort to a local gitignored directory.")
    .requiredOption("--out <directory>", "Destination directory under .understudy/.")
    .option("--yes", "Confirm files may contain prompts, completions, and tool payloads."))
    .action(async function (this: Command, cohortId: string, opts: CohortExportOpts) {
      await runAction(this, () => runCohortExport(this, cohortId, opts));
    });
}

function addWorkloadOptions(command: Command): Command {
  return command
    .requiredOption("--workload <name-or-id>", "Workload name or id.")
    .option("--project-id <id>", "Project id from `understudy projects list --json`.")
    .option("--project <slug>", "Project slug to resolve to an id.")
    .option("--org <id>", "Org id (default: local config or only credential org).");
}

async function resolveContext(opts: WorkloadOpts) {
  const project = await resolveProject(opts);
  const workload = await resolveWorkload(project, opts.workload);
  const base = `/admin/v1/orgs/${project.auth.orgId}/projects/${encodeURIComponent(project.projectId)}/workloads/${encodeURIComponent(workload.id)}`;
  return { project, workload, base };
}

async function runGuidedCreate(cmd: Command, opts: GuidedCreateOpts): Promise<void> {
  if (isJsonMode(cmd) && !opts.yes) {
    throw new Error("JSON mode cannot prompt. Re-run with --yes to approve freezing and local trace download.");
  }
  const windowMs = parseDuration(opts.last);
  const to = new Date();
  const from = new Date(to.getTime() - windowMs);
  const catalog = await fetchCatalog(opts, from.toISOString(), to.toISOString());
  if (catalog.response.captures.length === 0) {
    throw new Error(`No eligible captures found for ${catalog.workload.name} in the last ${opts.last}.`);
  }

  if (!isJsonMode(cmd)) {
    printCatalogSummary(catalog.workload.name, catalog.response.captures);
  }
  if (!opts.yes) {
    const approved = await confirm({
      message: `Freeze these ${catalog.response.captures.length} captures as “${opts.name}”?`,
      default: true,
    });
    if (!approved) throw new Error("Cohort creation cancelled.");
  }

  const cohort = await createCohort(catalog, opts.name, opts.description);
  let materialized: Awaited<ReturnType<typeof materializeCohort>> | undefined;
  let shouldDownload = opts.download;
  if (shouldDownload) {
    if (!opts.yes) {
      shouldDownload = await confirm({
        message: "Download trace bodies locally? They may contain prompts, completions, and tool payloads.",
        default: false,
      });
    }
  }
  if (shouldDownload) {
    materialized = await materializeCohort(catalog, cohort.id, opts.out ?? join(".understudy", "evals", safeFileStem(opts.name)));
  }

  const payload = {
    ok: true,
    project_id: catalog.project.projectId,
    workload_id: catalog.workload.id,
    selection: catalog.response.selection,
    cohort,
    materialized,
  };
  if (isJsonMode(cmd)) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else {
    process.stdout.write(`${kleur.green("✓")} Froze cohort ${cohort.id} (${cohort.capture_count} captures).\n`);
    if (materialized) {
      process.stdout.write(`${kleur.green("✓")} Materialized verified traces at ${materialized.output}\n`);
      process.stdout.write(`${kleur.yellow("warning")}: files may contain prompts, completions, or tool payloads\n`);
    }
  }
}

async function fetchCatalog(opts: Omit<CatalogOpts, "from" | "to">, from: string, to: string) {
  const limit = parseLimit(opts.limit);
  validateStatusCode(opts.statusCode);
  const { project, workload, base } = await resolveContext(opts);
  const params = new URLSearchParams({ from, to, limit: String(limit), sample_seed: opts.seed });
  if (opts.requestedModel) params.set("requested_model", opts.requestedModel);
  if (opts.servedModel) params.set("served_model", opts.servedModel);
  if (opts.statusCode) params.set("status_code", opts.statusCode);
  if (opts.requiresTools) params.set("requires_tools", "true");
  if (opts.requiresStructuredOutput) params.set("requires_structured_output", "true");
  const response = await request(
    { url: `${base}/eval-capture-catalog?${params}`, orgId: project.auth.orgId },
    CatalogResponseSchema,
  );
  return { project, workload, base, response: response.data };
}

async function createCohort(
  context: Awaited<ReturnType<typeof fetchCatalog>>,
  name: string,
  description?: string,
) {
  const response = await request({
    url: `${context.base}/eval-cohorts`, method: "POST", orgId: context.project.auth.orgId,
    body: {
      name,
      selection: { source: "explicit_capture_references", description, sampling_seed: context.response.selection.sample_seed },
      captures: context.response.captures.map(({ capture_key, request_id, content_sha256 }) => ({ capture_key, request_id, content_sha256 })),
    },
  }, CohortSchema);
  return response.data;
}

async function materializeCohort(
  context: Awaited<ReturnType<typeof fetchCatalog>>,
  cohortId: string,
  out: string,
) {
  const response = await request(
    { url: `${context.base}/eval-cohorts/${encodeURIComponent(cohortId)}/export`, method: "POST", body: {}, orgId: context.project.auth.orgId },
    CohortExportSchema,
  );
  return downloadExport(response.data, context.workload.id, out);
}

function printCatalogSummary(workloadName: string, captures: z.infer<typeof CatalogItemSchema>[]): void {
  const models = new Set(captures.map((capture) => capture.served_model));
  const errors = captures.filter((capture) => capture.status_code >= 400).length;
  const tools = captures.filter((capture) => capture.has_tools).length;
  process.stdout.write(`Found ${captures.length} eligible captures for ${workloadName}: ${models.size} served model(s), ${errors} error(s), ${tools} with tools.\n`);
}

async function runCatalog(cmd: Command, opts: CatalogOpts): Promise<void> {
  const { project, workload, response } = await fetchCatalog(
    opts,
    parseIsoOption("--from", opts.from),
    parseIsoOption("--to", opts.to),
  );
  const payload = {
    project_id: project.projectId,
    workload_id: workload.id,
    ...response,
  };
  if (opts.out) {
    writeJson(opts.out, payload);
  }
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stdout.write(`${kleur.green("✓")} Found ${payload.captures.length} eligible captures for ${workload.name}.\n`);
    if (opts.out) process.stdout.write(`Saved redacted catalog: ${resolve(opts.out)}\n`);
  }
}

async function runCohortCreate(cmd: Command, opts: CohortCreateOpts): Promise<void> {
  const catalog = CatalogResponseSchema.parse(JSON.parse(readFileSync(opts.fromCatalog, "utf8")));
  if (catalog.captures.length === 0) throw new Error("The saved catalog has no captures to freeze.");
  const { project, workload, base } = await resolveContext(opts);
  const response = await request(
    {
      url: `${base}/eval-cohorts`,
      method: "POST",
      orgId: project.auth.orgId,
      body: {
        name: opts.name,
        selection: {
          source: "explicit_capture_references",
          description: opts.description,
          sampling_seed: catalog.selection.sample_seed,
        },
        captures: catalog.captures.map((capture) => ({
          capture_key: capture.capture_key,
          request_id: capture.request_id,
          content_sha256: capture.content_sha256,
        })),
      },
    },
    CohortSchema,
  );
  const payload = { ok: true, project_id: project.projectId, workload_id: workload.id, cohort: response.data };
  if (isJsonMode(cmd)) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else process.stdout.write(`${kleur.green("✓")} Froze cohort ${response.data.id} (${response.data.capture_count} captures, sha256=${response.data.cohort_sha256}).\n`);
}

async function runCohortExport(cmd: Command, cohortId: string, opts: CohortExportOpts): Promise<void> {
  if (!opts.yes) {
    throw new Error("Cohort files may contain prompts/completions. Re-run with --yes to download them locally.");
  }
  const { project, workload, base } = await resolveContext(opts);
  const response = await request(
    { url: `${base}/eval-cohorts/${encodeURIComponent(cohortId)}/export`, method: "POST", body: {}, orgId: project.auth.orgId },
    CohortExportSchema,
  );
  const payload = await downloadExport(response.data, workload.id, opts.out);
  if (isJsonMode(cmd)) process.stdout.write(`${JSON.stringify({ ok: true, ...payload })}\n`);
  else {
    process.stdout.write(`${kleur.green("✓")} Materialized ${payload.count} frozen captures at ${payload.output}\n`);
    process.stdout.write(`${kleur.yellow("warning")}: files may contain prompts, completions, or tool payloads\n`);
  }
}

async function downloadExport(exportData: z.infer<typeof CohortExportSchema>, workloadId: string, out: string) {
  const outputDir = resolve(out);
  mkdirSync(outputDir, { recursive: true });
  const files: Array<{ request_id: string; path: string; content_sha256: string }> = [];
  const fileNames = new Set<string>();
  for (const capture of exportData.captures) {
    const download = await fetch(capture.url, { headers: { Accept: "application/x-ndjson" } });
    if (!download.ok) throw new Error(`Capture ${capture.request_id} download failed with status ${download.status}.`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== capture.content_sha256) throw new Error(`Capture ${capture.request_id} failed SHA-256 verification.`);
    const stem = safeFileStem(capture.request_id);
    let fileName = `${stem}.jsonl`;
    if (fileNames.has(fileName)) fileName = `${stem}-${capture.content_sha256.slice(0, 12)}.jsonl`;
    if (fileNames.has(fileName)) throw new Error(`Capture ${capture.request_id} collides with another local filename.`);
    fileNames.add(fileName);
    writeFileSync(join(outputDir, fileName), bytes);
    files.push({ request_id: capture.request_id, path: fileName, content_sha256: digest });
  }
  const localManifest = join(outputDir, "cohort-manifest.json");
  writeJson(localManifest, {
    schema_version: "understudy.eval-cohort-materialization.v1",
    cohort_id: exportData.cohort_id,
    cohort_sha256: exportData.cohort_sha256,
    workload_id: workloadId,
    capture_count: files.length,
    privacy: { local_only: true, upload_performed: false },
    captures: files,
  });
  return { output: outputDir, manifest: localManifest, count: files.length, cohort_sha256: exportData.cohort_sha256 };
}

function writeJson(path: string, value: unknown): void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseIsoOption(name: string, value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be an ISO-8601 timestamp.`);
  return date.toISOString();
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(`Expected --limit between 1 and 100, got: ${value}`);
  }
  return limit;
}

function validateStatusCode(value?: string): void {
  if (value === undefined) return;
  const status = Number(value);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`Expected --status-code between 100 and 599, got: ${value}`);
  }
}

function parseDuration(value: string): number {
  const match = /^(\d+)(h|d)$/.exec(value);
  if (!match) throw new Error("--last must be a duration such as 12h or 14d.");
  const amount = Number(match[1]);
  const durationMs = amount * (match[2] === "d" ? 86_400_000 : 3_600_000);
  if (amount < 1 || durationMs > 31 * 86_400_000) {
    throw new Error("--last must be between 1h and 31d.");
  }
  return durationMs;
}

function safeFileStem(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error(`Unsafe request id: ${value}`);
  return safe;
}
