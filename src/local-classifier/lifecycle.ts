import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import { readCaptureDelimitedTable } from "../capture-import.js";
import {
  DEFAULT_CLASSIFIER_RUNTIME_PACKAGES,
  type ClassificationTrainingRunManifest,
  type LocalClassifierRunnerOverride,
} from "./index.js";
import { localClassifierLifecycleRuntimeSource } from "./lifecycle-runtime-source.js";
import { getLocalClassifierRun } from "./registry.js";

const RUN_SCHEMA = "understudy.capture_import.classification_run.v1";
const DATASET_SCHEMA = "understudy.capture_import.classification_dataset.v2";
const REPEAT_RUNTIME_SCHEMA = "understudy.local_classifier.repeat_evaluation.runtime.v1";
const REPEAT_SCHEMA = "understudy.local_classifier.repeat_evaluation.v1";
const BATCH_RUNTIME_SCHEMA = "understudy.local_classifier.batch_prediction.runtime.v1";
const EXPORT_SCHEMA = "understudy.local_classifier.prediction_export.v1";
const MAX_EXPORT_ROWS = 10_000;
const MAX_RUNTIME_BUFFER_BYTES = 64 * 1024 * 1024;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type DatasetManifest = {
  schema_version: typeof DATASET_SCHEMA;
  source_path: string;
  source_sha256: string;
  mapping_sha256: string;
  mapping: {
    input_columns: string[];
    label_column: string;
    group_column: string;
    text_template: "named-fields-v1";
  };
  labels: string[];
  splits: {
    holdout: { path: string; row_count: number; sha256: string };
  };
};

type RuntimePack = {
  cacheRoot: string;
  path: string;
  sha256: string;
  packages: readonly string[];
};

type RuntimeEvaluation = {
  schema_version: typeof REPEAT_RUNTIME_SCHEMA;
  run_id: string;
  row_count: number;
  accuracy: number;
  macro_f1: number;
  latency_ms_p50: number;
  per_class: Array<{ label: string; precision: number; recall: number; f1: number; support: number }>;
  weakest_classes: Array<{ label: string; recall: number; f1: number; support: number }>;
  confusion_matrix: { labels: string[]; rows: number[][] };
  failures: Array<{
    example_id: string;
    group_id: string;
    text_sha256: string;
    expected_label: string;
    predicted_label: string;
  }>;
  failure_count: number;
  failures_truncated: boolean;
  predictions_sha256: string;
  device: string;
  local_only: true;
};

export type RepeatLocalClassifierEvaluationOptions = {
  runManifestPath: string;
  evaluationId?: string;
  runtimeRoot?: string;
  maxLength?: number;
  uvBinary?: string;
  runtimePackages?: readonly string[];
  runnerOverride?: LocalClassifierRunnerOverride;
  now?: Date;
};

export type RepeatLocalClassifierEvaluation = {
  schema_version: typeof REPEAT_SCHEMA;
  evaluation_id: string;
  run_id: string;
  model_id: string;
  generated_at: string;
  local_only: true;
  data_boundary: { dataset_uploaded: false; telemetry_sent: false };
  holdout: { path: string; row_count: number; sha256: string };
  initial: { accuracy: number; macro_f1: number; failure_count: number };
  repeat: RuntimeEvaluation;
  comparison: {
    accuracy_delta: number;
    macro_f1_delta: number;
    failure_count_delta: number;
    matches_initial_metrics: boolean;
  };
  verdict: {
    status: "reproduced" | "drift_detected";
    reason: string;
  };
  runtime: { runtime_sha256: string; device: string };
  artifact_path: string;
};

export type ExportLocalClassifierPredictionsOptions = {
  runManifestPath: string;
  sourcePath?: string;
  inputColumns?: string[];
  outputPath?: string;
  runtimeRoot?: string;
  maxLength?: number;
  uvBinary?: string;
  runtimePackages?: readonly string[];
  runnerOverride?: LocalClassifierRunnerOverride;
  now?: Date;
};

