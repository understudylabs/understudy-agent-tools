import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import { createPrivateDirectory, pathExists, replacePrivateText } from "./evals/build-state.js";
import {
  WorkloadCaptureExportScopeSchema,
  WorkloadSourceRowSchema,
  WorkloadTraceWindowBindingSchema,
  type WorkloadCaptureExportScope,
  type WorkloadSourceRow,
  type WorkloadTraceWindowBinding,
} from "./evals/contracts.js";
import { allowedCaptureUrl, portableCaptureFileName } from "./evals/materialize.js";
import { EVAL_SOURCE_ROW_SCHEMA_VERSION, SourceIndexCommitment } from "./evals/source-index.js";
import { request, UnderstudyApiError } from "./internal/http.js";

export const DEFAULT_WORKLOAD_TRACE_CONCURRENCY = 4;
export const MAX_WORKLOAD_TRACE_CONCURRENCY = 16;
export const DEFAULT_WORKLOAD_TRACE_RETRIES = 2;
export const MAX_WORKLOAD_TRACE_RETRIES = 5;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_PAGE_CAPTURES = 1_000;

export const WORKLOAD_CAPTURE_EXPORT_ROUTE_PATTERN =
  "/orgs/:org_id/projects/:project_id/workloads/:workload_id/captures/export" as const;

export const WorkloadTraceExportCaptureSchema = z.object({
  request_id: z.string().min(1),
  capture_key: z.string().min(1),
  captured_at: z.string().datetime(),
  url: z.string().url(),
}).strict();

export const WorkloadTraceExportPageSchema = z.object({
  canonical_scope: WorkloadCaptureExportScopeSchema,
  captures: z.array(WorkloadTraceExportCaptureSchema).max(MAX_PAGE_CAPTURES),
  next_cursor: z.string().min(1).max(8_192).nullable(),
}).strict();

export const WorkloadTraceExportPageRequestSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  ingestion_cutoff: z.string().datetime().optional(),
  cursor: z.string().min(1).max(8_192).optional(),
}).strict().superRefine((request, context) => {
  if (Boolean(request.cursor) !== Boolean(request.ingestion_cutoff)) {
    context.addIssue({
      code: "custom",
      path: request.cursor ? ["ingestion_cutoff"] : ["cursor"],
      message: "ingestion_cutoff and cursor must be supplied together",
    });
  }
});

const WorkloadTraceExportSkippedCaptureSchema = z.object({
  request_id: z.string().min(1),
  capture_key: z.string().min(1),
  captured_at: z.string().datetime(),
  reason: z.literal("not_found"),
}).strict();

