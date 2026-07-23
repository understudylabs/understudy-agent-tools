import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Command } from "commander";
import kleur from "kleur";
import { z } from "zod";

import {
  exportCapturesByRequestIds,
  isBatchFatalError,
  resolveBatchOutputDirectory,
  writePrivateText,
  type CaptureBatchExportSummary,
} from "./captures.js";
import { request, UnderstudyApiError } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import {
  resolveProject,
  type ProjectResolutionOptions,
} from "../internal/projects.js";
import { resolveWorkload } from "../internal/workloads.js";

const TRACE_EXPORT_SCHEMA = "understudy.trace_export.v1";
const DEFAULT_EXPORT_CONCURRENCY = 4;
const MAX_EXPORT_CONCURRENCY = 16;
const DEFAULT_EXPORT_RETRIES = 2;
const MAX_EXPORT_RETRIES = 5;
const MAX_BATCH_TRACE_IDS = 100_000;
const MAX_TRACE_REQUEST_IDS = 100_000;

const TraceRequestIdsResponseSchema = z.object({
  trace_id: z.string(),
  request_ids: z.array(z.string()),
}).strict();

interface TraceExportOpts extends ProjectResolutionOptions {
  workload?: string;
  out: string;
  traceIdsFile?: string;
  includePayload?: boolean;
  yes?: boolean;
  concurrency?: string;
  retries?: string;
  resume?: boolean;
}

interface TraceExportResult {
  traceId: string;
  status: "written" | "partial" | "failed";
  requestCount: number;
  batch?: CaptureBatchExportSummary;
  outputDirectory?: string;
}

export function registerHostedTraceExportCommand(traces: Command): void {
  traces.command("export [trace-id]")
    .description("Resolve hosted trace request ids and export their captures privately.")
    .requiredOption("--out <directory>", "Private output directory.")
    .option("--trace-ids-file <path>", "Batch export: one explicit trace id per line.")
    .option("--project-id <id>", "Project id from `understudy projects list --json`.")
    .option("--project <slug>", "Project slug to resolve to an id.")
    .option("--workload <name-or-id>", "Optional workload name or id.")
    .option("--org <id>", "Org id to use (default: local config or only org in credentials).")
    .option("--concurrency <n>", `Capture-fetch concurrency, max ${MAX_EXPORT_CONCURRENCY}.`, String(DEFAULT_EXPORT_CONCURRENCY))
    .option("--retries <n>", `Retries for transient lookup or capture failures, max ${MAX_EXPORT_RETRIES}.`, String(DEFAULT_EXPORT_RETRIES))
    .option("--no-resume", "Re-download capture files that already exist.")
    .option("--include-payload", "Write full captures, including prompt/completion payloads.")
    .option("--yes", "Confirm full payload export without prompting.")
    .action(async function (this: Command, traceId: string | undefined, opts: TraceExportOpts) {
      await runAction(this, () => runTraceExport(this, traceId, opts));
    });
}

