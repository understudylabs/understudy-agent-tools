import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import kleur from "kleur";
import { z } from "zod";

import { findProjectRoot } from "../config/paths.js";
import { request, UnderstudyApiError } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { resolveProject, type ProjectResolutionOptions } from "../internal/projects.js";
import { resolveWorkload } from "../internal/workloads.js";

const DEFAULT_EXPORT_CONCURRENCY = 4;
const MAX_EXPORT_CONCURRENCY = 16;
const DEFAULT_EXPORT_RETRIES = 2;
const MAX_EXPORT_RETRIES = 5;
const MAX_BATCH_REQUEST_IDS = 100_000;

const CaptureEnvelopeSchema = z.object({
  capture: z.unknown().optional(),
}).passthrough();

const ListCapturesResponseSchema = z.object({
  captures: z.array(z.unknown()),
  truncated: z.boolean().optional(),
  cursor: z.string().nullable().optional(),
}).passthrough();

interface CaptureOpts extends ProjectResolutionOptions {
  workload?: string;
}

interface ListOpts extends CaptureOpts {
  limit?: string;
  cursor?: string;
}

interface ExportOpts extends CaptureOpts {
  out: string;
  includePayload?: boolean;
  yes?: boolean;
  requestIdsFile?: string;
  concurrency?: string;
  retries?: string;
  resume?: boolean;
}

type JsonObject = Record<string, unknown>;
type BatchExportStatus = "written" | "skipped" | "failed";

interface BatchExportResult {
  requestId: string;
  status: BatchExportStatus;
}

export interface CaptureSummary {
  request_id: string | null;
  schema_version: string | null;
  ts: string | null;
  project_id: string | null;
  workload_id: string | null;
  mode: string | null;
  provider: string | null;
  endpoint: string | null;
  requested_model: string | null;
  upstream_model: string | null;
  status_code: number | null;
  latency_ms: number | null;
  tags: { count: number; keys: string[] };
  customer_request_body: "present" | "absent";
  upstream_request_body: "present" | "absent";
  response_body: "present" | "absent";
}

export function registerCapturesCommand(program: Command): void {
  const captures = program
    .command("captures")
    .description("List and export hosted capture metadata safely.");

  addCaptureOptions(captures.command("list")
    .description("List capture metadata for a project or workload.")
    .option("--limit <n>", "Capture limit, max 100.", "25")
    .option("--cursor <cursor>", "Pagination cursor."))
    .action(async function (this: Command, opts: ListOpts) {
      await runAction(this, () => runList(this, opts));
    });

  addCaptureOptions(captures.command("get <request-id>")
    .description("Get one redacted capture summary by request id."))
    .action(async function (this: Command, requestId: string, opts: CaptureOpts) {
      await runAction(this, () => runGet(this, requestId, opts));
    });

  addCaptureOptions(captures.command("export [request-id]")
    .description("Write one or a file-listed batch of capture objects locally.")
    .requiredOption("--out <path>", "Output file or directory.")
    .option("--request-ids-file <path>", "Batch export: one request id per line.")
    .option("--concurrency <n>", `Batch export concurrency, max ${MAX_EXPORT_CONCURRENCY}.`, String(DEFAULT_EXPORT_CONCURRENCY))
    .option("--retries <n>", `Retries for transient batch failures, max ${MAX_EXPORT_RETRIES}.`, String(DEFAULT_EXPORT_RETRIES))
    .option("--no-resume", "Re-download batch files that already exist.")
    .option("--include-payload", "Write the full capture object, including prompt/completion payloads.")
    .option("--yes", "Confirm full payload export without prompting."))
    .action(async function (this: Command, requestId: string | undefined, opts: ExportOpts) {
      await runAction(this, () => runExport(this, requestId, opts));
    });
}

function addCaptureOptions(command: Command): Command {
  return command
    .option("--project-id <id>", "Project id from `understudy projects list --json`.")
    .option("--project <slug>", "Project slug to resolve to an id.")
    .option("--workload <name-or-id>", "Optional workload name or id.")
    .option("--org <id>", "Org id to use (default: local config or only org in credentials).");
}