export type LocalClassifierPredictionExport = {
  schema_version: typeof EXPORT_SCHEMA;
  run_id: string;
  model_id: string;
  generated_at: string;
  local_only: true;
  data_boundary: { dataset_uploaded: false; telemetry_sent: false };
  source_path: string;
  source_sha256: string;
  input_columns: string[];
  row_count: number;
  predicted_row_count: number;
  skipped_row_count: number;
  output_path: string;
  manifest_path: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isMetric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function writePrivateImmutable(path: string, value: string | Buffer): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function writePrivateAtomic(path: string, value: string): void {
  ensurePrivateDirectory(dirname(path));
  if (existsSync(path)) throw new Error(`Refusing to overwrite an existing local artifact: ${path}`);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, value, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function parseObject(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(value)) throw new Error(`Expected a JSON object: ${path}`);
  return value;
}

function directoryEvidence(path: string): { sha256: string; sizeBytes: number } {
  const digest = createHash("sha256");
  let sizeBytes = 0;
  const visit = (root: string, relativeRoot = "") => {
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(root, entry.name);
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isFile()) {
        const nameBytes = Buffer.from(relative, "utf8");
        const payload = readFileSync(absolute);
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(nameBytes.length));
        digest.update(length).update(nameBytes);
        length.writeBigUInt64BE(BigInt(payload.length));
        digest.update(length).update(payload);
        sizeBytes += payload.length;
      }
    }
  };
  visit(path);
  return { sha256: digest.digest("hex"), sizeBytes };
}

function readCompletedRun(runManifestPath: string): {
  manifestPath: string;
  run: ClassificationTrainingRunManifest;
  dataset: DatasetManifest;
} {
  const manifestPath = resolve(runManifestPath);
  const summary = getLocalClassifierRun(manifestPath);
  if (summary.run_status !== "completed" || !summary.model?.available) {
    throw new Error("Lifecycle operations require a completed classifier whose model files are available.");
  }
  const run = parseObject(manifestPath) as unknown as ClassificationTrainingRunManifest;
  if (run.schema_version !== RUN_SCHEMA || run.status !== "completed" || !run.model || !run.runtime || !run.heldout ||
      run.local_only !== true || run.data_boundary.dataset_uploaded !== false || run.data_boundary.telemetry_sent !== false ||
      resolve(run.manifest_path) !== manifestPath || resolve(run.model.path) !== join(dirname(manifestPath), "model")) {
    throw new Error("The completed classifier failed its immutable local evidence contract.");
  }
  const modelEvidence = directoryEvidence(run.model.path);
  if (modelEvidence.sha256 !== run.model.sha256 || modelEvidence.sizeBytes !== run.model.size_bytes) {
    throw new Error("The saved classifier changed after its immutable run was recorded.");
  }
  const datasetPath = resolve(run.dataset.manifest_path);
  const dataset = parseObject(datasetPath) as unknown as DatasetManifest;
  if (dataset.schema_version !== DATASET_SCHEMA ||
      dataset.source_sha256 !== run.dataset.source_sha256 || dataset.mapping_sha256 !== run.dataset.mapping_sha256 ||
      !isString(dataset.source_path) || !isRecord(dataset.mapping) || dataset.mapping.text_template !== "named-fields-v1" ||
      !Array.isArray(dataset.mapping.input_columns) || !dataset.mapping.input_columns.every(isString) ||
      !Array.isArray(dataset.labels) || JSON.stringify(dataset.labels) !== JSON.stringify(run.model.labels) ||
      !isRecord(dataset.splits?.holdout)) {
    throw new Error("The classifier dataset manifest no longer matches the completed run.");
  }
  const holdout = dataset.splits.holdout;
  const holdoutPath = resolve(holdout.path);
  if (!existsSync(holdoutPath) || !statSync(holdoutPath).isFile() || sha256(readFileSync(holdoutPath)) !== holdout.sha256 ||
      holdout.sha256 !== run.dataset.splits.holdout.sha256 || holdout.row_count !== run.dataset.splits.holdout.row_count) {
    throw new Error("The immutable classifier holdout is unavailable or changed.");
  }
  return { manifestPath, run, dataset };
}

