import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  getLocalClassifierRun,
  listLocalClassifierRuns,
  updateLocalClassifierRun,
} from "../dist/local-classifier/registry.js";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runFixture({ runId = "desktop-run-1", status = "completed", generatedAt = "2026-07-16T12:00:00.000Z" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "understudy-classifier-registry-"));
  roots.push(root);
  const captureRoot = join(root, "capture-imports");
  const runRoot = join(captureRoot, "capture-a", "training-runs", runId);
  const modelPath = join(runRoot, "model");
  mkdirSync(modelPath, { recursive: true });
  writeFileSync(join(modelPath, "weights.bin"), "synthetic weights only");
  const manifestPath = join(runRoot, "run-manifest.json");
  const completed = status === "completed";
  const manifest = {
    schema_version: "understudy.capture_import.classification_run.v1",
    run_id: runId,
    generated_at: generatedAt,
    status,
    local_only: true,
    data_boundary: {
      dataset_uploaded: false,
      telemetry_sent: false,
      model_download_required: true,
    },
    model: completed ? {
      requested_id: "answerdotai/ModernBERT-base",
      resolved_id: "answerdotai/ModernBERT-base",
      path: modelPath,
      sha256: sha256("synthetic weights only"),
      size_bytes: 22,
      labels: ["synthetic-a", "synthetic-b"],
    } : null,
    heldout: completed ? {
      row_count: 20,
      accuracy: 0.9,
      macro_f1: 0.875,
      latency_ms_p50: 12.5,
      failure_count: 2,
    } : null,
    verdict: completed ? { status: "promising" } : null,
    timings_ms: { total: 1_234 },
    manifest_path: manifestPath,
    ...(completed ? {} : { error: { code: status, message: `Synthetic ${status} run.` } }),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { root, captureRoot, runRoot, modelPath, manifestPath };
}

describe("local classifier run registry", () => {
  it("discovers completed local runs without copying label values into the summary", () => {
    const data = runFixture();
    const runs = listLocalClassifierRuns({ captureRoot: data.captureRoot });

    assert.equal(runs.length, 1);
    assert.equal(runs[0].model_id, "classifier.desktop-run-1");
    assert.equal(runs[0].display_name, "desktop-run-1");
    assert.equal(runs[0].run_status, "completed");
    assert.equal(runs[0].local_only, true);
    assert.equal(runs[0].model.label_count, 2);
    assert.equal(runs[0].model.available, true);
    assert.equal(runs[0].evaluation.accuracy, 0.9);
    assert.equal(runs[0].evaluation.failure_count, 2);
    assert.doesNotMatch(JSON.stringify(runs), /synthetic-a|synthetic-b/);
  });

  it("renames, archives, and restores through a private sidecar without changing immutable evidence", () => {
    const data = runFixture();
    const immutableBefore = readFileSync(data.manifestPath);
    const archived = updateLocalClassifierRun({
      runManifestPath: data.manifestPath,
      displayName: "Spam detector",
      archived: true,
      now: new Date("2026-07-16T13:00:00.000Z"),
    });

    assert.equal(archived.display_name, "Spam detector");
    assert.equal(archived.archived_at, "2026-07-16T13:00:00.000Z");
    assert.deepEqual(readFileSync(data.manifestPath), immutableBefore);
    assert.equal(listLocalClassifierRuns({ captureRoot: data.captureRoot }).length, 0);
    assert.equal(listLocalClassifierRuns({ captureRoot: data.captureRoot, archived: true })[0].display_name, "Spam detector");
    if (process.platform !== "win32") {
      assert.equal(statSync(join(data.runRoot, "lifecycle.json")).mode & 0o777, 0o600);
    }

    const restored = updateLocalClassifierRun({
      runManifestPath: data.manifestPath,
      archived: false,
      now: new Date("2026-07-16T14:00:00.000Z"),
    });
    assert.equal(restored.archived_at, null);
    assert.equal(restored.display_name, "Spam detector");
    assert.equal(listLocalClassifierRuns({ captureRoot: data.captureRoot }).length, 1);
  });

  it("shows terminal runs for restart recovery and fails closed when a selected sidecar is malformed", () => {
    const failed = runFixture({ runId: "desktop-failed", status: "failed" });
    const run = listLocalClassifierRuns({ captureRoot: failed.captureRoot })[0];
    assert.equal(run.run_status, "failed");
    assert.equal(run.model, null);
    assert.equal(run.failure.code, "failed");

    writeFileSync(join(failed.runRoot, "lifecycle.json"), "{}\n");
    assert.equal(listLocalClassifierRuns({ captureRoot: failed.captureRoot }).length, 0);
    assert.throws(() => getLocalClassifierRun(failed.manifestPath), /lifecycle record.*malformed/);
  });

  it("rejects unsafe names and invalid list bounds", () => {
    const data = runFixture();
    assert.throws(() => updateLocalClassifierRun({
      runManifestPath: data.manifestPath,
      displayName: "bad\nname",
    }), /printable characters/);
    assert.throws(() => updateLocalClassifierRun({ runManifestPath: data.manifestPath }), /Choose a new display name/);
    assert.throws(() => listLocalClassifierRuns({ captureRoot: data.captureRoot, limit: 0 }), /between 1 and 1,000/);
  });

  it("exposes list and lifecycle updates through the public CLI", () => {
    const data = runFixture();
    const list = spawnSync(process.execPath, [
      resolve("dist/bin.js"),
      "capture-import",
      "list-classification-runs",
      "--capture-root",
      data.captureRoot,
      "--json",
    ], { encoding: "utf8" });
    assert.equal(list.status, 0, list.stderr);
    const listed = JSON.parse(list.stdout);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].run_id, "desktop-run-1");
    assert.doesNotMatch(list.stdout, /synthetic-a|synthetic-b/);

    const archive = spawnSync(process.execPath, [
      resolve("dist/bin.js"),
      "capture-import",
      "classification-run",
      "--run-manifest",
      data.manifestPath,
      "--name",
      "Inbox filter",
      "--archive",
      "--json",
    ], { encoding: "utf8" });
    assert.equal(archive.status, 0, archive.stderr);
    const archived = JSON.parse(archive.stdout);
    assert.equal(archived.display_name, "Inbox filter");
    assert.ok(archived.archived_at);
  });
});