async function runList(cmd: Command, opts: ListOpts): Promise<void> {
  const limit = parseLimit(opts.limit);
  const { project, workload } = await resolveCaptureContext(opts);
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts.cursor) params.set("cursor", opts.cursor);
  const base = workload
    ? `/admin/v1/orgs/${project.auth.orgId}/projects/${encodeURIComponent(project.projectId)}/workloads/${encodeURIComponent(workload.id)}/captures`
    : `/admin/v1/orgs/${project.auth.orgId}/projects/${encodeURIComponent(project.projectId)}/captures`;
  const res = await request(
    { url: `${base}?${params.toString()}`, orgId: project.auth.orgId },
    ListCapturesResponseSchema,
  );
  const summaries = res.data.captures.map(summarizeCapture);
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify({
      project_id: project.projectId,
      workload_id: workload?.id ?? null,
      captures: summaries,
      truncated: Boolean(res.data.truncated),
      cursor: res.data.cursor ?? null,
    })}\n`);
    return;
  }
  printCaptureTable(summaries);
}

async function runGet(cmd: Command, requestId: string, opts: CaptureOpts): Promise<void> {
  const { project, workload } = await resolveCaptureContext(opts);
  const capture = await fetchCapture(project.auth.orgId, project.projectId, requestId, workload?.id);
  const summary = summarizeCapture(capture);
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify({ project_id: project.projectId, workload_id: workload?.id ?? null, capture: summary })}\n`);
    return;
  }
  printCaptureBlock(summary);
}

async function runExport(
  cmd: Command,
  requestId: string | undefined,
  opts: ExportOpts,
): Promise<void> {
  const singleRequestId = requestId?.trim();
  const requestIdsFile = opts.requestIdsFile?.trim();
  if (Boolean(singleRequestId) === Boolean(requestIdsFile)) {
    throw new Error(
      "Provide exactly one of <request-id> or --request-ids-file <path>.",
    );
  }
  if (opts.includePayload && !opts.yes) {
    throw new Error("Full capture export may contain prompts/completions. Re-run with --include-payload --yes to write it to a file.");
  }

  if (requestIdsFile) {
    await runBatchExport(cmd, requestIdsFile, opts);
    return;
  }

  await runSingleExport(cmd, singleRequestId!, opts);
}

async function runSingleExport(
  cmd: Command,
  requestId: string,
  opts: ExportOpts,
): Promise<void> {
  const { project, workload } = await resolveCaptureContext(opts);
  const capture = await fetchCapture(project.auth.orgId, project.projectId, requestId, workload?.id);
  const outputPath = resolveOutputPath(opts.out, requestId);
  const value = opts.includePayload ? capture : summarizeCapture(capture);
  writePrivateText(outputPath, `${JSON.stringify(value, null, 2)}\n`);

  const payload = {
    ok: true,
    output: outputPath,
    include_payload: Boolean(opts.includePayload),
    warning: opts.includePayload ? "file may contain prompts, completions, or tool payloads" : null,
  };
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`${kleur.green("✓")} Wrote capture export: ${outputPath}\n`);
  if (opts.includePayload) {
    process.stdout.write(`${kleur.yellow("warning")}: file may contain prompts, completions, or tool payloads\n`);
  }
}