async function runTraceExport(
  cmd: Command,
  traceIdInput: string | undefined,
  opts: TraceExportOpts,
): Promise<void> {
  const traceId = traceIdInput?.trim();
  const traceIdsFile = opts.traceIdsFile?.trim();
  if (Boolean(traceId) === Boolean(traceIdsFile)) {
    throw new Error(
      "Provide exactly one of <trace-id> or --trace-ids-file <path>.",
    );
  }
  if (traceId) validateTraceId(traceId);
  if (opts.includePayload && !opts.yes) {
    throw new Error(
      "Full trace export may contain prompts/completions. Re-run with --include-payload --yes to write it to files.",
    );
  }

  const concurrency = parseBoundedInteger(
    opts.concurrency,
    "--concurrency",
    1,
    MAX_EXPORT_CONCURRENCY,
    DEFAULT_EXPORT_CONCURRENCY,
  );
  const retries = parseBoundedInteger(
    opts.retries,
    "--retries",
    0,
    MAX_EXPORT_RETRIES,
    DEFAULT_EXPORT_RETRIES,
  );
  const requested = traceIdsFile
    ? readTraceIds(traceIdsFile)
    : { traceIds: [traceId!], inputCount: 1 };
  const project = await resolveProject(opts);
  const workload = opts.workload
    ? await resolveWorkload(project, opts.workload)
    : null;
  const outputDirectory = resolveBatchOutputDirectory(opts.out);
  const failureManifest = join(outputDirectory, "failed-trace-ids.txt");
  const results: TraceExportResult[] = [];
  const batchMode = Boolean(traceIdsFile);

  for (const selectedTraceId of requested.traceIds) {
    try {
      const requestIds = await fetchTraceRequestIdsWithRetry(
        project.auth.orgId,
        project.projectId,
        selectedTraceId,
        workload?.id,
        retries,
      );
      const traceOutputDirectory = batchMode
        ? join(outputDirectory, traceDirectoryName(selectedTraceId))
        : outputDirectory;
      const batch = await exportCapturesByRequestIds({
        requestIds,
        inputCount: requestIds.length,
        outputDirectory: traceOutputDirectory,
        includePayload: Boolean(opts.includePayload),
        concurrency,
        retries,
        resume: opts.resume !== false,
        orgId: project.auth.orgId,
        projectId: project.projectId,
        workloadId: workload?.id,
        onProgress: isJsonMode(cmd)
          ? undefined
          : (completed, total) => {
            if (completed % 100 === 0) {
              process.stderr.write(
                `Exported ${completed}/${total} captures for trace ${selectedTraceId}...\n`,
              );
            }
          },
      });
      writeTraceManifest(
        traceOutputDirectory,
        selectedTraceId,
        project.projectId,
        workload?.id,
        requestIds,
        batch,
      );
      results.push({
        traceId: selectedTraceId,
        status: batch.failed === 0 ? "written" : "partial",
        requestCount: requestIds.length,
        batch,
        outputDirectory: traceOutputDirectory,
      });
    } catch (error) {
      if (isBatchFatalError(error) || !batchMode) throw error;
      results.push({
        traceId: selectedTraceId,
        status: "failed",
        requestCount: 0,
      });
    }
  }

  const complete = results.filter((result) => result.status === "written").length;
  const partial = results.filter((result) => result.status === "partial").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const retryTraceIds = results
    .filter((result) => result.status !== "written")
    .map((result) => result.traceId);
  const requestCount = results.reduce(
    (sum, result) => sum + result.requestCount,
    0,
  );
  const capturesWritten = results.reduce(
    (sum, result) => sum + (result.batch?.written ?? 0),
    0,
  );
  const capturesSkipped = results.reduce(
    (sum, result) => sum + (result.batch?.skipped ?? 0),
    0,
  );
  const capturesFailed = results.reduce(
    (sum, result) => sum + (result.batch?.failed ?? 0),
    0,
  );
  writePrivateText(
    failureManifest,
    retryTraceIds.length > 0 ? `${retryTraceIds.join("\n")}\n` : "",
  );

  const payload = {
    ok: retryTraceIds.length === 0,
    input_count: requested.inputCount,
    unique_count: requested.traceIds.length,
    complete,
    partial,
    failed,
    request_count: requestCount,
    captures_written: capturesWritten,
    captures_skipped: capturesSkipped,
    captures_failed: capturesFailed,
    output_directory: outputDirectory,
    failure_manifest: failureManifest,
    include_payload: Boolean(opts.includePayload),
    warning: opts.includePayload
      ? "files may contain prompts, completions, or tool payloads"
      : null,
  };

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stdout.write(
      `${retryTraceIds.length === 0 ? kleur.green("✓") : kleur.yellow("!")} ` +
      `Trace export complete: ${complete} complete, ${partial} partial, ` +
      `${failed} failed -> ${outputDirectory}\n`,
    );
    process.stdout.write(
      `Captures: ${capturesWritten} written, ${capturesSkipped} skipped, ${capturesFailed} failed\n`,
    );
    process.stdout.write(`Failure manifest: ${failureManifest}\n`);
    if (opts.includePayload) {
      process.stdout.write(
        `${kleur.yellow("warning")}: files may contain prompts, completions, or tool payloads\n`,
      );
    }
  }

  if (retryTraceIds.length > 0) process.exitCode = 1;
}

