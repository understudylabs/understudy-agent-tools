import { createHash } from "node:crypto";
import { closeSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

import { createPrivateDirectory, pathExists, writePrivateJson } from "./build-state.js";
import { type CohortExport } from "./contracts.js";

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

export function allowedCaptureUrl(raw: string, gatewayUrl: string): string {
  const url = new URL(raw);
  if (url.username || url.password) throw new Error("Capture download URL must not contain credentials.");
  const trustedR2 = url.protocol === "https:" && (url.port === "" || url.port === "443") && /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/i.test(url.hostname);
  if (trustedR2) return url.toString();
  const gateway = new URL(gatewayUrl);
  const loopback = ["127.0.0.1", "::1", "[::1]", "localhost"].includes(gateway.hostname);
  if (loopback && url.origin === gateway.origin && ["http:", "https:"].includes(url.protocol)) return url.toString();
  throw new Error(`Refusing capture download from untrusted origin ${url.origin}.`);
}

export function portableCaptureFileName(requestId: string, suffix = ""): string {
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