async function runBatchExport(
  cmd: Command,
  requestIdsFile: string,
  opts: ExportOpts,
): Promise<void> {
  const { requestIds, inputCount } = readRequestIds(requestIdsFile);
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
  const outputDirectory = resolveBatchOutputDirectory(opts.out);
  const failureManifest = join(outputDirectory, "failed-request-ids.txt");
  const resume = opts.resume !== false;
  const { project, workload } = await resolveCaptureContext(opts);
  const results: BatchExportResult[] = new Array(requestIds.length);
  let completed = 0;

  await runWithConcurrency(
    requestIds,
    concurrency,
    async (requestId, index) => {
      const outputPath = join(
        outputDirectory,
        batchCaptureFilename(requestId, Boolean(opts.includePayload)),
      );
      if (resume && isCompletedExport(outputPath)) {
        results[index] = { requestId, status: "skipped" };
      } else {
        try {
          const capture = await fetchCaptureWithRetry(
            project.auth.orgId,
            project.projectId,
            requestId,
            workload?.id,
            retries,
          );
          const value = opts.includePayload
            ? capture
            : summarizeCapture(capture);
          writePrivateText(outputPath, `${JSON.stringify(value, null, 2)}\n`);
          results[index] = { requestId, status: "written" };
        } catch {
          results[index] = { requestId, status: "failed" };
        }
      }

      completed += 1;
      if (!isJsonMode(cmd) && completed % 100 === 0) {
        process.stderr.write(`Exported ${completed}/${requestIds.length} captures...\n`);
      }
    },
  );

  const written = results.filter((result) => result.status === "written").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const failedIds = results
    .filter((result) => result.status === "failed")
    .map((result) => result.requestId);
  writePrivateText(
    failureManifest,
    failedIds.length > 0 ? `${failedIds.join("\n")}\n` : "",
  );

  const payload = {
    ok: failedIds.length === 0,
    input_count: inputCount,
    unique_count: requestIds.length,
    written,
    skipped,
    failed: failedIds.length,
    output_directory: outputDirectory,
    failure_manifest: failureManifest,
    output_suffix: opts.includePayload ? ".json" : ".summary.json",
    include_payload: Boolean(opts.includePayload),
    warning: opts.includePayload
      ? "files may contain prompts, completions, or tool payloads"
      : null,
  };

  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stdout.write(
      `${failedIds.length === 0 ? kleur.green("✓") : kleur.yellow("!")} ` +
      `Capture batch complete: ${written} written, ${skipped} skipped, ` +
      `${failedIds.length} failed -> ${outputDirectory}\n`,
    );
    process.stdout.write(`Failure manifest: ${failureManifest}\n`);
    if (opts.includePayload) {
      process.stdout.write(
        `${kleur.yellow("warning")}: files may contain prompts, completions, or tool payloads\n`,
      );
    }
  }

  if (failedIds.length > 0) {
    process.exitCode = 1;
  }
}

async function resolveCaptureContext(opts: CaptureOpts) {
  const project = await resolveProject(opts);
  const workload = opts.workload ? await resolveWorkload(project, opts.workload) : null;
  return { project, workload };
}

async function fetchCapture(orgId: string, projectId: string, requestId: string, workloadId?: string): Promise<unknown> {
  const base = workloadId
    ? `/admin/v1/orgs/${orgId}/projects/${encodeURIComponent(projectId)}/workloads/${encodeURIComponent(workloadId)}/captures/${encodeURIComponent(requestId)}`
    : `/admin/v1/orgs/${orgId}/projects/${encodeURIComponent(projectId)}/captures/${encodeURIComponent(requestId)}`;
  const res = await request({ url: base, orgId }, CaptureEnvelopeSchema);
  return res.data.capture ?? res.data;
}

async function fetchCaptureWithRetry(
  orgId: string,
  projectId: string,
  requestId: string,
  workloadId: string | undefined,
  retries: number,
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchCapture(orgId, projectId, requestId, workloadId);
    } catch (error) {
      if (attempt >= retries || !isRetryableCaptureError(error)) {
        throw error;
      }
      await delay(250 * 2 ** attempt);
    }
  }
}

export function summarizeCapture(input: unknown): CaptureSummary {
  const capture = isObject(input) ? input : {};
  const tags = isObject(capture.tags) ? capture.tags : {};
  return {
    request_id: stringField(capture, "request_id"),
    schema_version: stringField(capture, "schema_version"),
    ts: stringField(capture, "ts") ?? stringField(capture, "created_at"),
    project_id: stringField(capture, "project_id"),
    workload_id: stringField(capture, "workload_id") ?? stringField(capture, "placement_id"),
    mode: stringField(capture, "mode"),
    provider: stringField(capture, "provider"),
    endpoint: stringField(capture, "endpoint"),
    requested_model: stringField(capture, "requested_model") ?? stringField(capture, "model"),
    upstream_model: stringField(capture, "upstream_model"),
    status_code: numberField(capture, "status_code"),
    latency_ms: numberField(capture, "latency_ms"),
    tags: { count: Object.keys(tags).length, keys: Object.keys(tags).sort() },
    customer_request_body: present(capture.customer_request_body),
    upstream_request_body: present(capture.upstream_request_body),
    response_body: present(capture.response_body),
  };
}

