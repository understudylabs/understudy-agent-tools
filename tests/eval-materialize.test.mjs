import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  downloadExport,
  materializeWorkloadExportSegment,
  MAX_CAPTURE_BYTES,
  MAX_COHORT_BYTES,
  reserveDownloadedChunk,
  reserveReceiptDrivenChunk,
} from "../dist/evals/materialize.js";

describe("eval materialization byte budgets", () => {
  it("accepts exact limits and rejects the next byte before reserving it", () => {
    const exactCapture = { used: MAX_COHORT_BYTES - MAX_CAPTURE_BYTES };
    assert.equal(
      reserveDownloadedChunk("req_exact", 0, MAX_CAPTURE_BYTES, exactCapture),
      MAX_CAPTURE_BYTES,
    );
    assert.equal(exactCapture.used, MAX_COHORT_BYTES);

    const captureOverflow = { used: 0 };
    assert.throws(
      () => reserveDownloadedChunk("req_capture", MAX_CAPTURE_BYTES, 1, captureOverflow),
      /Capture req_capture exceeds/,
    );
    assert.equal(captureOverflow.used, 0);

    const cohortOverflow = { used: MAX_COHORT_BYTES };
    assert.throws(
      () => reserveDownloadedChunk("req_cohort", 0, 1, cohortOverflow),
      /Cohort payloads exceed/,
    );
    assert.equal(cohortOverflow.used, MAX_COHORT_BYTES);
  });
});

