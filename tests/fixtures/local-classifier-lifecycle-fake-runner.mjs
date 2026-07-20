import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const command = args.find((value) => value === "evaluate" || value === "predict-batch");
const request = JSON.parse(readFileSync(0, "utf8"));
const run = JSON.parse(readFileSync(request.run_manifest_path, "utf8"));

if (command === "evaluate") {
  const holdout = readFileSync(request.holdout_path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const labels = run.model.labels;
  const support = holdout.length / labels.length;
  process.stdout.write(`${JSON.stringify({
    schema_version: "understudy.local_classifier.repeat_evaluation.runtime.v1",
    run_id: run.run_id,
    row_count: holdout.length,
    accuracy: 1,
    macro_f1: 1,
    latency_ms_p50: 1.5,
    per_class: labels.map((label) => ({ label, precision: 1, recall: 1, f1: 1, support })),
    weakest_classes: labels.map((label) => ({ label, recall: 1, f1: 1, support })),
    confusion_matrix: { labels, rows: labels.map((_, index) => labels.map((__, column) => index === column ? support : 0)) },
    failures: [],
    failure_count: 0,
    failures_truncated: false,
    predictions_sha256: createHash("sha256").update("synthetic predictions").digest("hex"),
    device: "cpu-test",
    local_only: true,
  })}\n`);
} else if (command === "predict-batch") {
  process.stdout.write(`${JSON.stringify({
    schema_version: "understudy.local_classifier.batch_prediction.runtime.v1",
    run_id: run.run_id,
    row_count: request.rows.length,
    rows: request.rows.map((row, index) => ({
      row_index: row.row_index,
      label: run.model.labels[index % run.model.labels.length],
      confidence: 0.8,
      latency_ms: 1.25,
    })),
    device: "cpu-test",
    local_only: true,
  })}\n`);
} else {
  process.stderr.write("unknown lifecycle command\n");
  process.exitCode = 2;
}
