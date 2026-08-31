import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import { Command } from "commander";
import kleur from "kleur";

import { buildWorkloadEvalProject, type WorkloadEvalProjectBuildResult } from "../eval-project.js";
import { runEvalCheck } from "../evals/check.js";
import { previewEvalPublication, publishEvalRelease } from "../evals/publish.js";
import {
  acquireEvalBuildLease,
  assertWorkloadBuildStateMatches,
  creatingWorkloadBuildState,
  ensureUnderstudyGitExcluded,
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
  EvalWorkloadBuildStateSchema,
  VerifyWorkloadCaptureExportReceiptResponseSchema,
  WorkloadCaptureExportResponseSchema,
  type CatalogItem,
  type EvalWorkloadBuildState,
  type WorkloadCaptureExportResponse,
  type WorkloadCaptureExportScope,
} from "../evals/contracts.js";
import {
  assertEquivalentExport,
  assertExportLineage,
  downloadExport,
  EXPORT_EXPIRES_SECONDS,
  materializeWorkloadExportSegment,
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
interface BuildOpts extends WorkloadOpts {
  name: string;
  last: string;
  out?: string;
  yes?: boolean;
  maxAgeDays?: string;
  batchSize: string;
}
interface CheckOpts {
  project: string;
}
interface PublishOpts {
  project: string;
  preview?: boolean;
  expectReleaseId?: string;
}

export function registerEvalsCommand(program: Command): void {
  const evals = program.command("evals")
    .description("Build, check, publish, and manage workload-scoped evaluations for coding agents.");

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

  addWorkloadOptions(evals.command("build")
    .description("Download a complete seven-day workload source for a coding agent to turn into an eval.")
    .requiredOption("--name <name>", "Local eval project name.")
    .option("--last <duration>", "Complete capture window (currently exactly 7d).", "7d")
    .option("--out <directory>", "Destination directory (default: .understudy/evals/<safe-name>).")
    .option("--max-age-days <days>", "Record the source freshness horizon (default: 7).")
    .option("--batch-size <count>", "Record the coding-agent processing batch size.", "10")
    .option("--yes", "Approve downloading payload-bearing traces without prompting."))
    .action(async function (this: Command, opts: BuildOpts) {
      await runAction(this, () => runBuild(this, opts));
    });

  evals.command("check")
    .description("Check a locally authored eval, its verifier fixtures, artifact hashes, and owner approvals without a model call.")
    .option("--project <directory>", "Eval project directory containing eval-project.json.", ".")
    .action(async function (this: Command, opts: CheckOpts) {
      await runAction(this, () => runCheck(this, opts));
    });

  evals.command("publish")
    .description("Publish a final owner-approved eval release without uploading its raw source traces.")
    .option("--project <directory>", "Eval project directory containing eval-project.json.", ".")
    .option("--preview", "Prepare and print the exact manifest and bundle inventory without uploading.")
    .option("--expect-release-id <id>", "Upload only when the prepared release still matches this preview identity.")
    .action(async function (this: Command, opts: PublishOpts) {
      await runAction(this, () => runPublish(this, opts));
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

async function runCheck(cmd: Command, opts: CheckOpts): Promise<void> {
  const result = await runEvalCheck(resolve(opts.project));
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`${kleur.green("✓")} Eval schemas, source hashes, representative replay, oracle, and wrong-answer rejection passed.\n`);
  process.stdout.write(`Check report: ${result.report_file}\n`);
  process.stdout.write(`Lineage: ${result.coverage.lineage.complete} complete, ${result.coverage.lineage.ambiguous} ambiguous, ${result.coverage.lineage.unlinked} unlinked.\n`);
  const acceptedGaps = [...result.coverage.execution_modes, ...result.coverage.failure_classes]
    .filter((entry) => entry.disposition === "owner_accepted_uncovered")
    .map((entry) => `${entry.name} (${entry.observed_count})`);
  process.stdout.write(`Owner-accepted coverage gaps: ${acceptedGaps.length > 0 ? acceptedGaps.join(", ") : "none"}.\n`);
  process.stdout.write(`Verifier feedback: representative — ${result.report.representative_replay.feedback}; oracle — ${result.report.oracle_fixture.feedback}; wrong answer — ${result.report.wrong_fixture.feedback}.\n`);
  process.stdout.write("Approval hashes:\n");
  for (const [name, value] of Object.entries(result.hashes)) process.stdout.write(`  ${name}: ${value}\n`);
  process.stdout.write(result.publishable
    ? `${kleur.green("✓")} Final owner approval matches the checked artifact hashes.\n`
    : `${kleur.yellow("next")}: review coverage and these artifact hashes, then record the owner's final approval in approval.json.\n`);
}

async function runPublish(cmd: Command, opts: PublishOpts): Promise<void> {
  const project = resolve(opts.project);
  if (opts.preview) {
    const preview = await previewEvalPublication(project);
    if (isJsonMode(cmd)) {
      process.stdout.write(`${JSON.stringify(preview)}\n`);
      return;
    }
    process.stdout.write(`${kleur.green("✓")} Prepared exact eval release preview. Nothing was uploaded.\n`);
    process.stdout.write(`Expected release ID: ${preview.expected_release_id}\n`);
    process.stdout.write(`Manifest SHA-256: ${preview.manifest_sha256} (${preview.manifest_size_bytes} bytes)\n`);
    process.stdout.write(`Bundle SHA-256: ${preview.bundle.sha256} (${preview.bundle.size_bytes} bytes)\n`);
    process.stdout.write(`Bundle destination: ${preview.bundle.r2_key}\n`);
    process.stdout.write(`Outgoing manifest and ordered ${preview.bundle.files.length}-file inventory:\n`);
    process.stdout.write(`${JSON.stringify(preview.manifest, null, 2)}\n`);
    process.stdout.write(`Local-only rule: ${preview.local_only.policy}\n`);
    for (const path of preview.local_only.explicitly_excluded) process.stdout.write(`  - ${path}\n`);
    process.stdout.write(`Next: obtain upload permission for this exact preview, then rerun with --expect-release-id ${preview.expected_release_id}.\n`);
    return;
  }
  if (opts.expectReleaseId === undefined) {
    throw new Error("Run `understudy evals publish --preview` first, review its exact contents, then rerun with `--expect-release-id <expected_release_id>`.");
  }
  const release = await publishEvalRelease(project, { expectedReleaseId: opts.expectReleaseId });
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(release)}\n`);
    return;
  }
  process.stdout.write(`${kleur.green("✓")} Published eval release ${release.release_id} (release ${release.release_number}).\n`);
  process.stdout.write(`Bundle: ${release.artifacts.bundle_r2_key}\n`);
  process.stdout.write("Live workload routing and prompts were not changed.\n");
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
  if (windowMs !== 7 * 86_400_000) {
    throw new Error("understudy evals build currently requires the complete --last 7d window.");
  }
  const selectionDays = 7;
  const maxAgeDays = opts.maxAgeDays === undefined
    ? selectionDays
    : parsePositiveInteger("--max-age-days", opts.maxAgeDays);
  if (maxAgeDays < selectionDays) {
    throw new Error(`--max-age-days must cover --last (${selectionDays} day(s)).`);
  }
  if (isJsonMode(cmd) && !opts.yes) {
    throw new Error("JSON mode cannot prompt. Re-run with --yes to approve the complete local trace download.");
  }
  if (!opts.yes && !process.stdin.isTTY) {
    throw new Error("Non-interactive eval builds cannot prompt. Re-run with --yes to approve the complete local trace download.");
  }
  const output = resolve(opts.out ?? join(".understudy", "evals", safeFileStem(opts.name)));
  if (pathExists(output)) {
    throw new Error(`Eval build destination already exists: ${output}. Choose a fresh --out directory.`);
  }
  ensureUnderstudyGitExcluded(output);
  const releaseLease = acquireEvalBuildLease(output);
  try {
    await runBuildWithLease(cmd, opts, { batchSize, windowMs, maxAgeDays, output });
  } finally {
    releaseLease();
  }
}

async function runBuildWithLease(
  cmd: Command,
  opts: BuildOpts,
  build: { batchSize: number; windowMs: number; maxAgeDays: number; output: string },
): Promise<void> {
  const { batchSize, windowMs, maxAgeDays, output } = build;
  if (pathExists(output)) {
    throw new Error(`Eval build destination already exists: ${output}. Choose a fresh --out directory.`);
  }
  const staging = join(dirname(output), `.${basename(output)}.eval-build`);
  const pending = pathExists(staging) ? readEvalBuildState(staging) : null;
  const context = await resolveContext(opts);
  const currentIdentity = identityFromContext(context);
  let state: EvalWorkloadBuildState;
  if (pending) {
    assertWorkloadBuildStateMatches(pending, opts.name, currentIdentity, maxAgeDays, batchSize);
    state = pending;
  } else {
    const to = new Date();
    state = creatingWorkloadBuildState({
      name: opts.name,
      identity: currentIdentity,
      source: {
        from: new Date(to.getTime() - windowMs).toISOString(),
        to: to.toISOString(),
        ingestion_cutoff: to.toISOString(),
      },
      maxAgeDays,
      batchSize,
      now: to,
    });
    initializeBuildCheckpoint(staging, state);
  }
  if (!opts.yes) {
    const approved = await confirm({
      message: `${pending ? "Resume" : "Download"} every retrievable capture in the frozen seven-day window for local eval “${opts.name}”? Files may contain prompts, completions, and tool payloads.`,
      default: false,
    });
    if (!approved) throw new Error("Eval build cancelled before payload download.");
  }

  if (state.status === "complete") {
    const recovered = JSON.parse(readFileSync(join(staging, "eval-project.json"), "utf8")) as WorkloadEvalProjectBuildResult;
    renameSync(staging, output);
    recovered.project_file = join(output, "eval-project.json");
    emitWorkloadBuildResult(cmd, output, recovered);
    return;
  }

  while (state.status === "downloading") {
    const segment = await fetchWorkloadExportSegment(context, state);
    assertWorkloadExportSegmentMatchesState(segment, state);
    await materializeWorkloadExportSegment({
      exportData: segment,
      tracesDirectory: join(staging, "source", "traces"),
      gatewayUrl: context.project.auth.gatewayUrl,
      verifiedFiles: state.transport.verified_files,
      onVerified(file) {
        if (!state.transport.verified_files.some((existing) => existing.capture_key === file.capture_key)) {
          state = persistWorkloadBuildState(staging, {
            ...state,
            transport: {
              ...state.transport,
              verified_files: [...state.transport.verified_files, file],
            },
          });
        }
      },
    });
    state = persistWorkloadBuildState(staging, {
      ...state,
      status: segment.chain.terminal ? "receipt_pending" : "downloading",
      transport: {
        ...state.transport,
        resume_cursor: segment.resume_cursor ?? null,
        chain_id: segment.chain.chain_id,
        next_segment_index: segment.chain.segment_index + 1,
        previous_manifest_sha256: segment.chain.manifest_sha256,
        segment_manifest_sha256: [...state.transport.segment_manifest_sha256, segment.chain.manifest_sha256],
        cumulative_exported: segment.chain.cumulative_exported,
        cumulative_total_bytes: segment.chain.cumulative_total_bytes,
        terminal_receipt: segment.chain.terminal_receipt ?? null,
      },
    });
  }

  if (!state.transport.terminal_receipt) throw new Error("Complete capture export is missing its terminal receipt.");
  const receipt = await verifyWorkloadExportReceipt(context, state);
  if (
    receipt.chain_id !== state.transport.chain_id ||
    receipt.cumulative_exported !== state.transport.cumulative_exported ||
    receipt.total_bytes !== state.transport.cumulative_total_bytes ||
    receipt.manifest_sha256 !== state.transport.previous_manifest_sha256
  ) throw new Error("Verified capture export receipt does not match the downloaded source chain.");

  const project = buildWorkloadEvalProject({
    output: staging,
    name: state.name,
    identity: state.identity,
    canonicalScope: receipt.canonical_scope,
    verifiedFiles: state.transport.verified_files,
    segmentManifestSha256: state.transport.segment_manifest_sha256,
    terminalReceipt: state.transport.terminal_receipt,
    verifiedReceipt: receipt,
    now: new Date(state.created_at),
  });
  state = persistWorkloadBuildState(staging, { ...state, status: "complete" });
  renameSync(staging, output);
  project.project_file = join(output, "eval-project.json");
  emitWorkloadBuildResult(cmd, output, project);
}

async function fetchWorkloadExportSegment(
  context: Awaited<ReturnType<typeof resolveContext>>,
  state: EvalWorkloadBuildState,
): Promise<WorkloadCaptureExportResponse> {
  const response = await request({
    url: `${context.base}/eval-capture-export`,
    method: "POST",
    orgId: context.project.auth.orgId,
    signal: AbortSignal.timeout(60_000),
    body: {
      ...state.source,
      expires_seconds: EXPORT_EXPIRES_SECONDS,
      ...(state.transport.resume_cursor ? { resume_cursor: state.transport.resume_cursor } : {}),
    },
  }, WorkloadCaptureExportResponseSchema);
  return response.data;
}

async function verifyWorkloadExportReceipt(
  context: Awaited<ReturnType<typeof resolveContext>>,
  state: EvalWorkloadBuildState,
) {
  const canonicalScope = workloadExportScope(state);
  const response = await request({
    url: `${context.base}/eval-capture-export/verify`,
    method: "POST",
    orgId: context.project.auth.orgId,
    signal: AbortSignal.timeout(60_000),
    body: { terminal_receipt: state.transport.terminal_receipt, canonical_scope: canonicalScope },
  }, VerifyWorkloadCaptureExportReceiptResponseSchema);
  if (JSON.stringify(response.data.canonical_scope) !== JSON.stringify(canonicalScope)) {
    throw new Error("Verified capture export receipt returned a different canonical scope.");
  }
  return response.data;
}

function workloadExportScope(state: EvalWorkloadBuildState): WorkloadCaptureExportScope {
  return {
    schema_version: "understudy.export-scope.v1" as const,
    selector: "workload-window" as const,
    org_id: state.identity.org_id,
    project_id: state.identity.project_id,
    workload_id: state.identity.workload_id,
    ...state.source,
  };
}

function assertWorkloadExportSegmentMatchesState(
  segment: WorkloadCaptureExportResponse,
  state: EvalWorkloadBuildState,
): void {
  const expectedScope = workloadExportScope(state);
  if (JSON.stringify(segment.canonical_scope) !== JSON.stringify(expectedScope)) {
    throw new Error("Capture export response does not match the frozen workload window.");
  }
  if (
    segment.chain.segment_index !== state.transport.next_segment_index ||
    segment.chain.previous_manifest_sha256 !== state.transport.previous_manifest_sha256 ||
    (state.transport.chain_id !== null && segment.chain.chain_id !== state.transport.chain_id) ||
    segment.chain.cumulative_exported !== state.transport.cumulative_exported + segment.count ||
    segment.chain.cumulative_total_bytes !== state.transport.cumulative_total_bytes + segment.total_bytes
  ) throw new Error("Capture export segment does not continue the persisted source chain.");
}

function persistWorkloadBuildState(staging: string, candidate: EvalWorkloadBuildState): EvalWorkloadBuildState {
  const state = EvalWorkloadBuildStateSchema.parse(candidate);
  replacePrivateJson(join(staging, "build-state.json"), state);
  return state;
}

function emitWorkloadBuildResult(cmd: Command, output: string, project: WorkloadEvalProjectBuildResult): void {
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(project)}\n`);
  } else {
    process.stdout.write(`${kleur.green("✓")} Materialized the complete seven-day source at ${output}\n`);
    process.stdout.write(`Project manifest: ${project.project_file}\n`);
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
