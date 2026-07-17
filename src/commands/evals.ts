import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

export function registerEvalsCommand(program: Command): void {
  const evals = program.command("evals")
    .description("Select, freeze, and materialize workload-scoped evaluation cohorts.");

  addWorkloadOptions(evals.command("catalog")
    .description("List redacted capture candidates for one workload.")
    .requiredOption("--from <iso>", "Inclusive ISO-8601 window start.")
    .requiredOption("--to <iso>", "Exclusive ISO-8601 window end (max 31 days).")
    .option("--limit <n>", "Candidate limit, max 500.", "50")
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

async function runCatalog(cmd: Command, opts: CatalogOpts): Promise<void> {
  const limit = Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error(`Expected --limit between 1 and 500, got: ${opts.limit}`);
  }
  if (opts.statusCode !== undefined) {
    const status = Number(opts.statusCode);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error(`Expected --status-code between 100 and 599, got: ${opts.statusCode}`);
    }
  }
  const { project, workload, base } = await resolveContext(opts);
  const params = new URLSearchParams({
    from: parseIsoOption("--from", opts.from),
    to: parseIsoOption("--to", opts.to),
    limit: String(limit),
    sample_seed: opts.seed,
  });
  if (opts.requestedModel) params.set("requested_model", opts.requestedModel);
  if (opts.servedModel) params.set("served_model", opts.servedModel);
  if (opts.statusCode) params.set("status_code", opts.statusCode);
  if (opts.requiresTools) params.set("requires_tools", "true");
  if (opts.requiresStructuredOutput) params.set("requires_structured_output", "true");
  const response = await request(
    { url: `${base}/eval-capture-catalog?${params}`, orgId: project.auth.orgId },
    CatalogResponseSchema,
  );
  const payload = {
    project_id: project.projectId,
    workload_id: workload.id,
    ...response.data,
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
  const outputDir = resolve(opts.out);
  mkdirSync(outputDir, { recursive: true });
  const files: Array<{ request_id: string; path: string; content_sha256: string }> = [];
  for (const capture of response.data.captures) {
    const download = await fetch(capture.url, { headers: { Accept: "application/x-ndjson" } });
    if (!download.ok) throw new Error(`Capture ${capture.request_id} download failed with status ${download.status}.`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== capture.content_sha256) throw new Error(`Capture ${capture.request_id} failed SHA-256 verification.`);
    const fileName = `${safeFileStem(capture.request_id)}.jsonl`;
    writeFileSync(join(outputDir, fileName), bytes);
    files.push({ request_id: capture.request_id, path: fileName, content_sha256: digest });
  }
  const localManifest = join(outputDir, "cohort-manifest.json");
  writeJson(localManifest, {
    schema_version: "understudy.eval-cohort-materialization.v1",
    cohort_id: response.data.cohort_id,
    cohort_sha256: response.data.cohort_sha256,
    workload_id: workload.id,
    capture_count: files.length,
    privacy: { local_only: true, upload_performed: false },
    captures: files,
  });
  const payload = { ok: true, output: outputDir, manifest: localManifest, count: files.length, cohort_sha256: response.data.cohort_sha256 };
  if (isJsonMode(cmd)) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else {
    process.stdout.write(`${kleur.green("✓")} Materialized ${files.length} frozen captures at ${outputDir}\n`);
    process.stdout.write(`${kleur.yellow("warning")}: files may contain prompts, completions, or tool payloads\n`);
  }
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

function safeFileStem(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error(`Unsafe request id: ${value}`);
  return safe;
}