function prepareRuntimePack(runtimeRootInput: string, packages: readonly string[]): RuntimePack {
  if (packages.length === 0 || !packages.every((value) => /^[A-Za-z0-9_.-]+==[^=\s]+$/.test(value))) {
    throw new Error("Classifier lifecycle dependencies must use exact package==version pins.");
  }
  const cacheRoot = resolve(runtimeRootInput);
  const sourceSha256 = sha256(localClassifierLifecycleRuntimeSource);
  const runtimeSha256 = sha256(JSON.stringify({
    schema_version: "understudy.local_classifier.lifecycle_runtime.v1",
    python: "3.12",
    packages,
    source_sha256: sourceSha256,
  }));
  const root = join(cacheRoot, "lifecycle-runtime-packs", runtimeSha256);
  ensurePrivateDirectory(root);
  const path = join(root, "classifier_lifecycle_runtime.py");
  const specPath = join(root, "runtime-spec.json");
  const spec = {
    schema_version: "understudy.local_classifier.lifecycle_runtime.v1",
    runtime_sha256: runtimeSha256,
    python: "3.12",
    packages,
    source_sha256: sourceSha256,
    system_python_required: false,
  };
  if (!existsSync(path)) writePrivateImmutable(path, localClassifierLifecycleRuntimeSource);
  else if (sha256(readFileSync(path)) !== sourceSha256) throw new Error(`Content-addressed lifecycle runtime was modified: ${path}`);
  if (!existsSync(specPath)) writePrivateImmutable(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  else if (JSON.stringify(parseObject(specPath)) !== JSON.stringify(spec)) throw new Error(`Content-addressed lifecycle runtime spec was modified: ${specPath}`);
  return { cacheRoot, path, sha256: runtimeSha256, packages };
}

function runtimeEnvironment(cacheRoot: string): NodeJS.ProcessEnv {
  const cache = join(cacheRoot, "cache");
  ensurePrivateDirectory(cache);
  return {
    ...process.env,
    HF_HUB_DISABLE_TELEMETRY: "1",
    TRANSFORMERS_NO_ADVISORY_WARNINGS: "1",
    DO_NOT_TRACK: "1",
    TOKENIZERS_PARALLELISM: "false",
    UV_CACHE_DIR: join(cache, "uv"),
    HF_HOME: join(cache, "huggingface"),
    HF_HUB_CACHE: join(cache, "huggingface", "hub"),
    TORCH_HOME: join(cache, "torch"),
  };
}

function runLifecycleRuntime(
  command: "evaluate" | "predict-batch",
  request: unknown,
  pack: RuntimePack,
  uvBinary: string,
  override?: LocalClassifierRunnerOverride,
): unknown {
  const invocation = override
    ? { command: override.command, args: [...(override.args ?? []), command, "--request-stdin"] }
    : {
      command: uvBinary,
      args: [
        "run", "--isolated", "--managed-python", "--python", "3.12", "--no-project",
        ...pack.packages.flatMap((dependency) => ["--with", dependency]),
        "python", pack.path, command, "--request-stdin",
      ],
    };
  const result = spawnSync(invocation.command, invocation.args, {
    env: runtimeEnvironment(pack.cacheRoot),
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: MAX_RUNTIME_BUFFER_BYTES,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`Local classifier ${command} failed: ${detail}`);
  }
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "null";
  return JSON.parse(line) as unknown;
}

function validateRuntimeEvaluation(value: unknown, run: ClassificationTrainingRunManifest): RuntimeEvaluation {
  if (!isRecord(value) || value.schema_version !== REPEAT_RUNTIME_SCHEMA || value.run_id !== run.run_id ||
      value.local_only !== true || value.row_count !== run.dataset.splits.holdout.row_count ||
      !isMetric(value.accuracy) || !isMetric(value.macro_f1) || !isNonNegative(value.latency_ms_p50) ||
      !Array.isArray(value.per_class) || !Array.isArray(value.weakest_classes) || !isRecord(value.confusion_matrix) ||
      !Array.isArray(value.failures) || !Number.isSafeInteger(value.failure_count) || Number(value.failure_count) < 0 ||
      typeof value.failures_truncated !== "boolean" || !isString(value.predictions_sha256) ||
      !/^[a-f0-9]{64}$/.test(value.predictions_sha256) || !isString(value.device)) {
    throw new Error("The lifecycle runtime returned invalid repeat-evaluation evidence.");
  }
  const labels = run.model!.labels;
  const perClass = new Map<string, Record<string, unknown>>();
  for (const item of value.per_class) {
    if (!isRecord(item) || !isString(item.label) || perClass.has(item.label) || !isMetric(item.precision) ||
        !isMetric(item.recall) || !isMetric(item.f1) || !Number.isSafeInteger(item.support) || Number(item.support) < 0) {
      throw new Error("Repeat evaluation returned invalid per-class evidence.");
    }
    perClass.set(item.label, item);
  }
  if (JSON.stringify([...perClass.keys()].sort()) !== JSON.stringify([...labels].sort())) {
    throw new Error("Repeat evaluation did not cover every classifier label.");
  }
  const matrix = value.confusion_matrix;
  if (!Array.isArray(matrix.labels) || JSON.stringify(matrix.labels) !== JSON.stringify(labels) ||
      !Array.isArray(matrix.rows) || matrix.rows.length !== labels.length ||
      !matrix.rows.every((row) => Array.isArray(row) && row.length === labels.length && row.every((count) => Number.isSafeInteger(count) && Number(count) >= 0))) {
    throw new Error("Repeat evaluation returned an invalid confusion matrix.");
  }
  const rows = matrix.rows as number[][];
  const total = rows.flat().reduce((sum, count) => sum + count, 0);
  const correct = rows.reduce((sum, row, index) => sum + row[index], 0);
  const macroF1 = [...perClass.values()].reduce((sum, item) => sum + Number(item.f1), 0) / labels.length;
  if (total !== value.row_count || Math.abs(correct / total - value.accuracy) > 1e-9 || Math.abs(macroF1 - value.macro_f1) > 1e-9 ||
      Number(value.failure_count) !== total - correct || value.failures.length > Math.min(25, Number(value.failure_count)) ||
      value.failures_truncated !== (Number(value.failure_count) > value.failures.length)) {
    throw new Error("Repeat-evaluation metrics do not reconcile with their evidence.");
  }
  return value as unknown as RuntimeEvaluation;
}

function defaultRuntimeRoot(manifestPath: string): string {
  return join(dirname(dirname(manifestPath)), "..", "training-runtime");
}

function evidenceId(prefix: string, now: Date): string {
  return `${prefix}-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

export function repeatLocalClassifierEvaluation(
  options: RepeatLocalClassifierEvaluationOptions,
): RepeatLocalClassifierEvaluation {
  const { manifestPath, run, dataset } = readCompletedRun(options.runManifestPath);
  const now = options.now ?? new Date();
  const evaluationId = options.evaluationId ?? evidenceId("repeat", now);
  if (!EVIDENCE_ID_PATTERN.test(evaluationId)) {
    throw new Error("Evaluation id must contain only letters, numbers, dots, underscores, and hyphens.");
  }
  const maxLength = options.maxLength ?? run.training.max_length;
  if (!Number.isInteger(maxLength) || maxLength < 8 || maxLength > 8192) {
    throw new Error("Repeat-evaluation max length must be an integer between 8 and 8192.");
  }
  const pack = prepareRuntimePack(
    options.runtimeRoot ?? defaultRuntimeRoot(manifestPath),
    options.runtimePackages ?? DEFAULT_CLASSIFIER_RUNTIME_PACKAGES,
  );
  const holdout = dataset.splits.holdout;
  const runtime = validateRuntimeEvaluation(runLifecycleRuntime("evaluate", {
    schema_version: "understudy.local_classifier.repeat_evaluation_request.v1",
    run_manifest_path: manifestPath,
    holdout_path: resolve(holdout.path),
    holdout_sha256: holdout.sha256,
    holdout_row_count: holdout.row_count,
    max_length: maxLength,
    local_only: true,
  }, pack, options.uvBinary ?? "uv", options.runnerOverride), run);
  const accuracyDelta = runtime.accuracy - run.heldout!.accuracy;
  const macroF1Delta = runtime.macro_f1 - run.heldout!.macro_f1;
  const failureCountDelta = runtime.failure_count - run.heldout!.failure_count;
  const matches = Math.abs(accuracyDelta) <= 1e-9 && Math.abs(macroF1Delta) <= 1e-9 && failureCountDelta === 0;
  const artifactPath = join(dirname(manifestPath), "evaluations", evaluationId, "evaluation.json");
  const artifact: RepeatLocalClassifierEvaluation = {
    schema_version: REPEAT_SCHEMA,
    evaluation_id: evaluationId,
    run_id: run.run_id,
    model_id: `classifier.${run.run_id}`,
    generated_at: now.toISOString(),
    local_only: true,
    data_boundary: { dataset_uploaded: false, telemetry_sent: false },
    holdout: { path: resolve(holdout.path), row_count: holdout.row_count, sha256: holdout.sha256 },
    initial: {
      accuracy: run.heldout!.accuracy,
      macro_f1: run.heldout!.macro_f1,
      failure_count: run.heldout!.failure_count,
    },
    repeat: runtime,
    comparison: {
      accuracy_delta: accuracyDelta,
      macro_f1_delta: macroF1Delta,
      failure_count_delta: failureCountDelta,
      matches_initial_metrics: matches,
    },
    verdict: {
      status: matches ? "reproduced" : "drift_detected",
      reason: matches
        ? "The saved model reproduced its original results on the exact immutable holdout."
        : "The saved model changed on the exact immutable holdout; inspect runtime and hardware evidence before use.",
    },
    runtime: { runtime_sha256: pack.sha256, device: runtime.device },
    artifact_path: artifactPath,
  };
  writePrivateImmutable(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function exportLocalClassifierPredictions(
  options: ExportLocalClassifierPredictionsOptions,
): LocalClassifierPredictionExport {
  const { manifestPath, run, dataset } = readCompletedRun(options.runManifestPath);
  const sourcePath = resolve(options.sourcePath ?? dataset.source_path);
  const { bytes, headers, rows } = readCaptureDelimitedTable(sourcePath);
  if (rows.length > MAX_EXPORT_ROWS) {
    throw new Error(`Prediction export supports at most ${MAX_EXPORT_ROWS.toLocaleString()} rows per file.`);
  }
  if (!options.sourcePath && sha256(bytes) !== dataset.source_sha256) {
    throw new Error("The original training CSV changed; choose a new source explicitly or restore the original file.");
  }
  const headerMap = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const requestedColumns = options.inputColumns?.length ? options.inputColumns : dataset.mapping.input_columns;
  const inputColumns = [...new Set(requestedColumns.map((column) => headerMap.get(normalizeHeader(column))))]
    .filter((column): column is string => Boolean(column));
  if (inputColumns.length !== new Set(requestedColumns.map(normalizeHeader)).size || inputColumns.length === 0) {
    throw new Error("Every prediction input column must match one source header.");
  }
  const indexes = inputColumns.map((column) => headers.indexOf(column));
  const pending = rows.map((row, rowIndex) => ({
    row_index: rowIndex,
    text: indexes
      .map((index) => ({ name: headers[index], value: row[index]?.trim() ?? "" }))
      .filter(({ value }) => value.length > 0)
      .map(({ name, value }) => `${name}: ${value}`)
      .join("\n"),
  })).filter((row) => row.text.length > 0);
  const maxLength = options.maxLength ?? run.training.max_length;
  if (!Number.isInteger(maxLength) || maxLength < 8 || maxLength > 8192) {
    throw new Error("Prediction-export max length must be an integer between 8 and 8192.");
  }
  const pack = prepareRuntimePack(
    options.runtimeRoot ?? defaultRuntimeRoot(manifestPath),
    options.runtimePackages ?? DEFAULT_CLASSIFIER_RUNTIME_PACKAGES,
  );
  const value = runLifecycleRuntime("predict-batch", {
    schema_version: "understudy.local_classifier.batch_prediction_request.v1",
    run_manifest_path: manifestPath,
    rows: pending,
    max_length: maxLength,
    local_only: true,
  }, pack, options.uvBinary ?? "uv", options.runnerOverride);
  if (!isRecord(value) || value.schema_version !== BATCH_RUNTIME_SCHEMA || value.run_id !== run.run_id ||
      value.local_only !== true || value.row_count !== pending.length || !Array.isArray(value.rows) || value.rows.length !== pending.length) {
    throw new Error("The lifecycle runtime returned invalid batch predictions.");
  }
  const predictions = new Map<number, { label: string; confidence: number }>();
  for (const item of value.rows) {
    if (!isRecord(item) || !Number.isSafeInteger(item.row_index) || Number(item.row_index) < 0 || Number(item.row_index) >= rows.length ||
        predictions.has(Number(item.row_index)) || !isString(item.label) || !run.model!.labels.includes(item.label) ||
        !isMetric(item.confidence) || !isNonNegative(item.latency_ms)) {
      throw new Error("The lifecycle runtime returned an invalid batch-prediction row.");
    }
    predictions.set(Number(item.row_index), { label: item.label, confidence: item.confidence });
  }
  const now = options.now ?? new Date();
  const sourceStem = basename(sourcePath, extname(sourcePath)).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "dataset";
  const outputPath = resolve(options.outputPath ?? join(
    dirname(manifestPath),
    "exports",
    `${sourceStem}-predictions-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.csv`,
  ));
  const outputHeaders = [...headers, "understudy_label", "understudy_confidence", "understudy_model_id"];
  const outputRows = rows.map((row, rowIndex) => {
    const prediction = predictions.get(rowIndex);
    return [
      ...row,
      prediction?.label ?? "",
      prediction ? prediction.confidence.toFixed(6) : "",
      prediction ? `classifier.${run.run_id}` : "",
    ];
  });
  const csv = [outputHeaders, ...outputRows].map((row) => row.map(escapeCsv).join(",")).join("\n") + "\n";
  writePrivateAtomic(outputPath, csv);
  const exportManifestPath = `${outputPath}.understudy.json`;
  const artifact: LocalClassifierPredictionExport = {
    schema_version: EXPORT_SCHEMA,
    run_id: run.run_id,
    model_id: `classifier.${run.run_id}`,
    generated_at: now.toISOString(),
    local_only: true,
    data_boundary: { dataset_uploaded: false, telemetry_sent: false },
    source_path: sourcePath,
    source_sha256: sha256(bytes),
    input_columns: inputColumns,
    row_count: rows.length,
    predicted_row_count: predictions.size,
    skipped_row_count: rows.length - predictions.size,
    output_path: outputPath,
    manifest_path: exportManifestPath,
  };
  try {
    writePrivateAtomic(exportManifestPath, `${JSON.stringify(artifact, null, 2)}\n`);
  } catch (error) {
    // The CSV is the valuable user artifact. If its evidence sidecar cannot be
    // committed, remove neither file and surface the exact repair path.
    throw new Error(`Predictions were written to ${outputPath}, but evidence could not be saved: ${String(error)}`);
  }
  return artifact;
}