const WorkloadTraceExportSummarySchema = z.object({
  schema_version: z.literal("understudy.trace-source.v1"),
  window: WorkloadCaptureExportScopeSchema,
  requested_count: z.number().int().nonnegative(),
  materialized_count: z.number().int().nonnegative(),
  skipped_count: z.number().int().nonnegative(),
  skipped_index: z.literal("source/skipped.jsonl"),
  capture_count: z.number().int().nonnegative(),
  size_bytes: z.number().int().nonnegative(),
  index: z.literal("source/index.jsonl"),
  index_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export interface WorkloadTraceWindow {
  from: string;
  to: string;
}

export type WorkloadTraceExportScope = WorkloadCaptureExportScope;
export type WorkloadTraceExportCapture = z.infer<typeof WorkloadTraceExportCaptureSchema>;
export type WorkloadTraceExportPage = z.infer<typeof WorkloadTraceExportPageSchema>;
type WorkloadTraceExportSkippedCapture = z.infer<typeof WorkloadTraceExportSkippedCaptureSchema>;

export interface WorkloadTraceExportResult {
  outputDirectory: string;
  indexPath: string;
  canonicalScope: WorkloadTraceExportScope;
  captureCount: number;
  sizeBytes: number;
  indexSha256: string;
  requestedCount: number;
  skippedCount: number;
  writtenCount: number;
  adoptedCount: number;
}

export interface WorkloadTraceExportInput extends WorkloadTraceWindow {
  orgId: string;
  projectId: string;
  workloadId: string;
  outputDirectory: string;
  gatewayUrl: string;
  concurrency?: number;
  retries?: number;
  reuseStoredWindow?: boolean;
  onProgress?: (completed: number, written: number, adopted: number) => void;
  requestPage?: (body: WorkloadTraceExportPageRequest) => Promise<unknown>;
  fetchCapture?: typeof fetch;
}

export type WorkloadTraceExportPageRequest = z.infer<typeof WorkloadTraceExportPageRequestSchema>;

export function resolveWorkloadTraceWindow(input: {
  date?: string;
  last?: string;
  now?: Date;
}): WorkloadTraceWindow {
  if (input.date !== undefined && input.last !== undefined) {
    throw new Error("Choose either --date or --last, not both.");
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("Current time is invalid.");
  if (input.last !== undefined && input.last !== "1d") {
    throw new Error("Workload trace export currently supports exactly 1d.");
  }
  if (input.date === undefined) {
    return {
      from: new Date(now.valueOf() - 86_400_000).toISOString(),
      to: now.toISOString(),
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error("--date must use YYYY-MM-DD.");
  }
  const from = new Date(`${input.date}T00:00:00.000Z`);
  if (Number.isNaN(from.valueOf()) || from.toISOString().slice(0, 10) !== input.date) {
    throw new Error("--date must be a valid UTC calendar date.");
  }
  const to = new Date(from.valueOf() + 86_400_000);
  if (to.valueOf() > now.valueOf()) {
    throw new Error("--date must select a complete UTC calendar day whose end is not in the future.");
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

export async function exportWorkloadTraceWindow(
  input: WorkloadTraceExportInput,
): Promise<WorkloadTraceExportResult> {
  validateInput(input);
  const outputDirectory = resolve(input.outputDirectory);
  createPrivateDirectory(outputDirectory);
  const sourceDirectory = join(outputDirectory, "source");
  createPrivateDirectory(sourceDirectory);
  const tracesDirectory = join(sourceDirectory, "traces");
  const effectiveWindow = bindExportWindow(sourceDirectory, tracesDirectory, input);
  const effectiveInput = { ...input, ...effectiveWindow };
  const indexPath = join(sourceDirectory, "index.jsonl");
  const summaryPath = join(sourceDirectory, "summary.json");
  const completedExport = await readCompletedExport(
    outputDirectory,
    indexPath,
    summaryPath,
    effectiveInput,
  );
  if (completedExport !== null) return completedExport;
  rmSync(indexPath, { force: true });
  rmSync(summaryPath, { force: true });
  const skippedPath = join(sourceDirectory, "skipped.jsonl");
  rmSync(skippedPath, { force: true });
  createPrivateDirectory(tracesDirectory);
  const requestPage = input.requestPage ?? ((body) => requestHostedPage(effectiveInput, body));
  const fetchCapture = input.fetchCapture ?? fetch;
  let indexTemporary = `${indexPath}.tmp-${randomUUID()}`;
  let skippedTemporary = `${skippedPath}.tmp-${randomUUID()}`;
  let indexDescriptor: number | null = null;
  let skippedDescriptor: number | null = null;
  let completedExportWritten = false;
  let canonicalScope: WorkloadTraceExportScope | null = null;
  let cursor: string | null = null;
  let previousOrder: CaptureOrder | null = null;
  let requestedCount = 0;
  let materializedCount = 0;
  let skippedCount = 0;
  let sizeBytes = 0;
  const commitment = new SourceIndexCommitment();
  let completed = 0;
  let writtenCount = 0;
  let adoptedCount = 0;

  try {
    indexDescriptor = openSync(indexTemporary, "wx", 0o600);
    skippedDescriptor = openSync(skippedTemporary, "wx", 0o600);
    do {
      const body: WorkloadTraceExportPageRequest = cursor === null
        ? { from: effectiveInput.from, to: effectiveInput.to }
        : {
            from: effectiveInput.from,
            to: effectiveInput.to,
            ingestion_cutoff: canonicalScope!.ingestion_cutoff,
            cursor,
          };
      const rawPage = await retryOperation(
        () => requestPage(body),
        input.retries ?? DEFAULT_WORKLOAD_TRACE_RETRIES,
      );
      const page = WorkloadTraceExportPageSchema.parse(rawPage);
      assertPageScope(effectiveInput, page.canonical_scope, canonicalScope);
      canonicalScope ??= page.canonical_scope;
      if (page.captures.length === 0 && page.next_cursor !== null) {
        throw new Error("Workload trace export returned an empty non-terminal page.");
      }
      for (const capture of page.captures) {
        assertCaptureReference(effectiveInput, capture);
        previousOrder = assertStrictlyIncreasingCaptureOrder(previousOrder, capture);
      }
      requestedCount += page.captures.length;

      const pageRows = new Array<WorkloadSourceRow | null>(page.captures.length).fill(null);
      const pageSkipped = new Array<WorkloadTraceExportSkippedCapture | null>(page.captures.length).fill(null);
      await runWithConcurrency(
        page.captures,
        input.concurrency ?? DEFAULT_WORKLOAD_TRACE_CONCURRENCY,
        async (capture, index) => {
          const fileName = portableCaptureFileName(
            capture.request_id,
            `-${createHash("sha256").update(capture.capture_key).digest("hex")}`,
          );
          const finalPath = join(tracesDirectory, fileName);
          const localPath = relative(outputDirectory, finalPath).split(sep).join("/");
          let materialized: Awaited<ReturnType<typeof adoptExistingCapture>> |
            Awaited<ReturnType<typeof downloadCaptureWithRetry>>;
          try {
            materialized = existsSync(finalPath)
              ? await adoptExistingCapture(finalPath, effectiveInput, capture)
              : await downloadCaptureWithRetry(
                  finalPath,
                  effectiveInput,
                  capture,
                  fetchCapture,
                  input.retries ?? DEFAULT_WORKLOAD_TRACE_RETRIES,
                );
          } catch (error) {
            if (!isMissingCapture(error)) throw error;
            pageSkipped[index] = {
              request_id: capture.request_id,
              capture_key: capture.capture_key,
              captured_at: capture.captured_at,
              reason: "not_found",
            };
            completed += 1;
            input.onProgress?.(completed, writtenCount, adoptedCount);
            return;
          }
          if (materialized.adopted) adoptedCount += 1;
          else writtenCount += 1;
          pageRows[index] = {
            schema_version: EVAL_SOURCE_ROW_SCHEMA_VERSION,
            request_id: capture.request_id,
            capture_key: capture.capture_key,
            captured_at: capture.captured_at,
            size_bytes: materialized.sizeBytes,
            content_sha256: materialized.digest,
            local_path: localPath,
          };
          completed += 1;
          input.onProgress?.(completed, writtenCount, adoptedCount);
        },
      );
      for (const row of pageRows) {
        if (row === null) continue;
        appendJsonLine(indexDescriptor, row);
        commitment.update(row);
        materializedCount += 1;
        sizeBytes += row.size_bytes;
      }
      for (const skipped of pageSkipped) {
        if (skipped === null) continue;
        appendJsonLine(skippedDescriptor, skipped);
        skippedCount += 1;
      }
      cursor = page.next_cursor;
    } while (cursor !== null);

    if (canonicalScope === null || materializedCount === 0) {
      throw new Error("No raw captures could be materialized in the selected workload day.");
    }
    closeSync(indexDescriptor);
    indexDescriptor = null;
    closeSync(skippedDescriptor);
    skippedDescriptor = null;
    const indexSha256 = commitment.digest();
    const summaryBody = `${JSON.stringify({
      schema_version: "understudy.trace-source.v1",
      window: canonicalScope,
      requested_count: requestedCount,
      materialized_count: materializedCount,
      skipped_count: skippedCount,
      skipped_index: "source/skipped.jsonl",
      capture_count: materializedCount,
      size_bytes: sizeBytes,
      index: "source/index.jsonl",
      index_sha256: indexSha256,
    }, null, 2)}\n`;
    renameSync(indexTemporary, indexPath);
    indexTemporary = "";
    chmodSync(indexPath, 0o600);
    renameSync(skippedTemporary, skippedPath);
    skippedTemporary = "";
    chmodSync(skippedPath, 0o600);
    replacePrivateText(summaryPath, summaryBody);
    completedExportWritten = true;
    return {
      outputDirectory,
      indexPath,
      canonicalScope,
      captureCount: materializedCount,
      sizeBytes,
      indexSha256,
      requestedCount,
      skippedCount,
      writtenCount,
      adoptedCount,
    };
  } finally {
    if (indexDescriptor !== null) closeSync(indexDescriptor);
    if (skippedDescriptor !== null) closeSync(skippedDescriptor);
    if (indexTemporary) rmSync(indexTemporary, { force: true });
    if (skippedTemporary) rmSync(skippedTemporary, { force: true });
    if (!completedExportWritten) {
      rmSync(indexPath, { force: true });
      rmSync(skippedPath, { force: true });
      rmSync(summaryPath, { force: true });
    }
  }
}

type CaptureOrder = Pick<WorkloadTraceExportCapture, "captured_at" | "request_id" | "capture_key">;

function assertStrictlyIncreasingCaptureOrder(
  previous: CaptureOrder | null,
  capture: CaptureOrder,
): CaptureOrder {
  if (previous === null) return capture;
  const comparison = compareCaptureOrder(previous, capture);
  if (comparison >= 0) {
    throw new Error(`Workload trace export returned repeated or out-of-order capture ${capture.request_id}.`);
  }
  return capture;
}

function compareCaptureOrder(left: CaptureOrder, right: CaptureOrder): number {
  for (const key of ["captured_at", "request_id", "capture_key"] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

function appendJsonLine(descriptor: number, value: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(descriptor, bytes, written, bytes.byteLength - written);
    if (count <= 0) throw new Error("Could not write workload trace export index.");
    written += count;
  }
}

async function readCompletedExport(
  outputDirectory: string,
  indexPath: string,
  summaryPath: string,
  input: WorkloadTraceExportInput,
): Promise<WorkloadTraceExportResult | null> {
  if (!pathExists(indexPath) || !pathExists(summaryPath)) return null;
  const summary = WorkloadTraceExportSummarySchema.parse(
    JSON.parse(readFileSync(summaryPath, "utf8")),
  );
  assertPageScope(input, summary.window, null);
  const skippedPath = resolve(outputDirectory, summary.skipped_index);
  for (const path of [indexPath, skippedPath, summaryPath]) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Completed workload trace export marker must be a real file: ${path}.`);
    }
  }
  const tracesDirectory = resolve(outputDirectory, "source", "traces");
  const tracesStat = lstatSync(tracesDirectory);
  if (tracesStat.isSymbolicLink() || !tracesStat.isDirectory()) {
    throw new Error(`Completed workload trace export trace path must be a real directory: ${tracesDirectory}.`);
  }
  const rowIterator = readJsonl(indexPath, "source index");
  const skippedIterator = readJsonl(skippedPath, "skipped index");
  let nextRow = await rowIterator.next();
  let nextSkipped = await skippedIterator.next();
  let previousOrder: CaptureOrder | null = null;
  let materializedCount = 0;
  let skippedCount = 0;
  let sizeBytes = 0;
  const commitment = new SourceIndexCommitment();
  while (!nextRow.done || !nextSkipped.done) {
    const row = nextRow.done ? null : WorkloadSourceRowSchema.parse(nextRow.value);
    const skipped = nextSkipped.done ? null : WorkloadTraceExportSkippedCaptureSchema.parse(nextSkipped.value);
    if (row !== null && (skipped === null || compareCaptureOrder(row, skipped) <= 0)) {
      assertCaptureReference(input, row);
      previousOrder = assertStrictlyIncreasingCaptureOrder(previousOrder, row);
      const expectedLocalPath = relative(
        outputDirectory,
        join(
          tracesDirectory,
          portableCaptureFileName(
            row.request_id,
            `-${createHash("sha256").update(row.capture_key).digest("hex")}`,
          ),
        ),
      ).split(sep).join("/");
      if (row.local_path !== expectedLocalPath) {
        throw new Error(`Completed workload trace export has an unexpected local path ${row.local_path}.`);
      }
      const capturePath = resolve(outputDirectory, row.local_path);
      const stat = lstatSync(capturePath);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.size !== row.size_bytes ||
        stat.size > MAX_CAPTURE_BYTES
      ) {
        throw new Error(`Completed workload trace export capture is missing or changed: ${row.local_path}.`);
      }
      await assertRawCaptureIdentity(capturePath, input, row);
      const hashed = await hashFile(capturePath);
      if (hashed.sizeBytes !== row.size_bytes || hashed.digest !== row.content_sha256) {
        throw new Error(`Completed workload trace export capture is missing or changed: ${row.local_path}.`);
      }
      commitment.update(row);
      materializedCount += 1;
      sizeBytes += row.size_bytes;
      nextRow = await rowIterator.next();
    } else if (skipped !== null) {
      assertCaptureReference(input, skipped);
      previousOrder = assertStrictlyIncreasingCaptureOrder(previousOrder, skipped);
      skippedCount += 1;
      nextSkipped = await skippedIterator.next();
    }
  }
  if (materializedCount === 0) {
    throw new Error("Completed workload trace export has no materialized raw captures.");
  }
  const indexSha256 = commitment.digest();
  if (
    summary.capture_count !== materializedCount ||
    summary.materialized_count !== materializedCount ||
    summary.skipped_count !== skippedCount ||
    summary.requested_count !== materializedCount + skippedCount ||
    summary.size_bytes !== sizeBytes ||
    summary.index_sha256 !== indexSha256
  ) {
    throw new Error("Completed workload trace export summary does not match its source index.");
  }
  return {
    outputDirectory,
    indexPath,
    canonicalScope: summary.window,
    captureCount: materializedCount,
    sizeBytes,
    indexSha256,
    requestedCount: summary.requested_count,
    skippedCount: summary.skipped_count,
    writtenCount: 0,
    adoptedCount: materializedCount,
  };
}

async function* readJsonl(path: string, description: string): AsyncGenerator<unknown> {
  let remainder = "";
  let lineNumber = 0;
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    remainder += chunk;
    while (true) {
      const newline = remainder.indexOf("\n");
      if (newline === -1) break;
      const line = remainder.slice(0, newline).replace(/\r$/, "");
      remainder = remainder.slice(newline + 1);
      lineNumber += 1;
      if (line.length === 0) continue;
      yield parseJsonlValue(line, description, lineNumber);
    }
  }
  if (remainder.length > 0) {
    lineNumber += 1;
    yield parseJsonlValue(remainder.replace(/\r$/, ""), description, lineNumber);
  }
}

function parseJsonlValue(line: string, description: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid ${description} line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function bindExportWindow(
  sourceDirectory: string,
  tracesDirectory: string,
  input: WorkloadTraceExportInput,
): WorkloadTraceWindow {
  const bindingPath = join(sourceDirectory, "window.json");
  const requested: WorkloadTraceWindowBinding = {
    schema_version: "understudy.trace-export-window.v1",
    org_id: input.orgId,
    project_id: input.projectId,
    workload_id: input.workloadId,
    from: input.from,
    to: input.to,
  };
  if (pathExists(bindingPath)) {
    const stored = WorkloadTraceWindowBindingSchema.parse(JSON.parse(readFileSync(bindingPath, "utf8")));
    if (
      stored.org_id !== requested.org_id ||
      stored.project_id !== requested.project_id ||
      stored.workload_id !== requested.workload_id
    ) {
      throw new Error("Existing raw captures belong to a different organization, project, or workload. Choose a fresh --out directory.");
    }
    if (!input.reuseStoredWindow && (stored.from !== requested.from || stored.to !== requested.to)) {
      throw new Error("Existing raw captures belong to a different day. Choose a fresh --out directory.");
    }
    return { from: stored.from, to: stored.to };
  }
  if (pathExists(tracesDirectory) && readdirSync(tracesDirectory).length > 0) {
    throw new Error("Existing raw captures have no saved workload-day binding. Choose a fresh --out directory.");
  }
  replacePrivateText(bindingPath, `${JSON.stringify(requested, null, 2)}\n`);
  return { from: requested.from, to: requested.to };
}

async function requestHostedPage(
  input: WorkloadTraceExportInput,
  body: WorkloadTraceExportPageRequest,
): Promise<WorkloadTraceExportPage> {
  const route = WORKLOAD_CAPTURE_EXPORT_ROUTE_PATTERN
    .replace(":org_id", encodeURIComponent(input.orgId))
    .replace(":project_id", encodeURIComponent(input.projectId))
    .replace(":workload_id", encodeURIComponent(input.workloadId));
  const response = await request({
    url: `/admin/v1${route}`,
    method: "POST",
    orgId: input.orgId,
    signal: AbortSignal.timeout(60_000),
    body: WorkloadTraceExportPageRequestSchema.parse(body),
  }, WorkloadTraceExportPageSchema);
  return response.data;
}

function validateInput(input: WorkloadTraceExportInput): void {
  for (const [name, value] of [
    ["org id", input.orgId],
    ["project id", input.projectId],
    ["workload id", input.workloadId],
  ] as const) {
    if (!value) throw new Error(`Workload trace export ${name} is required.`);
  }
  const from = Date.parse(input.from);
  const to = Date.parse(input.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to - from !== 86_400_000) {
    throw new Error("Workload trace export window must be exactly 24 hours.");
  }
  const concurrency = input.concurrency ?? DEFAULT_WORKLOAD_TRACE_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_WORKLOAD_TRACE_CONCURRENCY) {
    throw new Error(`Workload trace export concurrency must be between 1 and ${MAX_WORKLOAD_TRACE_CONCURRENCY}.`);
  }
  const retries = input.retries ?? DEFAULT_WORKLOAD_TRACE_RETRIES;
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_WORKLOAD_TRACE_RETRIES) {
    throw new Error(`Workload trace export retries must be between 0 and ${MAX_WORKLOAD_TRACE_RETRIES}.`);
  }
}

function assertPageScope(
  input: WorkloadTraceExportInput,
  scope: WorkloadTraceExportScope,
  frozen: WorkloadTraceExportScope | null,
): void {
  if (
    scope.org_id !== input.orgId ||
    scope.project_id !== input.projectId ||
    scope.workload_id !== input.workloadId ||
    scope.from !== input.from ||
    scope.to !== input.to ||
    Date.parse(scope.ingestion_cutoff) < Date.parse(scope.to)
  ) {
    throw new Error("Workload trace export response does not match the requested organization, project, workload, or window.");
  }
  if (frozen !== null && JSON.stringify(scope) !== JSON.stringify(frozen)) {
    throw new Error("Workload trace export response changed its frozen scope between pages.");
  }
}

function assertCaptureReference(
  input: WorkloadTraceExportInput,
  capture: Pick<WorkloadTraceExportCapture, "request_id" | "capture_key" | "captured_at">,
): void {
  if (
    !capture.capture_key.startsWith(`${input.orgId}/${input.projectId}/`) ||
    !capture.capture_key.endsWith(`/${capture.request_id}.jsonl`)
  ) {
    throw new Error(`Workload trace capture reference does not match request ${capture.request_id}.`);
  }
  const capturedAt = Date.parse(capture.captured_at);
  if (capturedAt < Date.parse(input.from) || capturedAt >= Date.parse(input.to)) {
    throw new Error(`Workload trace capture ${capture.request_id} falls outside the requested window.`);
  }
}

async function adoptExistingCapture(
  path: string,
  input: WorkloadTraceExportInput,
  capture: WorkloadTraceExportCapture,
): Promise<{ adopted: true; digest: string; sizeBytes: number }> {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Existing raw capture must be a real file: ${path}.`);
  }
  if (stat.size > MAX_CAPTURE_BYTES) {
    throw new Error(`Existing raw capture ${capture.request_id} exceeds the local size limit.`);
  }
  await assertRawCaptureIdentity(path, input, capture);
  const hashed = await hashFile(path);
  chmodSync(path, 0o600);
  return { adopted: true, ...hashed };
}

async function downloadCaptureWithRetry(
  finalPath: string,
  input: WorkloadTraceExportInput,
  capture: WorkloadTraceExportCapture,
  fetchCapture: typeof fetch,
  retries: number,
): Promise<{ adopted: false; digest: string; sizeBytes: number }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const downloaded = await downloadCaptureOnce(finalPath, input, capture, fetchCapture);
      return { adopted: false, ...downloaded };
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      await delay(250 * 2 ** attempt);
    }
  }
}

async function downloadCaptureOnce(
  finalPath: string,
  input: WorkloadTraceExportInput,
  capture: WorkloadTraceExportCapture,
  fetchCapture: typeof fetch,
): Promise<{ digest: string; sizeBytes: number }> {
  const url = allowedCaptureUrl(capture.url, input.gatewayUrl);
  const partialPath = `${finalPath}.${process.pid}.${randomUUID()}.partial`;
  let descriptor: number | null = null;
  try {
    const response = await fetchCapture(url, {
      headers: { Accept: "application/x-ndjson" },
      redirect: "error",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CaptureDownloadStatusError(capture.request_id, response.status);
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAX_CAPTURE_BYTES) {
      await response.body?.cancel();
      throw new Error(`Raw capture ${capture.request_id} exceeds the ${MAX_CAPTURE_BYTES}-byte local limit.`);
    }
    if (!response.body) throw new Error(`Raw capture ${capture.request_id} returned no body.`);
    descriptor = openSync(partialPath, "wx", 0o600);
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let sizeBytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      sizeBytes += chunk.value.byteLength;
      if (sizeBytes > MAX_CAPTURE_BYTES) {
        await reader.cancel();
        throw new Error(`Raw capture ${capture.request_id} exceeds the ${MAX_CAPTURE_BYTES}-byte local limit.`);
      }
      hash.update(chunk.value);
      let written = 0;
      while (written < chunk.value.byteLength) {
        const count = writeSync(descriptor, chunk.value, written, chunk.value.byteLength - written);
        if (count <= 0) throw new Error(`Raw capture ${capture.request_id} could not be written completely.`);
        written += count;
      }
    }
    closeSync(descriptor);
    descriptor = null;
    await assertRawCaptureIdentity(partialPath, input, capture);
    renameSync(partialPath, finalPath);
    chmodSync(finalPath, 0o600);
    return { digest: hash.digest("hex"), sizeBytes };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(partialPath, { force: true });
  }
}

async function assertRawCaptureIdentity(
  path: string,
  input: WorkloadTraceExportInput,
  capture: Pick<WorkloadTraceExportCapture, "request_id">,
): Promise<void> {
  const firstLine = await readFirstNonEmptyLine(path, capture.request_id);
  let raw: unknown;
  try {
    raw = firstLine === undefined ? null : JSON.parse(firstLine);
  } catch {
    raw = null;
  }
  const value = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const workloadId = typeof value.workload_id === "string"
    ? value.workload_id
    : typeof value.placement_id === "string" ? value.placement_id : null;
  if (
    value.request_id !== capture.request_id ||
    value.workos_org_id !== input.orgId ||
    value.project_id !== input.projectId ||
    workloadId !== input.workloadId
  ) {
    throw new Error(`Raw capture identity does not match export reference ${capture.request_id}.`);
  }
}

async function readFirstNonEmptyLine(path: string, requestId: string): Promise<string | undefined> {
  let remainder = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    remainder += chunk;
    if (Buffer.byteLength(remainder, "utf8") > MAX_CAPTURE_BYTES) {
      throw new Error(`Raw capture ${requestId} exceeds the local size limit.`);
    }
    while (true) {
      const newline = remainder.indexOf("\n");
      if (newline === -1) break;
      const line = remainder.slice(0, newline).replace(/\r$/, "");
      remainder = remainder.slice(newline + 1);
      if (line.trim().length > 0) return line;
    }
  }
  const finalLine = remainder.replace(/\r$/, "");
  return finalLine.trim().length > 0 ? finalLine : undefined;
}

async function hashFile(path: string): Promise<{ digest: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { digest: hash.digest("hex"), sizeBytes };
}

async function runWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await worker(values[index]!, index);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
}

async function retryOperation<T>(operation: () => Promise<T>, retries: number): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      await delay(250 * 2 ** attempt);
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof UnderstudyApiError || error instanceof CaptureDownloadStatusError) {
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}

function isMissingCapture(error: unknown): boolean {
  return error instanceof CaptureDownloadStatusError && error.status === 404;
}

class CaptureDownloadStatusError extends Error {
  readonly status: number;

  constructor(requestId: string, status: number, cause?: unknown) {
    super(`Raw capture ${requestId} download failed with status ${status}.`, { cause });
    this.status = status;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
