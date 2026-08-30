import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import { Command } from "commander";
import kleur from "kleur";

import { buildEvalProject } from "../eval-project.js";
import {
  acquireEvalBuildLease,
  assertBuildStateMatches,
  buildState,
  cohortFromResponse,
  creatingBuildState,
  initializeBuildCheckpoint,
  pathExists,
  readEvalBuildState,
  replacePrivateJson,
  writePrivateJson,
} from "../evals/build-state.js";
import {
  CatalogItemSchema,
  CatalogResponseSchema,
  CohortExportSchema,
  CohortSchema,
  type CatalogItem,
  type Cohort,
  type EvalBuildCreatingState,
  type EvalBuildIdentity,
  type EvalBuildSelection,
  type FrozenCohort,
} from "../evals/contracts.js";
import {
  assertEquivalentExport,
  assertExportLineage,
  downloadExport,
  EXPORT_EXPIRES_SECONDS,
} from "../evals/materialize.js";
import { request } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { resolveProject, type ProjectResolutionOptions } from "../internal/projects.js";
import { resolveWorkload } from "../internal/workloads.js";

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
interface BuildOpts extends Omit<GuidedCreateOpts, "download"> {
  maxAgeDays?: string;
  batchSize: string;
}

export function registerEvalsCommand(program: Command): void {
  const evals = program.command("evals")
    .description("Select, freeze, and materialize workload-scoped evaluation cohorts.");

  addWorkloadOptions(addRecentSelectionOptions(
    evals.command("create").description("Create a frozen eval set from a recent workload window."),
    "Cohort name.",
  )
    .option("--out <directory>", "Destination directory (default: .understudy/evals/<name>).")
    .option("--no-download", "Freeze the cohort without downloading trace bodies.")
    .option("--yes", "Approve freezing and local trace download without prompting."))
    .action(async function (this: Command, opts: GuidedCreateOpts) {
      await runAction(this, () => runGuidedCreate(this, opts));
    });

  addWorkloadOptions(addRecentSelectionOptions(
    evals.command("build").description("Build a private local draft eval project from a frozen workload cohort."),
    "Local eval project and cohort name.",
  )
    .option("--out <directory>", "Destination directory (default: .understudy/evals/<safe-name>).")
    .option("--max-age-days <days>", "Override freshness cutoff (must cover --last; default: derive from --last).")
    .option("--batch-size <count>", "Local trace-foundry processing batch size.", "10")
    .option("--yes", "Approve freezing and downloading payload-bearing traces without prompting."))
    .action(async function (this: Command, opts: BuildOpts) {
      await runAction(this, () => runBuild(this, opts));
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

function addRecentSelectionOptions(command: Command, nameDescription: string): Command {
  return command
    .requiredOption("--name <name>", nameDescription)
    .option("--description <text>", "Why these captures were selected.")
    .option("--last <duration>", "Recent window, such as 14d or 12h (max 31d).", "14d")
    .option("--limit <n>", "Candidate limit, max 100.", "50")
    .option("--seed <seed>", "Deterministic sample seed.", "understudy-eval-catalog-v1")
    .option("--requested-model <id>", "Filter by requested model.")
    .option("--served-model <id>", "Filter by served model.")
    .option("--status-code <code>", "Filter by HTTP status code.")
    .option("--requires-tools", "Require a trace containing tools.")
    .option("--requires-structured-output", "Require structured output.");
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
    materialized = await materializeCohort(
      catalog,
      cohort.id,
      cohort.cohort_sha256,
      opts.out ?? join(".understudy", "evals", safeFileStem(opts.name)),
      cohort.capture_count,
    );
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

async function runBuild(cmd: Command, opts: BuildOpts): Promise<void> {
  const batchSize = parsePositiveInteger("--batch-size", opts.batchSize);
  const windowMs = parseDuration(opts.last);
  const selectionDays = Math.ceil(windowMs / 86_400_000);
  const maxAgeDays = opts.maxAgeDays === undefined
    ? selectionDays
    : parsePositiveInteger("--max-age-days", opts.maxAgeDays);
  if (maxAgeDays < selectionDays) {
    throw new Error(`--max-age-days must cover --last (${selectionDays} day(s)).`);
  }
  const selection = buildSelectionFromOptions(opts);
  if (isJsonMode(cmd) && !opts.yes) {
    throw new Error("JSON mode cannot prompt. Re-run with --yes to approve freezing and local trace download.");
  }
  if (!opts.yes && !process.stdin.isTTY) {
    throw new Error("Non-interactive eval builds cannot prompt. Re-run with --yes to approve freezing and local trace download.");
  }
  const output = resolve(opts.out ?? join(".understudy", "evals", safeFileStem(opts.name)));
  if (pathExists(output)) {
    throw new Error(`Eval build destination already exists: ${output}. Choose a fresh --out directory.`);
  }
  const releaseLease = acquireEvalBuildLease(output);
  try {
    await runBuildWithLease(cmd, opts, { batchSize, windowMs, maxAgeDays, output, selection });
  } finally {
    releaseLease();
  }
}

async function runBuildWithLease(
  cmd: Command,
  opts: BuildOpts,
  build: { batchSize: number; windowMs: number; maxAgeDays: number; output: string; selection: EvalBuildSelection },
): Promise<void> {
  const { batchSize, windowMs, maxAgeDays, output, selection } = build;
  if (pathExists(output)) {
    throw new Error(`Eval build destination already exists: ${output}. Choose a fresh --out directory.`);
  }
  const staging = join(dirname(output), `.${basename(output)}.eval-build`);
  const pending = pathExists(staging) ? readEvalBuildState(staging) : null;
  const to = new Date();
  let context: Awaited<ReturnType<typeof resolveContext>>;
  let cohort: FrozenCohort;
  let identity: EvalBuildIdentity;

  if (pending) {
    context = await resolveContext(opts);
    const currentIdentity = identityFromContext(context);
    assertBuildStateMatches(pending, opts.name, currentIdentity, selection, maxAgeDays, batchSize);
    identity = pending.identity;
    if (pending.status === "cohort_creating") {
      const created = await createOrRecoverBuildCohort(context, pending);
      cohort = cohortFromResponse(created);
      replacePrivateJson(
        join(staging, "build-state.json"),
        buildState("cohort_frozen", opts.name, identity, cohort, selection, maxAgeDays, batchSize, new Date(pending.created_at)),
      );
    } else {
      cohort = pending.cohort;
    }
    if (!isJsonMode(cmd)) {
      process.stdout.write(`Resuming frozen cohort ${cohort.id} (${cohort.capture_count} captures).\n`);
    }
    if (!opts.yes) {
      const approved = await confirm({
        message: `Resume downloading ${cohort.capture_count} payload-bearing captures for local draft “${opts.name}” (16 MiB each, 256 MiB total maximum)?`,
        default: false,
      });
      if (!approved) throw new Error("Eval build resume cancelled before payload download.");
    }
  } else {
    const from = new Date(to.getTime() - windowMs);
    const catalog = await fetchCatalog(opts, from.toISOString(), to.toISOString());
    if (catalog.response.captures.length === 0) {
      throw new Error(`No eligible captures found for ${catalog.workload.name} in the last ${opts.last}.`);
    }
    if (!isJsonMode(cmd)) printCatalogSummary(catalog.workload.name, catalog.response.captures);
    if (!opts.yes) {
      const approved = await confirm({
        message: `Freeze these ${catalog.response.captures.length} captures and download their payloads to build local draft “${opts.name}”? The files may contain prompts, completions, and tool payloads (16 MiB each, 256 MiB total maximum).`,
        default: false,
      });
      if (!approved) throw new Error("Eval build cancelled before payload download.");
    }
    context = catalog;
    identity = identityFromContext(context);
    const creating = creatingBuildState(opts.name, opts.description, identity, catalog.response, selection, maxAgeDays, batchSize, to);
    initializeBuildCheckpoint(staging, creating);
    const created = await createOrRecoverBuildCohort(context, creating);
    cohort = cohortFromResponse(created);
    replacePrivateJson(
      join(staging, "build-state.json"),
      buildState("cohort_frozen", opts.name, identity, cohort, selection, maxAgeDays, batchSize, to),
    );
  }

  const attempts = join(staging, "attempts");
  // An interrupted process may have left payload-bearing partial attempts.
  // The frozen cohort state lives outside this directory, so retries can
  // safely clear them instead of accumulating customer data.
  rmSync(attempts, { recursive: true, force: true });
  mkdirSync(attempts, { recursive: true, mode: 0o700 });
  chmodSync(attempts, 0o700);
  const attempt = mkdtempSync(join(attempts, "attempt-"));
  chmodSync(attempt, 0o700);
  const buildNow = pending ? new Date(pending.created_at) : to;
  let published = false;
  let project!: ReturnType<typeof buildEvalProject>;
  try {
    const materialized = await materializeCohort(
      context,
      cohort.id,
      cohort.cohort_sha256,
      join(attempt, "captures"),
      cohort.capture_count,
    );
    project = buildEvalProject({
      output: attempt,
      identity: {
        orgId: identity.org_id,
        projectId: identity.project_id,
        workloadId: identity.workload_id,
        workloadName: identity.workload_name,
      },
      cohort: {
        id: cohort.id,
        cohortSha256: cohort.cohort_sha256,
        captureCount: cohort.capture_count,
        materializationManifest: materialized.manifest,
      },
      maxAgeDays,
      batchSize,
      now: buildNow,
    });
    writePrivateJson(join(attempt, "build-state.json"), buildState("complete", opts.name, identity, cohort, selection, maxAgeDays, batchSize, buildNow));
    renameSync(attempt, output);
    published = true;
  } finally {
    if (!published) rmSync(attempt, { recursive: true, force: true });
  }
  rmSync(staging, { recursive: true, force: true });
  project.project_file = join(output, "eval-project.json");

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(project)}\n`);
  } else {
    process.stdout.write(`${kleur.green("✓")} Created local draft eval project at ${output}\n`);
    process.stdout.write(`Project manifest: ${project.project_file}\n`);
    process.stdout.write(`Review viewer: ${join(output, project.foundry.artifacts.viewer)}\n`);
    process.stdout.write(`${kleur.yellow("warning")}: local files contain prompts, completions, or tool payloads; nothing was uploaded and no model provider was called\n`);
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
    { url: `${base}/eval-capture-catalog?${params}`, orgId: project.auth.orgId, signal: AbortSignal.timeout(60_000) },
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
    signal: AbortSignal.timeout(60_000),
    body: {
      name,
      selection: { source: "explicit_capture_references", description, sampling_seed: context.response.selection.sample_seed },
      captures: context.response.captures.map(({ capture_key, request_id, content_sha256 }) => ({ capture_key, request_id, content_sha256 })),
    },
  }, CohortSchema);
  return response.data;
}

async function createOrRecoverBuildCohort(
  context: Awaited<ReturnType<typeof resolveContext>>,
  state: EvalBuildCreatingState,
): Promise<Cohort> {
  let response: { data: Cohort } | null = null;
  let createError: unknown;
  for (let attempt = 0; attempt < 2 && response === null; attempt += 1) {
    try {
      response = await request({
        url: `${context.base}/eval-cohorts`,
        method: "POST",
        orgId: context.project.auth.orgId,
        signal: AbortSignal.timeout(60_000),
        body: state.create_request,
      }, CohortSchema);
    } catch (error) {
      createError = error;
    }
  }
  if (response === null) throw createError;
  const cohort = response.data;
  if (
    cohort.operation_id !== state.create_request.operation_id ||
    cohort.org_id !== context.project.auth.orgId ||
    cohort.project_id !== context.project.projectId ||
    cohort.workload_id !== context.workload.id ||
    cohort.capture_count !== state.create_request.captures.length
  ) {
    throw new Error(`Created cohort ${cohort.id} does not match the persisted eval build selection.`);
  }
  return cohort;
}

async function materializeCohort(
  context: Awaited<ReturnType<typeof resolveContext>>,
  cohortId: string,
  expectedCohortSha256: string,
  out: string,
  expectedCaptureCount: number,
) {
  const createExport = async () => {
    const response = await request(
      {
        url: `${context.base}/eval-cohorts/${encodeURIComponent(cohortId)}/export`,
        method: "POST",
        body: { expires_seconds: EXPORT_EXPIRES_SECONDS },
        orgId: context.project.auth.orgId,
        signal: AbortSignal.timeout(60_000),
      },
      CohortExportSchema,
    );
    assertExportLineage(response.data, cohortId, expectedCohortSha256);
    if (response.data.captures.length !== expectedCaptureCount) {
      throw new Error(`Cohort export count ${response.data.captures.length} does not match frozen cohort count ${expectedCaptureCount}.`);
    }
    return response.data;
  };
  const exportData = await createExport();
  return downloadExport(exportData, context.workload.id, out, context.project.auth.gatewayUrl, createExport);
}

function printCatalogSummary(workloadName: string, captures: CatalogItem[]): void {
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
  const createExport = async () => {
    const response = await request(
      {
        url: `${base}/eval-cohorts/${encodeURIComponent(cohortId)}/export`,
        method: "POST",
        body: { expires_seconds: EXPORT_EXPIRES_SECONDS },
        orgId: project.auth.orgId,
        signal: AbortSignal.timeout(60_000),
      },
      CohortExportSchema,
    );
    if (response.data.cohort_id !== cohortId) throw new Error(`Cohort export lineage does not match requested cohort ${cohortId}.`);
    return response.data;
  };
  const firstExport = await createExport();
  const payload = await downloadExport(firstExport, workload.id, opts.out, project.auth.gatewayUrl, async () => {
    const refreshed = await createExport();
    assertEquivalentExport(firstExport, refreshed);
    return refreshed;
  });
  if (isJsonMode(cmd)) process.stdout.write(`${JSON.stringify({ ok: true, ...payload })}\n`);
  else {
    process.stdout.write(`${kleur.green("✓")} Materialized ${payload.count} frozen captures at ${payload.output}\n`);
    process.stdout.write(`${kleur.yellow("warning")}: files may contain prompts, completions, or tool payloads\n`);
  }
}

function writeJson(path: string, value: unknown): void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(absolute, 0o600);
}

function identityFromContext(context: Awaited<ReturnType<typeof resolveContext>>) {
  return {
    org_id: context.project.auth.orgId,
    project_id: context.project.projectId,
    workload_id: context.workload.id,
    workload_name: context.workload.name,
  };
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

function buildSelectionFromOptions(opts: BuildOpts): EvalBuildSelection {
  const limit = parseLimit(opts.limit);
  validateStatusCode(opts.statusCode);
  return {
    last: opts.last,
    limit,
    seed: opts.seed,
    description: opts.description ?? null,
    requested_model: opts.requestedModel ?? null,
    served_model: opts.servedModel ?? null,
    status_code: opts.statusCode === undefined ? null : Number(opts.statusCode),
    requires_tools: opts.requiresTools ?? false,
    requires_structured_output: opts.requiresStructuredOutput ?? false,
  };
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

function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function safeFileStem(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error(`Unsafe request id: ${value}`);
  return safe;
}
