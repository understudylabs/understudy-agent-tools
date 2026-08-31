import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildWorkloadEvalProject } from "../dist/eval-project.js";

const scope = {
  schema_version: "understudy.export-scope.v1",
  selector: "workload-window",
  org_id: "org_synthetic",
  project_id: "proj_synthetic",
  workload_id: "workload_synthetic",
  from: "2026-08-29T00:00:00.000Z",
  to: "2026-08-30T00:00:00.000Z",
  ingestion_cutoff: "2026-08-30T00:00:01.000Z",
};

function source(output, captureCount = 1, skippedCount = 0) {
  return {
    outputDirectory: output,
    indexPath: join(output, "source", "index.jsonl"),
    canonicalScope: scope,
    captureCount,
    sizeBytes: captureCount === 0 ? 0 : 17,
    indexSha256: "a".repeat(64),
    requestedCount: captureCount + skippedCount,
    skippedCount,
    writtenCount: captureCount,
    adoptedCount: 0,
  };
}

test("an empty raw dump cannot create an unusable workload eval project", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-empty-eval-project-"));
  const output = join(root, "empty-day");
  try {
    assert.throws(
      () => buildWorkloadEvalProject({
        output,
        name: "empty-day",
        identity: { org_id: scope.org_id, project_id: scope.project_id, workload_id: scope.workload_id, workload_name: "synthetic" },
        source: source(output, 0),
        now: new Date("2026-08-30T00:00:01.000Z"),
      }),
      /no captures were exported.*refusing to create an empty eval project/i,
    );
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a one-day raw dump creates only local index provenance in the project manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-eval-project-"));
  const output = join(root, "one-day");
  try {
    mkdirSync(join(output, "source"), { recursive: true });
    writeFileSync(join(output, "source", "index.jsonl"), "{}\n");
    writeFileSync(join(output, "source", "skipped.jsonl"), "{\"request_id\":\"missing\"}\n");
    const project = buildWorkloadEvalProject({
      output,
      name: "one-day",
      identity: { org_id: scope.org_id, project_id: scope.project_id, workload_id: scope.workload_id, workload_name: "synthetic" },
      source: source(output, 1, 1),
      now: new Date("2026-08-30T00:00:01.000Z"),
    });
    assert.deepEqual(Object.keys(project.source).sort(), [
      "capture_count", "index", "index_sha256", "materialized_count", "requested_count",
      "size_bytes", "skipped_count", "skipped_index", "window",
    ]);
    assert.equal(project.source.capture_count, 1);
    assert.equal(project.source.requested_count, 2);
    assert.equal(project.source.materialized_count, 1);
    assert.equal(project.source.skipped_count, 1);
    assert.equal(project.source.skipped_index, "source/skipped.jsonl");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