describe("eval materialization filenames", () => {
  it("bounds long request IDs and avoids Windows device basenames", async () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-eval-materialize-"));
    const asciiRequestId = "a".repeat(400);
    const unicodeRequestId = `${"a".repeat(400)}${"界".repeat(200)}`;
    const bodies = new Map([
      [asciiRequestId, '{"capture":"ascii"}\n'],
      [unicodeRequestId, '{"capture":"unicode"}\n'],
      ["CON", '{"capture":"reserved"}\n'],
    ]);
    const captures = [...bodies].map(([request_id, body], index) => ({
      request_id,
      content_sha256: createHash("sha256").update(body).digest("hex"),
      url: `http://localhost:8787/captures/${index}`,
    }));
    const exportData = {
      export_id: "export_portable_names",
      cohort_id: "cohort_portable_names",
      cohort_sha256: "f".repeat(64),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      captures,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const capture = captures[Number(new URL(url).pathname.split("/").at(-1))];
      return new Response(bodies.get(capture.request_id), {
        headers: { "content-length": String(Buffer.byteLength(bodies.get(capture.request_id))) },
      });
    };

    try {
      const first = join(root, "first");
      const second = join(root, "second");
      await downloadExport(exportData, "workload_portable_names", first, "http://localhost:8787");
      await downloadExport(exportData, "workload_portable_names", second, "http://localhost:8787");

      const firstPaths = JSON.parse(readFileSync(join(first, "cohort-manifest.json"), "utf8"))
        .captures.map((capture) => capture.path);
      const secondPaths = JSON.parse(readFileSync(join(second, "cohort-manifest.json"), "utf8"))
        .captures.map((capture) => capture.path);

      assert.deepEqual(firstPaths, secondPaths, "portable filenames must be deterministic");
      assert.equal(new Set(firstPaths.map((path) => path.toLowerCase())).size, firstPaths.length);
      assert.ok(firstPaths.every((path) => Buffer.byteLength(path) <= 240));
      assert.equal(firstPaths[2], "_CON.jsonl");
      assert.match(firstPaths[1], new RegExp(`-${captures[1].content_sha256.slice(0, 12)}\\.jsonl$`));
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("complete workload export materialization", () => {
  it("resumes without redownloading verified files and uses manifest sizes instead of sample-era limits", async () => {
    assert.equal(
      reserveReceiptDrivenChunk("req_large", 256 * 1024 * 1024, 1, 300 * 1024 * 1024),
      256 * 1024 * 1024 + 1,
      "the full-corpus path must not retain the old 16 MiB or 256 MiB ceilings",
    );

    const root = mkdtempSync(join(tmpdir(), "understudy-workload-export-"));
    const traces = join(root, "source", "traces");
    const bodies = new Map([
      ["req-a", '{"capture":"a"}\n'],
      ["req-b", '{"capture":"b"}\n'],
    ]);
    const items = [...bodies].map(([request_id, body]) => ({
      request_id,
      key: `org/proj/apk/2026/08/30/${request_id}.jsonl`,
      size: Buffer.byteLength(body),
      url: `http://localhost:8787/captures/${request_id}`,
    }));
    const header = {
      record_type: "understudy_capture_export_chain_v1",
      chain_id: "chain-1",
      segment_id: "a".repeat(64),
      segment_index: 0,
      previous_manifest_sha256: null,
      cumulative_scanned: 2,
      cumulative_matched: 2,
      cumulative_exported: 2,
      cumulative_total_bytes: items.reduce((sum, item) => sum + item.size, 0),
      terminal: true,
    };
    const manifest = `${JSON.stringify(header)}\n${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
    const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
    const response = {
      export_id: "exp-1",
      count: 2,
      total_bytes: items.reduce((sum, item) => sum + item.size, 0),
      manifest_url: "http://localhost:8787/manifests/segment-0",
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      truncated: false,
      canonical_scope: {
        schema_version: "understudy.export-scope.v1",
        selector: "workload-window",
        org_id: "org",
        project_id: "proj",
        workload_id: "workload",
        from: "2026-08-23T00:00:00.000Z",
        to: "2026-08-30T00:00:00.000Z",
        ingestion_cutoff: "2026-08-30T00:00:01.000Z",
      },
      chain: {
        chain_id: "chain-1",
        segment_id: header.segment_id,
        segment_index: 0,
        previous_manifest_sha256: null,
        manifest_sha256: manifestSha256,
        cumulative_scanned: 2,
        cumulative_matched: 2,
        cumulative_exported: 2,
        cumulative_total_bytes: responseTotal(items),
        terminal: true,
        terminal_receipt: "signed-terminal-receipt",
      },
    };
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (rawUrl) => {
      const url = new URL(rawUrl);
      requests.push(url.pathname);
      if (url.pathname === "/manifests/segment-0") return new Response(manifest);
      const requestId = url.pathname.split("/").at(-1);
      const body = bodies.get(requestId);
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)) } });
    };

    const verified = [];
    let interruptedFile;
    try {
      await assert.rejects(
        materializeWorkloadExportSegment({
          exportData: response,
          tracesDirectory: traces,
          gatewayUrl: "http://localhost:8787",
          verifiedFiles: verified,
          onVerified(file) {
            interruptedFile = file;
            throw new Error("synthetic interruption");
          },
        }),
        /synthetic interruption/,
      );
      assert.equal(verified.length, 0, "the simulated crash happens before checkpoint persistence");
      assert.equal(existsSync(join(root, interruptedFile.local_path)), true);
      const firstDownloadedPath = requests.find((path) => path.startsWith("/captures/"));

      const resumed = await materializeWorkloadExportSegment({
        exportData: response,
        tracesDirectory: traces,
        gatewayUrl: "http://localhost:8787",
        verifiedFiles: verified,
        onVerified(file) {
          verified.push(file);
        },
      });
      assert.equal(resumed.manifest_sha256, manifestSha256);
      assert.equal(verified.length, 2);
      assert.equal(
        requests.filter((path) => path === firstDownloadedPath).length,
        1,
        "an atomically published capture from the crash window must be adopted, not downloaded again",
      );
      assert.deepEqual(verified.map((file) => file.request_id).sort(), ["req-a", "req-b"]);

      const captureRequests = requests.filter((path) => path.startsWith("/captures/")).length;
      await materializeWorkloadExportSegment({
        exportData: response,
        tracesDirectory: traces,
        gatewayUrl: "http://localhost:8787",
        verifiedFiles: verified,
        onVerified() {
          throw new Error("verified files must not be checkpointed twice");
        },
      });
      assert.equal(
        requests.filter((path) => path.startsWith("/captures/")).length,
        captureRequests,
        "checkpointed captures must be rehashed locally, not downloaded again",
      );
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function responseTotal(items) {
  return items.reduce((sum, item) => sum + item.size, 0);
}
