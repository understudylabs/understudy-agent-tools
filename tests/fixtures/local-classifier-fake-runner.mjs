import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const modeIndex = args.indexOf("--mode");
const mode = modeIndex === -1 ? "success" : args[modeIndex + 1];
const command = args.find((value) => value === "train" || value === "predict");
const requestIndex = args.indexOf("--request");
const request = args.includes("--request-stdin")
  ? JSON.parse(readFileSync(0, "utf8"))
  : JSON.parse(readFileSync(args[requestIndex + 1], "utf8"));

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function directoryEvidence(path) {
  const payload = readFileSync(join(path, "weights.bin"));
  const name = Buffer.from("weights.bin");
  const nameLength = Buffer.alloc(8);
  const payloadLength = Buffer.alloc(8);
  nameLength.writeBigUInt64BE(BigInt(name.length));
  payloadLength.writeBigUInt64BE(BigInt(payload.length));
  return {
    sha256: createHash("sha256").update(nameLength).update(name).update(payloadLength).update(payload).digest("hex"),
    size: payload.length,
  };
}

if (mode === "sleep") {
  setInterval(() => {}, 1_000);
} else if (mode === "fail") {
  process.stderr.write("synthetic runner failure\n");
  process.exitCode = 2;
} else if (command === "predict") {
  const run = JSON.parse(readFileSync(request.run_manifest_path, "utf8"));
  emit({
    schema_version: "understudy.capture_import.classification_prediction.v1",
    run_id: run.run_id,
    text_sha256: createHash("sha256").update(request.text).digest("hex"),
    label: run.model.labels[0],
    scores: [
      { label: run.model.labels[0], score: 0.75 },
      { label: run.model.labels[1], score: 0.25 },
    ],
    model_id: run.model.resolved_id,
    latency_ms: 1.25,
    local_only: true,
  });
} else {
  const dataset = JSON.parse(readFileSync(request.dataset_manifest_path, "utf8"));
  for (const [phase, message] of [
    ["preparing", "Verified local group-aware splits."],
    ["downloading", "Resolved cached test model."],
    ["training", "Finished synthetic epoch."],
    ["evaluating", "Scored reserved holdout."],
    ["saving", "Saved synthetic model."],
  ]) {
    emit({ type: "phase", run_id: request.run_id, phase, message });
  }
  mkdirSync(request.model_path, { recursive: true });
  writeFileSync(join(request.model_path, "weights.bin"), "synthetic-local-weights");
  const model = directoryEvidence(request.model_path);
  const groups = {};
  for (const name of ["train", "dev", "holdout"]) {
    const rows = readFileSync(dataset.splits[name].path, "utf8").trim().split("\n").map(JSON.parse);
    groups[name] = new Set(rows.map((row) => row.group_id)).size;
  }
  emit({
    type: "result",
    result: {
      schema_version: "understudy.capture_import.classification_run.v1",
      run_id: request.run_id,
      generated_at: request.generated_at,
      status: "completed",
      local_only: true,
      data_boundary: { dataset_uploaded: false, telemetry_sent: false, model_download_required: true },
      training: request.training,
      resource_preflight: request.resource_preflight,
      dataset: request.dataset_evidence,
      split_evidence: {
        policy: "deterministic-stratified-group-aware-v2",
        group_key: dataset.split_policy.group_key,
        group_normalization: "casefold-reference-stripping-v1",
        no_group_overlap: true,
        verified_no_group_overlap: true,
        group_counts: groups,
      },
      model: {
        requested_id: request.model_id,
        resolved_id: request.model_id,
        revision: request.model_revision ?? "synthetic-revision",
        format: "transformers-sequence-classification",
        path: request.model_path,
        sha256: model.sha256,
        size_bytes: model.size,
        labels: dataset.labels,
      },
      runtime: {
        runtime_sha256: request.runtime_sha256,
        python_version: "3.12.0-test",
        packages: request.runtime_packages,
        device: "cpu-test",
        seed: request.seed,
      },
      baseline: { name: "majority-class", label: dataset.labels[0], accuracy: 0.5, macro_f1: 1 / 3 },
      linear_baseline: { name: "tfidf-logistic-regression", accuracy: 0.5, macro_f1: 0.5 },
      verdict: {
        status: "promising",
        comparison_baseline: "tfidf-logistic-regression",
        one_run_only: true,
        reason: "Synthetic model cleared the initial bars; repeat validation is required.",
      },
      heldout: {
        row_count: dataset.splits.holdout.row_count,
        accuracy: 1,
        macro_f1: 1,
        latency_ms_p50: 1.25,
        per_class: dataset.labels.map((label) => ({ label, precision: 1, recall: 1, f1: 1, support: 1 })),
        weakest_classes: dataset.labels.map((label) => ({ label, recall: 1, f1: 1, support: 1 })),
        confusion_matrix: { labels: dataset.labels, rows: [[1, 0], [0, 1]] },
        failures: [],
        failure_count: 0,
        failures_truncated: false,
      },
      timings_ms: { total: 10, preparing: 1, downloading: 1, training: 5, evaluating: 2, saving: 1 },
      events_path: request.events_path,
      manifest_path: request.run_manifest_path,
    },
  });
}
