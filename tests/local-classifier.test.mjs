import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_CLASSIFIER_MODEL,
  predictLocalClassifier,
  startLocalClassifierTraining,
  trainLocalClassifier,
} from "../dist/local-classifier/index.js";

const roots = [];
const fakeRunner = resolve("tests/fixtures/local-classifier-fake-runner.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture({ schema = "understudy.capture_import.classification_dataset.v2", overlap = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "understudy-local-classifier-"));
  roots.push(root);
  const labels = ["meals", "travel"];
  const splits = {};
  const groupNames = {
    train: ["merchant-a", "merchant-b"],
    dev: ["merchant-c", "merchant-d"],
    holdout: overlap ? ["merchant-a", "merchant-f"] : ["merchant-e", "merchant-f"],
  };
  for (const [name, groups] of Object.entries(groupNames)) {
    const rows = groups.map((group, index) => ({
      schema_version: "understudy.classification_example.v2",
      example_id: `${name}-${index}`,
      group_id: sha256(group).slice(0, 24),
      text: `merchant: ${group}\ndescription: ${index ? "flight" : "lunch"}`,
      label: labels[index % labels.length],
    }));
    const content = `${rows.map(JSON.stringify).join("\n")}\n`;
    const path = join(root, `${name}.jsonl`);
    writeFileSync(path, content);
    splits[name] = { path, row_count: rows.length, sha256: sha256(content) };
  }
  const artifactRoot = join(root, "dataset-artifacts");
  mkdirSync(artifactRoot);
  const manifestPath = join(artifactRoot, "dataset-manifest.json");
  const manifest = {
    schema_version: schema,
    dataset_id: "dataset-test-v2",
    source_sha256: "a".repeat(64),
    mapping_sha256: "b".repeat(64),
    labels,
    split_policy: {
      name: "deterministic-stratified-group-aware-v2",
      group_key: "merchant",
      group_normalization: "casefold-reference-stripping-v1",
      no_group_overlap: true,
    },
    splits,
    artifact_root: artifactRoot,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, artifactRoot, manifestPath, manifest };
}

