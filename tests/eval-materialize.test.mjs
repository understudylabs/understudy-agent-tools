import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  downloadExport,
  MAX_CAPTURE_BYTES,
  MAX_COHORT_BYTES,
  reserveDownloadedChunk,
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
