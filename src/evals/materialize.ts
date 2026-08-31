import { createHash } from "node:crypto";
import { closeSync, createReadStream, lstatSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { createPrivateDirectory, pathExists, writePrivateJson } from "./build-state.js";
import {
  WorkloadCaptureExportManifestHeaderSchema,
  WorkloadCaptureExportManifestItemSchema,
  type CohortExport,
  type VerifiedWorkloadCaptureFile,
  type WorkloadCaptureExportManifestHeader,
  type WorkloadCaptureExportManifestItem,
  type WorkloadCaptureExportResponse,
} from "./contracts.js";

export const EXPORT_EXPIRES_SECONDS = 3600;
const CAPTURE_DOWNLOAD_TIMEOUT_MS = 60_000;
const CAPTURE_DOWNLOAD_CONCURRENCY = 4;
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const MAX_COHORT_BYTES = 256 * 1024 * 1024;
const EXPORT_MIN_REMAINING_MS = 2 * 60_000;
const MAX_PORTABLE_FILE_NAME_BYTES = 240;
const CAPTURE_FILE_EXTENSION = ".jsonl";
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export async function downloadExport(
  exportData: CohortExport,
  workloadId: string,
  out: string,
  gatewayUrl: string,
  refreshExport?: () => Promise<CohortExport>,
) {
  const outputDir = resolve(out);
  if (pathExists(outputDir)) throw new Error(`Capture destination already exists: ${outputDir}. Choose a fresh directory.`);
  const plans = localFilePlans(exportData);
  createPrivateDirectory(outputDir);
  const files: Array<{ request_id: string; path: string; content_sha256: string; size_bytes: number }> = [];
  const aggregateBudget = { used: 0 };
  let currentExport = exportData;
  try {
    for (let offset = 0; offset < plans.length; offset += CAPTURE_DOWNLOAD_CONCURRENCY) {
      currentExport = await freshExport(currentExport, refreshExport);
      assertEquivalentExport(exportData, currentExport);
      const batch = plans.slice(offset, offset + CAPTURE_DOWNLOAD_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(async (plan, index) => {
        const capture = currentExport.captures[offset + index]!;
        const downloaded = await downloadCapture(capture, plan.fileName, outputDir, gatewayUrl, aggregateBudget);
        return { request_id: capture.request_id, path: plan.fileName, content_sha256: downloaded.digest, size_bytes: downloaded.sizeBytes };
      }));
      const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
      files.push(...settled.map((result) => (result as PromiseFulfilledResult<(typeof files)[number]>).value));
    }
    const totalBytes = files.reduce((sum, file) => sum + file.size_bytes, 0);
    if (totalBytes !== aggregateBudget.used) throw new Error("Cohort download byte accounting does not match streamed payloads.");
    const localManifest = join(outputDir, "cohort-manifest.json");
    writePrivateJson(localManifest, {
      schema_version: "understudy.eval-cohort-materialization.v1",
      cohort_id: exportData.cohort_id,
      cohort_sha256: exportData.cohort_sha256,
      workload_id: workloadId,
      capture_count: files.length,
      size_bytes: totalBytes,
      privacy: { local_only: true, upload_performed: false },
      captures: files,
    });
    return { output: outputDir, manifest: localManifest, count: files.length, cohort_sha256: exportData.cohort_sha256 };
  } catch (error) {
    rmSync(outputDir, { recursive: true, force: true });
    throw error;
  }
}

function localFilePlans(exportData: CohortExport): Array<{ fileName: string }> {
  const fileNameKeys = new Set<string>();
  return exportData.captures.map((capture, index) => {
    let fileName = portableCaptureFileName(capture.request_id);
    if (fileNameKeys.has(portableFileNameKey(fileName))) {
      fileName = portableCaptureFileName(capture.request_id, `-${capture.content_sha256.slice(0, 12)}`);
    }
    if (fileNameKeys.has(portableFileNameKey(fileName))) {
      fileName = portableCaptureFileName(capture.request_id, `-${capture.content_sha256.slice(0, 12)}-${index}`);
    }
    const key = portableFileNameKey(fileName);
    if (fileNameKeys.has(key)) throw new Error(`Capture ${capture.request_id} collides with another local filename.`);
    fileNameKeys.add(key);
    return { fileName };
  });
}

export function assertExportLineage(exportData: CohortExport, cohortId: string, cohortSha256: string): void {
  if (exportData.cohort_id !== cohortId || exportData.cohort_sha256 !== cohortSha256) {
    throw new Error(`Cohort export lineage does not match frozen cohort ${cohortId}.`);
  }
}

export function assertEquivalentExport(expected: CohortExport, candidate: CohortExport): void {
  assertExportLineage(candidate, expected.cohort_id, expected.cohort_sha256);
  if (candidate.captures.length !== expected.captures.length || candidate.captures.some((capture, index) => {
    const original = expected.captures[index]!;
    return capture.request_id !== original.request_id || capture.content_sha256 !== original.content_sha256;
  })) {
    throw new Error(`Refreshed export does not match frozen cohort ${expected.cohort_id}.`);
  }
}

async function freshExport(current: CohortExport, refresh?: () => Promise<CohortExport>): Promise<CohortExport> {
  const expiresAt = Date.parse(current.expires_at);
  if (expiresAt > Date.now() + EXPORT_MIN_REMAINING_MS) return current;
  if (!refresh) throw new Error(`Cohort export ${current.export_id} expires too soon to download safely.`);
  const refreshed = await refresh();
  assertEquivalentExport(current, refreshed);
  if (Date.parse(refreshed.expires_at) <= Date.now() + EXPORT_MIN_REMAINING_MS) {
    throw new Error(`Refreshed cohort export ${refreshed.export_id} expires too soon to download safely.`);
  }
  return refreshed;
}

async function downloadCapture(
  capture: CohortExport["captures"][number],
  fileName: string,
  outputDir: string,
  gatewayUrl: string,
  aggregateBudget: { used: number },
): Promise<{ digest: string; sizeBytes: number }> {
  const url = allowedCaptureUrl(capture.url, gatewayUrl);
  const finalPath = join(outputDir, fileName);
  const partialPath = `${finalPath}.partial`;
  let descriptor: number | null = null;
  let complete = false;
  try {
    const download = await fetch(url, {
      headers: { Accept: "application/x-ndjson" },
      redirect: "error",
      signal: AbortSignal.timeout(CAPTURE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!download.ok) throw new Error(`Capture ${capture.request_id} download failed with status ${download.status}.`);
    const declaredLengthHeader = download.headers.get("content-length");
    const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
    if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > MAX_CAPTURE_BYTES) {
      throw new Error(`Capture ${capture.request_id} exceeds the ${MAX_CAPTURE_BYTES}-byte local download limit.`);
    }
    if (!download.body) throw new Error(`Capture ${capture.request_id} download returned no body.`);
    descriptor = openSync(partialPath, "wx", 0o600);
    const hash = createHash("sha256");
    const reader = download.body.getReader();
    let sizeBytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      try {
        sizeBytes = reserveDownloadedChunk(capture.request_id, sizeBytes, chunk.value.byteLength, aggregateBudget);
      } catch (error) {
        await reader.cancel();
        throw error;
      }
      hash.update(chunk.value);
      let written = 0;
      while (written < chunk.value.byteLength) {
        const count = writeSync(descriptor, chunk.value, written, chunk.value.byteLength - written);
        if (count <= 0) throw new Error(`Capture ${capture.request_id} could not be written completely.`);
        written += count;
      }
    }
    closeSync(descriptor);
    descriptor = null;
    const digest = hash.digest("hex");
    if (digest !== capture.content_sha256) throw new Error(`Capture ${capture.request_id} failed SHA-256 verification.`);
    renameSync(partialPath, finalPath);
    complete = true;
    return { digest, sizeBytes };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (!complete) rmSync(partialPath, { force: true });
  }
}

export function reserveDownloadedChunk(
  requestId: string,
  captureBytes: number,
  chunkBytes: number,
  aggregateBudget: { used: number },
): number {
  if (captureBytes + chunkBytes > MAX_CAPTURE_BYTES) {
    throw new Error(`Capture ${requestId} exceeds the ${MAX_CAPTURE_BYTES}-byte local download limit.`);
  }
  if (aggregateBudget.used + chunkBytes > MAX_COHORT_BYTES) {
    throw new Error(`Cohort payloads exceed the ${MAX_COHORT_BYTES}-byte local download limit.`);
  }
  aggregateBudget.used += chunkBytes;
  return captureBytes + chunkBytes;
}

export function reserveReceiptDrivenChunk(
  requestId: string,
  captureBytes: number,
  chunkBytes: number,
  expectedBytes: number,
): number {
  const next = captureBytes + chunkBytes;
  if (
    !Number.isSafeInteger(captureBytes) || captureBytes < 0 ||
    !Number.isSafeInteger(chunkBytes) || chunkBytes < 0 ||
    !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 ||
    !Number.isSafeInteger(next) || next > expectedBytes
  ) {
    throw new Error(`Capture ${requestId} exceeds its authenticated ${expectedBytes}-byte manifest size.`);
  }
  return next;
}

export async function materializeWorkloadExportSegment(input: {
  exportData: WorkloadCaptureExportResponse;
  tracesDirectory: string;
  gatewayUrl: string;
  verifiedFiles: VerifiedWorkloadCaptureFile[];
  onVerified: (file: VerifiedWorkloadCaptureFile) => void | Promise<void>;
}): Promise<{
  header: WorkloadCaptureExportManifestHeader;
  items: WorkloadCaptureExportManifestItem[];
  manifest_sha256: string;
}> {
  const manifestUrl = allowedCaptureUrl(input.exportData.manifest_url, input.gatewayUrl);
  const manifestResponse = await fetch(manifestUrl, {
    headers: { Accept: "application/x-ndjson" },
    redirect: "error",
    signal: AbortSignal.timeout(CAPTURE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!manifestResponse.ok) {
    throw new Error(`Capture export manifest download failed with status ${manifestResponse.status}.`);
  }
  const manifestBody = await manifestResponse.text();
  const manifestSha256 = createHash("sha256").update(manifestBody).digest("hex");
  if (manifestSha256 !== input.exportData.chain.manifest_sha256) {
    throw new Error("Capture export manifest failed SHA-256 verification.");
  }
  const lines = manifestBody.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("Capture export manifest is empty.");
  const header = WorkloadCaptureExportManifestHeaderSchema.parse(JSON.parse(lines[0]!));
  const items = lines.slice(1).map((line) => WorkloadCaptureExportManifestItemSchema.parse(JSON.parse(line)));
  assertWorkloadManifestLineage(input.exportData, header, items, manifestSha256);

  const tracesDirectory = resolve(input.tracesDirectory);
  const projectRoot = dirname(dirname(tracesDirectory));
  createPrivateDirectory(tracesDirectory);
  const verifiedByKey = new Map<string, VerifiedWorkloadCaptureFile>();
  for (const file of input.verifiedFiles) {
    const previous = verifiedByKey.get(file.capture_key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(file)) {
      throw new Error(`Verified capture ledger contains conflicting entries for ${file.capture_key}.`);
    }
    verifiedByKey.set(file.capture_key, file);
  }

  for (const item of items) {
    const fileName = portableCaptureFileName(
      item.request_id,
      `-${createHash("sha256").update(item.key).digest("hex").slice(0, 12)}`,
    );
    const expectedLocalPath = relative(projectRoot, join(tracesDirectory, fileName)).split(sep).join("/");
    const existing = verifiedByKey.get(item.key);
    if (existing) {
      if (
        existing.request_id !== item.request_id || existing.size_bytes !== item.size ||
        existing.content_sha256 !== item.content_sha256 || existing.local_path !== expectedLocalPath
      ) throw new Error(`Verified capture ledger does not match export item ${item.request_id}.`);
      const existingPath = resolveLedgerPath(projectRoot, existing.local_path);
      const hashed = await hashLocalCapture(existingPath);
      if (hashed.sizeBytes !== existing.size_bytes || hashed.digest !== existing.content_sha256) {
        throw new Error(`Verified local capture ${item.request_id} no longer matches its ledger.`);
      }
      continue;
    }

    const finalPath = join(tracesDirectory, fileName);
    if (pathExists(finalPath)) {
      const recovered = await hashLocalCapture(finalPath);
      if (recovered.sizeBytes !== item.size || recovered.digest !== item.content_sha256) {
        throw new Error(`Untracked capture file does not match export item ${item.request_id}.`);
      }
      const verified: VerifiedWorkloadCaptureFile = {
        schema_version: "understudy.eval-source-capture.v1",
        request_id: item.request_id,
        capture_key: item.key,
        size_bytes: recovered.sizeBytes,
        content_sha256: recovered.digest,
        local_path: expectedLocalPath,
      };
      verifiedByKey.set(item.key, verified);
      await input.onVerified(verified);
      continue;
    }
    const downloaded = await downloadReceiptDrivenCapture(item, finalPath, input.gatewayUrl);
    const verified: VerifiedWorkloadCaptureFile = {
      schema_version: "understudy.eval-source-capture.v1",
      request_id: item.request_id,
      capture_key: item.key,
      size_bytes: downloaded.sizeBytes,
      content_sha256: downloaded.digest,
      local_path: expectedLocalPath,
    };
    verifiedByKey.set(item.key, verified);
    await input.onVerified(verified);
  }
  return { header, items, manifest_sha256: manifestSha256 };
}

function assertWorkloadManifestLineage(
  exportData: WorkloadCaptureExportResponse,
  header: WorkloadCaptureExportManifestHeader,
  items: WorkloadCaptureExportManifestItem[],
  manifestSha256: string,
): void {
  const chain = exportData.chain;
  for (const key of ["chain_id", "segment_id", "segment_index", "previous_manifest_sha256", "terminal"] as const) {
    if (header[key] !== chain[key]) throw new Error(`Capture export manifest ${key} does not match its response.`);
  }
  if (
    manifestSha256 !== chain.manifest_sha256 ||
    header.cumulative_scanned !== chain.cumulative_scanned ||
    header.cumulative_matched !== chain.cumulative_matched ||
    header.cumulative_exported !== chain.cumulative_exported ||
    header.cumulative_total_bytes !== chain.cumulative_total_bytes
  ) throw new Error("Capture export manifest cumulative lineage does not match its response.");
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  if (items.length !== exportData.count || totalBytes !== exportData.total_bytes) {
    throw new Error("Capture export manifest totals do not match its response.");
  }
  if (chain.terminal === exportData.truncated) {
    throw new Error("Capture export terminal state is inconsistent.");
  }
  if (chain.terminal) {
    if (!chain.terminal_receipt || exportData.resume_cursor) {
      throw new Error("Terminal capture export segment is missing its receipt.");
    }
  } else if (!exportData.resume_cursor || chain.terminal_receipt) {
    throw new Error("Non-terminal capture export segment is missing its resume cursor.");
  }
}

async function downloadReceiptDrivenCapture(
  item: WorkloadCaptureExportManifestItem,
  finalPath: string,
  gatewayUrl: string,
): Promise<{ digest: string; sizeBytes: number }> {
  const url = allowedCaptureUrl(item.url, gatewayUrl);
  const partialPath = `${finalPath}.partial`;
  let descriptor: number | null = null;
  let complete = false;
  try {
    const download = await fetch(url, {
      headers: { Accept: "application/x-ndjson" },
      redirect: "error",
      signal: AbortSignal.timeout(CAPTURE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!download.ok) throw new Error(`Capture ${item.request_id} download failed with status ${download.status}.`);
    const declaredLength = download.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) !== item.size) {
      throw new Error(`Capture ${item.request_id} content length does not match its authenticated manifest size.`);
    }
    if (!download.body) throw new Error(`Capture ${item.request_id} download returned no body.`);
    descriptor = openSync(partialPath, "wx", 0o600);
    const hash = createHash("sha256");
    const reader = download.body.getReader();
    let sizeBytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      try {
        sizeBytes = reserveReceiptDrivenChunk(item.request_id, sizeBytes, chunk.value.byteLength, item.size);
      } catch (error) {
        await reader.cancel();
        throw error;
      }
      hash.update(chunk.value);
      let written = 0;
      while (written < chunk.value.byteLength) {
        const count = writeSync(descriptor, chunk.value, written, chunk.value.byteLength - written);
        if (count <= 0) throw new Error(`Capture ${item.request_id} could not be written completely.`);
        written += count;
      }
    }
    if (sizeBytes !== item.size) {
      throw new Error(`Capture ${item.request_id} ended before its authenticated manifest size.`);
    }
    closeSync(descriptor);
    descriptor = null;
    const digest = hash.digest("hex");
    if (digest !== item.content_sha256) {
      throw new Error(`Capture ${item.request_id} failed authenticated SHA-256 verification.`);
    }
    renameSync(partialPath, finalPath);
    complete = true;
    return { digest, sizeBytes };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (!complete) rmSync(partialPath, { force: true });
  }
}

function resolveLedgerPath(projectRoot: string, localPath: string): string {
  const absolute = resolve(projectRoot, localPath);
  const relativePath = relative(projectRoot, absolute);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("Verified capture ledger path leaves the eval project.");
  }
  return absolute;
}

async function hashLocalCapture(path: string): Promise<{ digest: string; sizeBytes: number }> {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Verified capture must be a real file: ${path}.`);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { digest: hash.digest("hex"), sizeBytes };
}

function allowedCaptureUrl(raw: string, gatewayUrl: string): string {
  const url = new URL(raw);
  if (url.username || url.password) throw new Error("Capture download URL must not contain credentials.");
  const trustedR2 = url.protocol === "https:" && (url.port === "" || url.port === "443") && /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/i.test(url.hostname);
  if (trustedR2) return url.toString();
  const gateway = new URL(gatewayUrl);
  const loopback = ["127.0.0.1", "::1", "[::1]", "localhost"].includes(gateway.hostname);
  if (loopback && url.origin === gateway.origin && ["http:", "https:"].includes(url.protocol)) return url.toString();
  throw new Error(`Refusing capture download from untrusted origin ${url.origin}.`);
}

function portableCaptureFileName(requestId: string, suffix = ""): string {
  const tail = `${suffix}${CAPTURE_FILE_EXTENSION}`;
  const stemBytes = MAX_PORTABLE_FILE_NAME_BYTES - Buffer.byteLength(tail);
  if (stemBytes < 1) throw new Error(`Capture filename suffix is too long for request ${requestId}.`);
  return `${safeFileStem(requestId, stemBytes)}${tail}`;
}

function portableFileNameKey(fileName: string): string {
  return fileName.toLowerCase();
}

function safeFileStem(value: string, maxBytes: number): string {
  let safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/[. ]+$/g, "");
  if (!safe || safe === "." || safe === "..") safe = "request";
  if (WINDOWS_RESERVED_BASENAME.test(safe)) safe = `_${safe}`;

  // The replacement above guarantees ASCII, so code units and UTF-8 bytes
  // have the same length. Trim again in case truncation lands on a dot.
  safe = safe.slice(0, maxBytes).replace(/[. ]+$/g, "");
  if (!safe) safe = "request".slice(0, maxBytes);
  if (WINDOWS_RESERVED_BASENAME.test(safe)) safe = `_${safe}`.slice(0, maxBytes);
  return safe;
}