async function fetchTraceRequestIdsWithRetry(
  orgId: string,
  projectId: string,
  traceId: string,
  workloadId: string | undefined,
  retries: number,
): Promise<string[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchTraceRequestIds(
        orgId,
        projectId,
        traceId,
        workloadId,
      );
    } catch (error) {
      if (attempt >= retries || !isRetryableTraceLookupError(error)) {
        throw error;
      }
      await delay(250 * 2 ** attempt);
    }
  }
}

async function fetchTraceRequestIds(
  orgId: string,
  projectId: string,
  traceId: string,
  workloadId?: string,
): Promise<string[]> {
  const base =
    `/admin/v1/orgs/${orgId}/projects/${encodeURIComponent(projectId)}` +
    `/traces/${encodeURIComponent(traceId)}/request-ids`;
  const params = new URLSearchParams();
  if (workloadId) params.set("workload_id", workloadId);
  const url = params.size > 0 ? `${base}?${params}` : base;
  const res = await request({ url, orgId }, TraceRequestIdsResponseSchema);
  if (res.data.trace_id !== traceId) {
    throw new Error(
      `Trace lookup returned trace_id=${res.data.trace_id} for requested trace_id=${traceId}.`,
    );
  }
  return normalizeTraceRequestIds(res.data.request_ids);
}

function writeTraceManifest(
  outputDirectory: string,
  traceId: string,
  projectId: string,
  workloadId: string | undefined,
  requestIds: string[],
  batch: CaptureBatchExportSummary,
): void {
  writePrivateText(
    join(outputDirectory, "trace.json"),
    `${JSON.stringify({
      schema_version: TRACE_EXPORT_SCHEMA,
      trace_id: traceId,
      project_id: projectId,
      workload_id: workloadId ?? null,
      request_ids: requestIds,
      capture_export: {
        complete: batch.failed === 0,
        written: batch.written,
        skipped: batch.skipped,
        failed: batch.failed,
        output_suffix: batch.output_suffix,
        failure_manifest: basename(batch.failure_manifest),
        include_payload: batch.include_payload,
      },
    }, null, 2)}\n`,
  );
}

function readTraceIds(path: string): {
  traceIds: string[];
  inputCount: number;
} {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Trace-id file not found: ${path}`);
  }
  const rows = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0 && !row.startsWith("#"));
  if (rows.length === 0) {
    throw new Error(`Trace-id file is empty: ${path}`);
  }
  if (rows.length > MAX_BATCH_TRACE_IDS) {
    throw new Error(
      `Trace-id file contains more than ${MAX_BATCH_TRACE_IDS} rows.`,
    );
  }
  for (const traceId of rows) validateTraceId(traceId);
  return { traceIds: [...new Set(rows)], inputCount: rows.length };
}

function normalizeTraceRequestIds(requestIds: string[]): string[] {
  if (requestIds.length === 0) {
    throw new Error("Trace lookup returned no request ids.");
  }
  if (requestIds.length > MAX_TRACE_REQUEST_IDS) {
    throw new Error(
      `Trace lookup returned more than ${MAX_TRACE_REQUEST_IDS} request ids.`,
    );
  }
  const invalid = requestIds.find(
    (requestId) =>
      requestId.length === 0 ||
      requestId.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(requestId),
  );
  if (invalid) {
    throw new Error(
      "Trace lookup returned an invalid request id.",
    );
  }
  return [...new Set(requestIds)];
}

function validateTraceId(traceId: string): void {
  if (
    traceId.length === 0 ||
    traceId.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(traceId)
  ) {
    throw new Error(
      "Trace ids must be non-empty, at most 512 characters, and contain no control characters.",
    );
  }
}

function traceDirectoryName(traceId: string): string {
  const encoded = encodeURIComponent(traceId);
  if (Buffer.byteLength(encoded, "utf8") <= 180) return encoded;
  return `${encoded.slice(0, 80)}--${createHash("sha256").update(traceId).digest("hex").slice(0, 20)}`;
}

function parseBoundedInteger(
  value: string | undefined,
  option: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Expected ${option} between ${minimum} and ${maximum}, got: ${value}`,
    );
  }
  return parsed;
}

function isRetryableTraceLookupError(error: unknown): boolean {
  if (error instanceof UnderstudyApiError) {
    return error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500;
  }
  return error instanceof TypeError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