function parseLimit(value: string | undefined): number {
  const parsed = Number(value ?? "25");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(`Expected --limit between 1 and 100, got: ${value}`);
  }
  return parsed;
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

function readRequestIds(path: string): {
  requestIds: string[];
  inputCount: number;
} {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Request-id file not found: ${path}`);
  }
  const rows = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0 && !row.startsWith("#"));
  if (rows.length === 0) {
    throw new Error(`Request-id file is empty: ${path}`);
  }
  if (rows.length > MAX_BATCH_REQUEST_IDS) {
    throw new Error(
      `Request-id file contains more than ${MAX_BATCH_REQUEST_IDS} rows.`,
    );
  }
  const invalid = rows.find(
    (requestId) =>
      requestId.length > 512 || /[\u0000-\u001f\u007f]/.test(requestId),
  );
  if (invalid) {
    throw new Error(
      "Request ids must be at most 512 characters and contain no control characters.",
    );
  }
  const requestIds = [...new Set(rows)];
  return { requestIds, inputCount: rows.length };
}

function resolveBatchOutputDirectory(out: string): string {
  if (existsSync(out) && !statSync(out).isDirectory()) {
    throw new Error(`Batch --out must be a directory: ${out}`);
  }
  mkdirSync(out, { recursive: true, mode: 0o700 });
  return out;
}

function resolveOutputPath(out: string, requestId: string): string {
  if (existsSync(out) && statSync(out).isDirectory()) {
    return join(out, ".understudy", "captures", `${captureFilename(requestId)}.json`);
  }
  if (out.endsWith("/") || out.endsWith("\\")) {
    return join(out, ".understudy", "captures", `${captureFilename(requestId)}.json`);
  }
  return out || join(findProjectRoot(), ".understudy", "captures", `${requestId}.json`);
}

function captureFilename(requestId: string): string {
  return encodeURIComponent(requestId);
}

function batchCaptureFilename(
  requestId: string,
  includePayload: boolean,
): string {
  return `${captureFilename(requestId)}${includePayload ? "" : ".summary"}.json`;
}

function isCompletedExport(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  return stat.isFile() && stat.size > 0;
}

function writePrivateText(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const partialPath = `${path}.${process.pid}.partial`;
  try {
    writeFileSync(partialPath, contents, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      renameSync(partialPath, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EEXIST" && code !== "EPERM") || !existsSync(path)) {
        throw error;
      }
      rmSync(path, { force: true });
      renameSync(partialPath, path);
    }
  } finally {
    rmSync(partialPath, { force: true });
  }
}

async function runWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
}

function isRetryableCaptureError(error: unknown): boolean {
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

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(obj: JsonObject, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function numberField(obj: JsonObject, key: string): number | null {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function present(value: unknown): "present" | "absent" {
  return value === undefined || value === null ? "absent" : "present";
}

function printCaptureTable(captures: CaptureSummary[]): void {
  if (captures.length === 0) {
    process.stdout.write(`${kleur.gray("No captures found.")}\n`);
    return;
  }
  const rows = captures.map((capture) => ({
    request_id: capture.request_id ?? "",
    uploaded: capture.ts ?? "",
    size: "",
    key: capture.request_id ? capture.request_id.slice(-8) : "",
  }));
  const headers = ["request_id", "uploaded", "size", "key"];
  const widths = headers.map((h) => Math.max(h.length, ...rows.map((r) => r[h as keyof typeof r].length)));
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  process.stdout.write(`${headers.map((h, i) => kleur.bold(pad(h, widths[i]!))).join("  ")}\n`);
  for (const row of rows) {
    process.stdout.write(`${headers.map((h, i) => pad(row[h as keyof typeof row], widths[i]!)).join("  ")}\n`);
  }
}

function printCaptureBlock(capture: CaptureSummary): void {
  for (const [key, value] of Object.entries(capture)) {
    if (key === "tags") {
      process.stdout.write(`${kleur.bold(key)} ${capture.tags.count} (${capture.tags.keys.join(",")})\n`);
    } else {
      process.stdout.write(`${kleur.bold(key)} ${String(value)}\n`);
    }
  }
}