describe("local classifier training backend", () => {
  it("fails closed before starting a runner for legacy or leaky splits", () => {
    const legacy = fixture({ schema: "understudy.capture_import.classification_dataset.v1" });
    assert.throws(() => startLocalClassifierTraining({
      datasetManifestPath: legacy.manifestPath,
      runId: "legacy",
      runnerOverride: { command: process.execPath, args: [fakeRunner] },
    }), /requires .*classification_dataset\.v2/);

    const leaky = fixture({ overlap: true });
    assert.throws(() => startLocalClassifierTraining({
      datasetManifestPath: leaky.manifestPath,
      runId: "leaky",
      runnerOverride: { command: process.execPath, args: [fakeRunner] },
    }), /Group leakage detected/);

    const disk = fixture();
    assert.throws(() => startLocalClassifierTraining({
      datasetManifestPath: disk.manifestPath,
      runId: "disk-full",
      outputRoot: join(disk.root, "runs"),
      runnerOverride: { command: process.execPath, args: [fakeRunner] },
      _minimumAvailableBytesForTests: Number.MAX_SAFE_INTEGER,
    }), /needs 9007199254740991 bytes, \d+ available/);
  });

  it("persists immutable local evidence from a deterministic fake runner and predicts without retaining text", async () => {
    const data = fixture();
    const outputRoot = join(data.root, "runs");
    const runtimeRoot = join(data.root, "runtime");
    const events = [];
    const result = await trainLocalClassifier({
      datasetManifestPath: data.manifestPath,
      runId: "expense-demo",
      outputRoot,
      runtimeRoot,
      runnerOverride: { command: process.execPath, args: [fakeRunner] },
      onEvent: (event) => events.push(event),
      now: new Date("2026-07-15T12:00:00.000Z"),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.model.requested_id, DEFAULT_CLASSIFIER_MODEL);
    assert.equal(result.data_boundary.dataset_uploaded, false);
    assert.equal(result.data_boundary.telemetry_sent, false);
    assert.deepEqual(result.training, { epochs: 3, batch_size: 8, learning_rate: 0.00002, max_length: 256 });
    assert.ok(result.resource_preflight.required_available_bytes >= 6 * 1024 ** 3);
    assert.ok(result.resource_preflight.available_bytes >= result.resource_preflight.required_available_bytes);
    assert.equal(result.split_evidence.verified_no_group_overlap, true);
    assert.deepEqual(result.split_evidence.group_counts, { train: 2, dev: 2, holdout: 2 });
    assert.equal(result.linear_baseline.name, "tfidf-logistic-regression");
    assert.equal(result.verdict.status, "promising");
    assert.equal(result.verdict.one_run_only, true);
    assert.equal(result.heldout.weakest_classes.length, 2);
    assert.equal(result.heldout.latency_ms_p50, 1.25);
    assert.deepEqual(events.map((event) => event.type === "phase" ? event.phase : event.type), [
      "preparing", "downloading", "training", "evaluating", "saving", "result",
    ]);
    const persisted = JSON.parse(readFileSync(result.manifest_path, "utf8"));
    assert.deepEqual(persisted, result);
    const eventRows = readFileSync(result.events_path, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(eventRows.at(-1).type, "result");
    assert.doesNotMatch(JSON.stringify(result.heldout.failures), /merchant:/);
    if (process.platform !== "win32") {
      assert.equal(statSync(result.manifest_path).mode & 0o777, 0o600);
      assert.equal(statSync(result.events_path).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(result.manifest_path)).mode & 0o777, 0o700);
    }
    assert.throws(() => startLocalClassifierTraining({
      datasetManifestPath: data.manifestPath,
      runId: "expense-demo",
      outputRoot,
      runtimeRoot,
      runnerOverride: { command: process.execPath, args: [fakeRunner] },
    }), /already exists/);

    const text = "merchant: new cafe\ndescription: team lunch";
    const prediction = predictLocalClassifier({
      runManifestPath: result.manifest_path,
      text,
      runtimeRoot,
      runnerOverride: { command: process.execPath, args: [fakeRunner] },
    });
    assert.equal(prediction.schema_version, "understudy.capture_import.classification_prediction.v1");
    assert.equal(prediction.text_sha256, sha256(text));
    assert.equal(prediction.label, "meals");
    assert.equal(prediction.model_id, "classifier.expense-demo");
    assert.equal(prediction.base_model_id, result.model.resolved_id);
    assert.equal(prediction.local_only, true);
    assert.doesNotMatch(JSON.stringify(prediction), /new cafe/);
    assert.equal(existsSync(join(dirname(result.manifest_path), ".prediction-requests")), false);

    const runtimePack = join(runtimeRoot, "runtime-packs", readdirSync(join(runtimeRoot, "runtime-packs"))[0]);
    const runtimeSpecPath = join(runtimePack, "runtime-spec.json");
    const runtimeSpec = readFileSync(runtimeSpecPath, "utf8");
    writeFileSync(runtimeSpecPath, `${JSON.stringify({ modified: true })}\n`);
    assert.throws(() => predictLocalClassifier({
      runManifestPath: result.manifest_path,
      text,
      runtimeRoot,
      runnerOverride: { command: process.execPath, args: [fakeRunner] },
    }), /runtime spec was modified/);
    writeFileSync(runtimeSpecPath, runtimeSpec);

    writeFileSync(join(result.model.path, "weights.bin"), "tampered-local-weights");
    assert.throws(() => predictLocalClassifier({
      runManifestPath: result.manifest_path,
      text,
      runtimeRoot,
      runnerOverride: { command: process.execPath, args: [fakeRunner] },
    }), /saved classifier changed/);
  });

  it("records failed and cancelled terminal runs without inventing metrics", async () => {
    const failedData = fixture();
    const failed = await trainLocalClassifier({
      datasetManifestPath: failedData.manifestPath,
      runId: "failed-run",
      outputRoot: join(failedData.root, "runs"),
      runtimeRoot: join(failedData.root, "runtime"),
      runnerOverride: { command: process.execPath, args: [fakeRunner, "--mode", "fail"] },
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.model, null);
    assert.equal(failed.heldout, null);
    assert.equal(failed.verdict, null);
    assert.match(failed.error.message, /synthetic runner failure/);

    const cancelledData = fixture();
    const job = startLocalClassifierTraining({
      datasetManifestPath: cancelledData.manifestPath,
      runId: "cancelled-run",
      outputRoot: join(cancelledData.root, "runs"),
      runtimeRoot: join(cancelledData.root, "runtime"),
      runnerOverride: { command: process.execPath, args: [fakeRunner, "--mode", "sleep"] },
    });
    job.cancel();
    const cancelled = await job.completion;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.baseline, null);
    assert.equal(cancelled.linear_baseline, null);
    assert.equal(cancelled.heldout, null);
    assert.ok(job.child.exitCode !== null || job.child.signalCode !== null);
  });
});

if (process.env.UNDERSTUDY_REAL_TRAINING_SMOKE === "1") {
  it("runs the opt-in real uv training bridge with a lightweight configurable model", async () => {
    const data = fixture();
    const runtimeRoot = process.env.UNDERSTUDY_CLASSIFIER_SMOKE_RUNTIME_ROOT ?? join(data.root, "runtime");
    const result = await trainLocalClassifier({
      datasetManifestPath: data.manifestPath,
      runId: "real-smoke",
      outputRoot: join(data.root, "runs"),
      runtimeRoot,
      modelId: process.env.UNDERSTUDY_CLASSIFIER_SMOKE_MODEL ?? "prajjwal1/bert-tiny",
      epochs: 1,
      batchSize: 2,
      maxLength: 32,
    });
    assert.equal(result.status, "completed", result.error?.message);
    assert.ok(result.heldout.latency_ms_p50 >= 0);
    const prediction = predictLocalClassifier({
      runManifestPath: result.manifest_path,
      runtimeRoot,
      text: "merchant: airport cafe\ndescription: breakfast",
      maxLength: 32,
    });
    assert.ok(result.model.labels.includes(prediction.label));
    assert.ok(prediction.latency_ms >= 0);
  });
}
