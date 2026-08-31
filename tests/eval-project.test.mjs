import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildWorkloadEvalProject } from "../dist/eval-project.js";

test("a repeated capture key across export segments cannot complete a workload eval build", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-eval-project-"));
  const output = join(root, "weekly");
  const scope = {
    schema_version: "understudy.export-scope.v1",
    selector: "workload-window",
    org_id: "org_synthetic",
    project_id: "proj_synthetic",
    workload_id: "workload_synthetic",
    from: "2026-08-23T12:00:00.000Z",
    to: "2026-08-30T12:00:00.000Z",
    ingestion_cutoff: "2026-08-30T12:00:00.000Z",
  };
  const repeatedCapture = {
    schema_version: "understudy.eval-source-capture.v1",
    request_id: "req_repeated",
    capture_key: "org_synthetic/proj_synthetic/workload_synthetic/req_repeated.jsonl",
    size_bytes: 17,
    content_sha256: "a".repeat(64),
    local_path: "source/traces/req_repeated.jsonl",
  };
  const terminalManifestSha256 = "c".repeat(64);

  try {
    assert.throws(
      () => buildWorkloadEvalProject({
        output,
        name: "duplicate-segment-week",
        identity: {
          org_id: scope.org_id,
          project_id: scope.project_id,
          workload_id: scope.workload_id,
          workload_name: "synthetic",
        },
        canonicalScope: scope,
        // Each entry represents one segment. The project ledger deduplicates
        // their shared key, while the terminal receipt counts both exports.
        verifiedFiles: [repeatedCapture, repeatedCapture],
        segmentManifestSha256: ["b".repeat(64), terminalManifestSha256],
        terminalReceipt: "signed-terminal-receipt",
        verifiedReceipt: {
          verified: true,
          scope_hash: "d".repeat(64),
          chain_id: "chain_duplicate_segment",
          segment_id: "e".repeat(64),
          segment_index: 1,
          manifest_sha256: terminalManifestSha256,
          previous_manifest_sha256: "b".repeat(64),
          cumulative_scanned: 2,
          cumulative_matched: 2,
          cumulative_exported: 2,
          total_bytes: repeatedCapture.size_bytes * 2,
          local_index_sha256: "f".repeat(64),
          expires_at: "2026-08-30T13:00:00.000Z",
          canonical_scope: scope,
          source_attestation: "signed-duplicate-segment-source-attestation",
        },
        now: new Date("2026-08-30T12:00:00.000Z"),
      }),
      /receipt totals do not match unique materialized captures/i,
    );
    assert.equal(existsSync(join(output, "eval-project.json")), false);
    assert.equal(existsSync(join(output, "source", "index.jsonl")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
