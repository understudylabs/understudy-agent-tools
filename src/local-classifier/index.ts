import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";

import { localClassifierRuntimeSource } from "./runtime-source.js";

export const DEFAULT_CLASSIFIER_MODEL = "answerdotai/ModernBERT-base";
export const DEFAULT_CLASSIFIER_RUNTIME_PACKAGES = [
  "torch==2.7.1",
  "transformers==4.53.2",
  "accelerate==1.8.1",
  "safetensors==0.5.3",
  "scikit-learn==1.7.0",
] as const;

const DATASET_SCHEMA = "understudy.capture_import.classification_dataset.v2";
const RUN_SCHEMA = "understudy.capture_import.classification_run.v1";
const PREDICTION_SCHEMA = "understudy.capture_import.classification_prediction.v1";
const SPLIT_POLICY = "deterministic-stratified-group-aware-v2";
const GROUP_NORMALIZATION = "casefold-reference-stripping-v1";
const MAX_STDERR_BYTES = 1024 * 1024;
const GIB = 1024 ** 3;
const MIN_FREE_AFTER_RUN_BYTES = 3 * GIB;
const MODEL_CHECKPOINT_RESERVE_BYTES = 3 * GIB;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ClassificationPhase = "preparing" | "downloading" | "training" | "evaluating" | "saving";

export type ClassificationTrainingPhaseEvent = {
  type: "phase";
  run_id: string;
  phase: ClassificationPhase;
  message: string;
  epoch?: number;
  current?: number;
  total?: number;
};

export type ClassificationSplitEvidence = {
  path: string;
  row_count: number;
  sha256: string;
};

export type ClassificationDatasetEvidence = {
  manifest_path: string;
  dataset_id: string;
  source_sha256: string;
  mapping_sha256: string;
  split_policy_sha256: string;
  splits: {
    train: ClassificationSplitEvidence;
    dev: ClassificationSplitEvidence;
    holdout: ClassificationSplitEvidence;
  };
};

export type ClassificationTrainingRunManifest = {
  schema_version: "understudy.capture_import.classification_run.v1";
  run_id: string;
  generated_at: string;
  status: "completed" | "failed" | "cancelled";
  local_only: true;
  data_boundary: {
    dataset_uploaded: false;
    telemetry_sent: false;
    model_download_required: boolean;
  };
  training: {
    epochs: number;
    batch_size: number;
    learning_rate: number;
    max_length: number;
  };
  resource_preflight: {
    estimated_run_bytes: number;
    minimum_free_after_run_bytes: number;
    required_available_bytes: number;
    available_bytes: number;
    volume_path: string;
  };
  dataset: ClassificationDatasetEvidence;
  split_evidence: {
    policy: "deterministic-stratified-group-aware-v2";
    group_key: string;
    group_normalization: "casefold-reference-stripping-v1";
    no_group_overlap: true;
    verified_no_group_overlap: boolean;
    group_counts: { train: number; dev: number; holdout: number };
  };
  model: null | {
    requested_id: string;
    resolved_id: string;
    revision: string | null;
    format: "transformers-sequence-classification";
    path: string;
    sha256: string;
    size_bytes: number;
    labels: string[];
  };
  runtime: null | {
    runtime_sha256: string;
    python_version: string;
    packages: string[];
    device: string;
    seed: number;
  };
  baseline: null | {
    name: "majority-class";
    label: string;
    accuracy: number;
    macro_f1: number;
  };
  linear_baseline: null | {
    name: "tfidf-logistic-regression";
    accuracy: number;
    macro_f1: number;
  };
  verdict: null | {
    status: "not_better" | "improved_not_ready" | "promising";
    comparison_baseline: "tfidf-logistic-regression";
    one_run_only: true;
    reason: string;
  };
  heldout: null | {
    row_count: number;
    accuracy: number;
    macro_f1: number;
    latency_ms_p50: number;
    per_class: Array<{
      label: string;
      precision: number;
      recall: number;
      f1: number;
      support: number;
    }>;
    weakest_classes: Array<{
      label: string;
      recall: number;
      f1: number;
      support: number;
    }>;
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
  };
  timings_ms: Record<string, number>;
  events_path: string;
  manifest_path: string;
  error?: { code: string; message: string };
};

export type ClassificationTrainingResultEvent = {
  type: "result";
  result: ClassificationTrainingRunManifest;
};

export type ClassificationTrainingEvent = ClassificationTrainingPhaseEvent | ClassificationTrainingResultEvent;

export type ClassificationPrediction = {
  schema_version: "understudy.capture_import.classification_prediction.v1";
  run_id: string;
  text_sha256: string;
  label: string;
  scores: Array<{ label: string; score: number }>;
  model_id: string;
  base_model_id: string;
  latency_ms: number;
  local_only: true;
};

export type LocalClassifierRunnerOverride = {
  command: string;
  args?: string[];
};

export type StartLocalClassifierTrainingOptions = {
  datasetManifestPath: string;
  runId: string;
  outputRoot?: string;
  runtimeRoot?: string;
  modelId?: string;
  modelRevision?: string;
  seed?: number;
  epochs?: number;
  batchSize?: number;
  learningRate?: number;
  maxLength?: number;
  maxRuntimeMs?: number;
  uvBinary?: string;
  runtimePackages?: readonly string[];
  onEvent?: (event: ClassificationTrainingEvent) => void;
  runnerOverride?: LocalClassifierRunnerOverride;
  /** Test-only escape hatch for deterministic disk-preflight coverage. */
  _minimumAvailableBytesForTests?: number;
  now?: Date;
};

export type PredictLocalClassifierOptions = {
  runManifestPath: string;
  text: string;
  maxLength?: number;
  uvBinary?: string;
  runtimeRoot?: string;
  runtimePackages?: readonly string[];
  runnerOverride?: LocalClassifierRunnerOverride;
};

export type LocalClassifierTrainingJob = {
  runId: string;
  runRoot: string;
  requestPath: string;
  eventsPath: string;
  manifestPath: string;
  child: ChildProcess;
  completion: Promise<ClassificationTrainingRunManifest>;
  cancel: () => void;
};

type DatasetManifest = {
  schema_version?: unknown;
  dataset_id?: unknown;
  source_sha256?: unknown;
  mapping_sha256?: unknown;
  labels?: unknown;
  split_policy?: {
    name?: unknown;
    group_key?: unknown;
    group_normalization?: unknown;
    no_group_overlap?: unknown;
  };
  splits?: Record<string, { path?: unknown; row_count?: unknown; sha256?: unknown }>;
  artifact_root?: unknown;
};

type VerifiedDataset = {
  manifest: DatasetManifest;
  evidence: ClassificationDatasetEvidence;
  labels: string[];
  groupKey: string;
  groupCounts: { train: number; dev: number; holdout: number };
  datasetBytes: number;
};

type ResourcePreflight = ClassificationTrainingRunManifest["resource_preflight"];

type RuntimePack = {
  root: string;
  cacheRoot: string;
  runtimePath: string;
  runtimeSha256: string;
  packages: readonly string[];
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isMetric(value: unknown): value is number {
  return isFiniteNonNegative(value) && value <= 1;
}

function approximatelyEqual(left: number, right: number, tolerance = 1e-9): boolean {
  return Math.abs(left - right) <= tolerance;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function writePrivateImmutable(path: string, value: unknown): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function appendPrivateJsonl(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function parseJsonObject(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(value)) throw new Error(`Expected a JSON object: ${path}`);
  return value;
}

function verifyDatasetManifest(pathInput: string): VerifiedDataset {
  const path = resolve(pathInput);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Classification dataset manifest not found: ${path}`);
  }
  const manifest = parseJsonObject(path) as DatasetManifest;
  if (manifest.schema_version !== DATASET_SCHEMA) {
    throw new Error(
      `Local training requires ${DATASET_SCHEMA}; prepare a fresh group-aware dataset before training.`,
    );
  }
  if (!isNonEmptyString(manifest.dataset_id) || !isNonEmptyString(manifest.source_sha256) ||
      !isNonEmptyString(manifest.mapping_sha256)) {
    throw new Error("Classification dataset manifest is missing immutable dataset hashes.");
  }
  if (!Array.isArray(manifest.labels) || manifest.labels.length < 2 || !manifest.labels.every(isNonEmptyString)) {
    throw new Error("Classification dataset manifest must define at least two labels.");
  }
  const policy = manifest.split_policy;
  if (policy?.name !== SPLIT_POLICY || policy.group_normalization !== GROUP_NORMALIZATION ||
      policy.no_group_overlap !== true || !isNonEmptyString(policy.group_key)) {
    throw new Error(
      "Local training requires deterministic group-aware splits with an explicit group key and no-overlap proof.",
    );
  }

  const names = ["train", "dev", "holdout"] as const;
  const splitEvidence = {} as ClassificationDatasetEvidence["splits"];
  const groupSets = {} as Record<(typeof names)[number], Set<string>>;
  let datasetBytes = 0;
  for (const name of names) {
    const split = manifest.splits?.[name];
    if (!split || !isNonEmptyString(split.path) || !Number.isInteger(split.row_count) ||
        Number(split.row_count) <= 0 || !isNonEmptyString(split.sha256)) {
      throw new Error(`Classification dataset manifest has invalid ${name} split evidence.`);
    }
    const splitPath = resolve(split.path);
    if (!existsSync(splitPath) || !statSync(splitPath).isFile()) {
      throw new Error(`Classification ${name} split not found: ${splitPath}`);
    }
    const raw = readFileSync(splitPath);
    datasetBytes += raw.length;
    if (sha256(raw) !== split.sha256) {
      throw new Error(`Classification ${name} split changed after dataset preparation.`);
    }
    const rows = raw.toString("utf8").split("\n").filter(Boolean).map((line, index) => {
      const row = JSON.parse(line) as unknown;
      if (!isRecord(row) || !isNonEmptyString(row.example_id) || !isNonEmptyString(row.group_id) ||
          !isNonEmptyString(row.text) || !isNonEmptyString(row.label)) {
        throw new Error(`Classification ${name} split row ${index + 1} is missing immutable group evidence.`);
      }
      return row;
    });
    if (rows.length !== split.row_count) {
      throw new Error(`Classification ${name} split row count changed after dataset preparation.`);
    }
    groupSets[name] = new Set(rows.map((row) => String(row.group_id)));
    splitEvidence[name] = { path: splitPath, row_count: Number(split.row_count), sha256: split.sha256 };
  }
  for (const [left, right] of [["train", "dev"], ["train", "holdout"], ["dev", "holdout"]] as const) {
    for (const groupId of groupSets[left]) {
      if (groupSets[right].has(groupId)) {
        throw new Error(`Group leakage detected between ${left} and ${right}; prepare the dataset again.`);
      }
    }
  }
  const splitPolicySha256 = sha256(JSON.stringify(policy));
  return {
    manifest,
    labels: [...manifest.labels],
    groupKey: policy.group_key,
    groupCounts: {
      train: groupSets.train.size,
      dev: groupSets.dev.size,
      holdout: groupSets.holdout.size,
    },
    datasetBytes,
    evidence: {
      manifest_path: path,
      dataset_id: manifest.dataset_id,
      source_sha256: manifest.source_sha256,
      mapping_sha256: manifest.mapping_sha256,
      split_policy_sha256: splitPolicySha256,
      splits: splitEvidence,
    },
  };
}

function existingAncestor(pathInput: string): string {
  let candidate = resolve(pathInput);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`Could not find an existing parent for disk preflight: ${pathInput}`);
    candidate = parent;
  }
  return candidate;
}

function diskPreflight(paths: string[], datasetBytes: number, testMinimum?: number): ResourcePreflight {
  const volumes = paths.map((path) => {
    const volumePath = existingAncestor(path);
    const stats = statfsSync(volumePath, { bigint: true });
    const availableBytes = Number(stats.bavail * stats.bsize);
    if (!Number.isSafeInteger(availableBytes)) {
      throw new Error(`Disk availability exceeds the supported integer range at ${volumePath}.`);
    }
    return { volumePath, availableBytes };
  });
  const limitingVolume = volumes.sort((left, right) => left.availableBytes - right.availableBytes)[0];
  const { volumePath, availableBytes } = limitingVolume;
  const estimatedRunBytes = MODEL_CHECKPOINT_RESERVE_BYTES + (datasetBytes * 4);
  const defaultRequired = MIN_FREE_AFTER_RUN_BYTES + estimatedRunBytes;
  const requiredAvailableBytes = testMinimum ?? defaultRequired;
  if (!Number.isSafeInteger(requiredAvailableBytes) || requiredAvailableBytes < 0) {
    throw new Error("The test-only disk preflight override must be a non-negative safe integer.");
  }
  if (availableBytes < requiredAvailableBytes) {
    throw new Error(
      `Insufficient disk space for local training: needs ${requiredAvailableBytes} bytes, ${availableBytes} available at ${volumePath}.`,
    );
  }
  return {
    estimated_run_bytes: estimatedRunBytes,
    minimum_free_after_run_bytes: MIN_FREE_AFTER_RUN_BYTES,
    required_available_bytes: requiredAvailableBytes,
    available_bytes: availableBytes,
    volume_path: volumePath,
  };
}

function prepareRuntimePack(runtimeRootInput: string, packages: readonly string[]): RuntimePack {
  const runtimeRoot = resolve(runtimeRootInput);
  const runtimeSha256 = sha256(JSON.stringify({
    schema_version: "understudy.local_classifier.runtime.v1",
    python: "3.12",
    packages,
    source_sha256: sha256(localClassifierRuntimeSource),
  }));
  const root = join(runtimeRoot, "runtime-packs", runtimeSha256);
  ensurePrivateDirectory(root);
  const runtimePath = join(root, "classifier_runtime.py");
  const specPath = join(root, "runtime-spec.json");
  const expectedSpec = {
    schema_version: "understudy.local_classifier.runtime.v1",
    runtime_sha256: runtimeSha256,
    python: "3.12",
    packages,
    source_sha256: sha256(localClassifierRuntimeSource),
    system_python_required: false,
    dependency_policy: "exact-direct-pins-content-addressed-spec",
  };
  if (!existsSync(runtimePath)) {
    writeFileSync(runtimePath, localClassifierRuntimeSource, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } else if (sha256(readFileSync(runtimePath)) !== sha256(localClassifierRuntimeSource)) {
    throw new Error(`Content-addressed classifier runtime was modified: ${runtimePath}`);
  }
  if (!existsSync(specPath)) {
    writePrivateImmutable(specPath, expectedSpec);
  } else if (JSON.stringify(parseJsonObject(specPath)) !== JSON.stringify(expectedSpec)) {
    throw new Error(`Content-addressed classifier runtime spec was modified: ${specPath}`);
  }
  return { root, cacheRoot: runtimeRoot, runtimePath, runtimeSha256, packages };
}

function runtimeInvocation(
  command: "train" | "predict",
  requestPath: string | null,
  pack: RuntimePack,
  uvBinary: string,
  override?: LocalClassifierRunnerOverride,
): { command: string; args: string[] } {
  if (override) {
    return {
      command: override.command,
      args: [...(override.args ?? []), command, requestPath ? "--request" : "--request-stdin", ...(requestPath ? [requestPath] : [])],
    };
  }
  const args = ["run", "--isolated", "--managed-python", "--python", "3.12", "--no-project"];
  for (const dependency of pack.packages) args.push("--with", dependency);
  args.push("python", pack.runtimePath, command, requestPath ? "--request" : "--request-stdin");
  if (requestPath) args.push(requestPath);
  return { command: uvBinary, args };
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

function directoryEvidence(path: string): { sha256: string; sizeBytes: number } {
  const digest = createHash("sha256");
  let sizeBytes = 0;
  const visit = (root: string, relativeRoot = "") => {
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const absolute = join(root, entry.name);
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isFile()) {
        const relativeBytes = Buffer.from(relative, "utf8");
        const payload = readFileSync(absolute);
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(relativeBytes.length));
        digest.update(length).update(relativeBytes);
        length.writeBigUInt64BE(BigInt(payload.length));
        digest.update(length).update(payload);
        sizeBytes += payload.length;
      }
    }
  };
  visit(path);
  return { sha256: digest.digest("hex"), sizeBytes };
}

function validatePhaseEvent(value: unknown, runId: string): ClassificationTrainingPhaseEvent {
  if (!isRecord(value) || value.type !== "phase" || value.run_id !== runId ||
      !["preparing", "downloading", "training", "evaluating", "saving"].includes(String(value.phase)) ||
      !isNonEmptyString(value.message)) {
    throw new Error("Classifier runtime emitted an invalid phase event.");
  }
  for (const key of ["epoch", "current", "total"] as const) {
    if (value[key] !== undefined && !isFiniteNonNegative(value[key])) {
      throw new Error(`Classifier runtime emitted an invalid ${key} value.`);
    }
  }
  return value as ClassificationTrainingPhaseEvent;
}

function validateCompletedManifest(
  value: unknown,
  verified: VerifiedDataset,
  runId: string,
  runRoot: string,
  manifestPath: string,
  eventsPath: string,
  pack: RuntimePack,
  modelId: string,
  modelRevision: string | null,
  seed: number,
  training: ClassificationTrainingRunManifest["training"],
  resourcePreflight: ResourcePreflight,
): ClassificationTrainingRunManifest {
  if (!isRecord(value) || value.schema_version !== RUN_SCHEMA || value.status !== "completed" ||
      value.run_id !== runId || value.local_only !== true) {
    throw new Error("Classifier runtime emitted an invalid completed run manifest.");
  }
  if (!isRecord(value.data_boundary) || value.data_boundary.dataset_uploaded !== false ||
      value.data_boundary.telemetry_sent !== false) {
    throw new Error("Classifier runtime violated the local-only data boundary.");
  }
  if (JSON.stringify(value.training) !== JSON.stringify(training) ||
      JSON.stringify(value.resource_preflight) !== JSON.stringify(resourcePreflight)) {
    throw new Error("Classifier runtime changed immutable training or resource-preflight evidence.");
  }
  if (JSON.stringify(value.dataset) !== JSON.stringify(verified.evidence)) {
    throw new Error("Classifier runtime returned dataset evidence that does not match the prepared inputs.");
  }
  const split = value.split_evidence;
  if (!isRecord(split) || split.policy !== SPLIT_POLICY || split.group_key !== verified.groupKey ||
      split.group_normalization !== GROUP_NORMALIZATION || split.no_group_overlap !== true ||
      split.verified_no_group_overlap !== true || JSON.stringify(split.group_counts) !== JSON.stringify(verified.groupCounts)) {
    throw new Error("Classifier runtime did not preserve the verified group-aware split evidence.");
  }
  if (!isRecord(value.model) || value.model.requested_id !== modelId ||
      value.model.format !== "transformers-sequence-classification" || !isNonEmptyString(value.model.resolved_id) ||
      !isNonEmptyString(value.model.path) || !isNonEmptyString(value.model.sha256) ||
      !isFiniteNonNegative(value.model.size_bytes) || !Array.isArray(value.model.labels) ||
      JSON.stringify(value.model.labels) !== JSON.stringify(verified.labels)) {
    throw new Error("Classifier runtime emitted invalid model evidence.");
  }
  if ((modelRevision !== null && value.model.revision !== modelRevision) ||
      (value.model.revision !== null && !isNonEmptyString(value.model.revision))) {
    throw new Error("Classifier runtime did not preserve the requested model revision.");
  }
  const expectedModelPath = join(runRoot, "model");
  if (resolve(value.model.path) !== expectedModelPath || !existsSync(expectedModelPath) || !statSync(expectedModelPath).isDirectory()) {
    throw new Error("Classifier runtime model artifact is outside the immutable run directory.");
  }
  const actualModel = directoryEvidence(expectedModelPath);
  if (actualModel.sha256 !== value.model.sha256 || actualModel.sizeBytes !== value.model.size_bytes) {
    throw new Error("Classifier model artifact does not match its hash and size evidence.");
  }
  if (!isRecord(value.runtime)) {
    throw new Error("Classifier runtime emitted invalid runtime evidence.");
  }
  const runtimeEvidence = value.runtime;
  const runtimePackages = runtimeEvidence.packages;
  if (runtimeEvidence.runtime_sha256 !== pack.runtimeSha256 ||
      !isNonEmptyString(runtimeEvidence.python_version) || !Array.isArray(runtimePackages) ||
      !runtimePackages.every(isNonEmptyString) || !isNonEmptyString(runtimeEvidence.device) ||
      runtimeEvidence.seed !== seed || !pack.packages.every((dependency) => runtimePackages.includes(dependency))) {
    throw new Error("Classifier runtime emitted invalid runtime evidence.");
  }
  if (!isRecord(value.baseline) || value.baseline.name !== "majority-class" ||
      !isNonEmptyString(value.baseline.label) || !verified.labels.includes(value.baseline.label) ||
      !isMetric(value.baseline.accuracy) || !isMetric(value.baseline.macro_f1)) {
    throw new Error("Classifier runtime emitted invalid majority baseline evidence.");
  }
  if (!isRecord(value.linear_baseline) || value.linear_baseline.name !== "tfidf-logistic-regression" ||
      !isMetric(value.linear_baseline.accuracy) || !isMetric(value.linear_baseline.macro_f1)) {
    throw new Error("Classifier runtime emitted invalid TF-IDF baseline evidence.");
  }
  if (!isRecord(value.verdict) ||
      !["not_better", "improved_not_ready", "promising"].includes(String(value.verdict.status)) ||
      value.verdict.comparison_baseline !== "tfidf-logistic-regression" || value.verdict.one_run_only !== true ||
      !isNonEmptyString(value.verdict.reason)) {
    throw new Error("Classifier runtime emitted an invalid conservative verdict.");
  }
  if (!isRecord(value.heldout) || value.heldout.row_count !== verified.evidence.splits.holdout.row_count ||
      !isMetric(value.heldout.accuracy) || !isMetric(value.heldout.macro_f1) ||
      !isFiniteNonNegative(value.heldout.latency_ms_p50) || !Array.isArray(value.heldout.per_class) ||
      !Array.isArray(value.heldout.weakest_classes) ||
      !isRecord(value.heldout.confusion_matrix) || !Array.isArray(value.heldout.failures) ||
      typeof value.heldout.failure_count !== "number" || !Number.isInteger(value.heldout.failure_count) ||
      value.heldout.failure_count < 0 ||
      typeof value.heldout.failures_truncated !== "boolean") {
    throw new Error("Classifier runtime emitted invalid held-out evidence.");
  }
  const perClassByLabel = new Map<string, Record<string, unknown>>();
  for (const item of value.heldout.per_class) {
    if (!isRecord(item) || !isNonEmptyString(item.label) || perClassByLabel.has(item.label) ||
        !isMetric(item.precision) || !isMetric(item.recall) || !isMetric(item.f1) ||
        typeof item.support !== "number" || !Number.isInteger(item.support) || item.support < 0) {
      throw new Error("Classifier runtime emitted invalid per-class evidence.");
    }
    perClassByLabel.set(item.label, item);
  }
  if (JSON.stringify([...perClassByLabel.keys()].sort()) !== JSON.stringify([...verified.labels].sort()) ||
      [...perClassByLabel.values()].reduce((total, item) => total + Number(item.support), 0) !== value.heldout.row_count) {
    throw new Error("Classifier per-class evidence does not cover the held-out labels and rows exactly once.");
  }
  const matrix = value.heldout.confusion_matrix;
  if (!Array.isArray(matrix.labels) || JSON.stringify(matrix.labels) !== JSON.stringify(verified.labels) ||
      !Array.isArray(matrix.rows) || matrix.rows.length !== verified.labels.length ||
      !matrix.rows.every((row) => Array.isArray(row) && row.length === verified.labels.length &&
        row.every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0))) {
    throw new Error("Classifier confusion-matrix evidence is invalid.");
  }
  const matrixRows = matrix.rows as number[][];
  const matrixTotal = matrixRows.flat().reduce((total, count) => total + count, 0);
  const matrixCorrect = matrixRows.reduce((total, row, index) => total + row[index], 0);
  if (matrixTotal !== value.heldout.row_count ||
      !approximatelyEqual(matrixCorrect / matrixTotal, value.heldout.accuracy)) {
    throw new Error("Classifier confusion matrix does not reconcile to held-out accuracy.");
  }
  for (let index = 0; index < verified.labels.length; index += 1) {
    const item = perClassByLabel.get(verified.labels[index])!;
    const truePositive = matrixRows[index][index];
    const falsePositive = matrixRows.reduce((total, row, rowIndex) =>
      rowIndex === index ? total : total + row[index], 0);
    const falseNegative = matrixRows[index].reduce((total, count, columnIndex) =>
      columnIndex === index ? total : total + count, 0);
    const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
    const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    if (item.support !== matrixRows[index].reduce((total, count) => total + count, 0) ||
        !approximatelyEqual(Number(item.precision), precision) || !approximatelyEqual(Number(item.recall), recall) ||
        !approximatelyEqual(Number(item.f1), f1)) {
      throw new Error("Classifier per-class metrics do not reconcile to the confusion matrix.");
    }
  }
  const reconciledMacroF1 = [...perClassByLabel.values()]
    .reduce((total, item) => total + Number(item.f1), 0) / verified.labels.length;
  if (!approximatelyEqual(reconciledMacroF1, value.heldout.macro_f1)) {
    throw new Error("Classifier per-class metrics do not reconcile to held-out macro-F1.");
  }
  if (value.heldout.failures.length > 25 || value.heldout.failures.length > value.heldout.failure_count ||
      value.heldout.failures_truncated !== (value.heldout.failure_count > value.heldout.failures.length)) {
    throw new Error("Classifier failure evidence is not correctly bounded.");
  }
  for (const failure of value.heldout.failures) {
    if (!isRecord(failure) || "text" in failure || !isNonEmptyString(failure.example_id) ||
        !isNonEmptyString(failure.group_id) || !isNonEmptyString(failure.text_sha256) ||
        !isNonEmptyString(failure.expected_label) || !isNonEmptyString(failure.predicted_label)) {
      throw new Error("Classifier failure evidence must be identifier-only and omit raw text.");
    }
  }
  for (const item of value.heldout.weakest_classes) {
    if (!isRecord(item) || !isNonEmptyString(item.label) || !isMetric(item.recall) || !isMetric(item.f1) ||
        typeof item.support !== "number" || !Number.isInteger(item.support) || item.support < 0) {
      throw new Error("Classifier runtime emitted invalid weakest-class evidence.");
    }
  }
  const expectedWeakest = [...perClassByLabel.values()]
    .sort((left, right) => Number(left.recall) - Number(right.recall) ||
      Number(left.f1) - Number(right.f1) || String(left.label).localeCompare(String(right.label)))
    .slice(0, 5)
    .map((item) => ({ label: item.label, recall: item.recall, f1: item.f1, support: item.support }));
  if (JSON.stringify(value.heldout.weakest_classes) !== JSON.stringify(expectedWeakest)) {
    throw new Error("Classifier weakest-class evidence does not match per-class metrics.");
  }
  const minimumRecall = Math.min(...[...perClassByLabel.values()].map((item) => Number(item.recall)));
  const expectedVerdict = value.heldout.macro_f1 <= value.linear_baseline.macro_f1
    ? "not_better"
    : value.heldout.macro_f1 < 0.75 || minimumRecall < 0.5
      ? "improved_not_ready"
      : "promising";
  if ((value.verdict as Record<string, unknown>).status !== expectedVerdict) {
    throw new Error("Classifier one-run verdict does not match the recorded quality gates.");
  }
  if (!isRecord(value.timings_ms) || !Object.values(value.timings_ms).every(isFiniteNonNegative)) {
    throw new Error("Classifier runtime emitted invalid timing evidence.");
  }
  if (resolve(String(value.events_path)) !== eventsPath || resolve(String(value.manifest_path)) !== manifestPath) {
    throw new Error("Classifier runtime emitted invalid run artifact paths.");
  }
  return value as ClassificationTrainingRunManifest;
}

function terminalManifest(
  status: "failed" | "cancelled",
  code: string,
  message: string,
  generatedAt: string,
  runId: string,
  manifestPath: string,
  eventsPath: string,
  verified: VerifiedDataset,
  elapsedMs: number,
  training: ClassificationTrainingRunManifest["training"],
  resourcePreflight: ResourcePreflight,
): ClassificationTrainingRunManifest {
  return {
    schema_version: RUN_SCHEMA,
    run_id: runId,
    generated_at: generatedAt,
    status,
    local_only: true,
    data_boundary: { dataset_uploaded: false, telemetry_sent: false, model_download_required: true },
    training,
    resource_preflight: resourcePreflight,
    dataset: verified.evidence,
    split_evidence: {
      policy: SPLIT_POLICY,
      group_key: verified.groupKey,
      group_normalization: GROUP_NORMALIZATION,
      no_group_overlap: true,
      verified_no_group_overlap: true,
      group_counts: verified.groupCounts,
    },
    model: null,
    runtime: null,
    baseline: null,
    linear_baseline: null,
    verdict: null,
    heldout: null,
    timings_ms: { total: elapsedMs },
    events_path: eventsPath,
    manifest_path: manifestPath,
    error: { code, message },
  };
}

export function startLocalClassifierTraining(options: StartLocalClassifierTrainingOptions): LocalClassifierTrainingJob {
  if (!RUN_ID_PATTERN.test(options.runId)) {
    throw new Error("--run-id must contain only letters, numbers, dots, underscores, and hyphens.");
  }
  const verified = verifyDatasetManifest(options.datasetManifestPath);
  const generatedAt = (options.now ?? new Date()).toISOString();
  const defaultOutputRoot = isNonEmptyString(verified.manifest.artifact_root)
    ? join(resolve(verified.manifest.artifact_root), "training-runs")
    : join(dirname(verified.evidence.manifest_path), "training-runs");
  const outputRoot = resolve(options.outputRoot ?? defaultOutputRoot);
  const runtimeRoot = resolve(options.runtimeRoot ?? join(outputRoot, "..", "training-runtime"));
  const resourcePreflight = diskPreflight(
    [outputRoot, runtimeRoot],
    verified.datasetBytes,
    options._minimumAvailableBytesForTests,
  );
  const runRoot = join(outputRoot, options.runId);
  if (existsSync(runRoot)) throw new Error(`Classification training run already exists: ${runRoot}`);
  const eventsPath = join(runRoot, "events.jsonl");
  const manifestPath = join(runRoot, "run-manifest.json");
  const requestPath = join(runRoot, "run-request.json");
  const packages = options.runtimePackages ?? DEFAULT_CLASSIFIER_RUNTIME_PACKAGES;
  if (packages.length === 0 || !packages.every((value) => /^[A-Za-z0-9_.-]+==[^=\s]+$/.test(value))) {
    throw new Error("Classifier runtime dependencies must use exact package==version pins.");
  }
  const pack = prepareRuntimePack(runtimeRoot, packages);
  const modelId = options.modelId ?? DEFAULT_CLASSIFIER_MODEL;
  const modelRevision = options.modelRevision ?? null;
  const seed = options.seed ?? 17;
  const epochs = options.epochs ?? 3;
  const batchSize = options.batchSize ?? 8;
  const learningRate = options.learningRate ?? 2e-5;
  const maxLength = options.maxLength ?? 256;
  if (!isNonEmptyString(modelId) || !Number.isInteger(seed) || !Number.isInteger(epochs) || epochs < 1 || epochs > 20 ||
      !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128 || !Number.isFinite(learningRate) ||
      learningRate <= 0 || !Number.isInteger(maxLength) || maxLength < 8 || maxLength > 8192) {
    throw new Error("Invalid local classifier training configuration.");
  }
  const maxRuntimeMs = options.maxRuntimeMs ?? 4 * 60 * 60 * 1000;
  if (!isFiniteNonNegative(maxRuntimeMs) || maxRuntimeMs < 1000) {
    throw new Error("maxRuntimeMs must be at least 1000 milliseconds.");
  }
  ensurePrivateDirectory(runRoot);
  const training = { epochs, batch_size: batchSize, learning_rate: learningRate, max_length: maxLength };
  const request = {
    schema_version: "understudy.local_classifier.request.v1",
    run_id: options.runId,
    generated_at: generatedAt,
    dataset_manifest_path: verified.evidence.manifest_path,
    dataset_evidence: verified.evidence,
    model_id: modelId,
    model_revision: modelRevision,
    runtime_packages: packages,
    seed,
    epochs,
    batch_size: batchSize,
    learning_rate: learningRate,
    max_length: maxLength,
    runtime_sha256: pack.runtimeSha256,
    model_path: join(runRoot, "model"),
    checkpoint_path: join(runRoot, "checkpoints"),
    events_path: eventsPath,
    run_manifest_path: manifestPath,
    local_only: true,
    dataset_upload_allowed: false,
    telemetry_allowed: false,
    training,
    resource_preflight: resourcePreflight,
  };
  writePrivateImmutable(requestPath, request);
  const invocation = runtimeInvocation("train", requestPath, pack, options.uvBinary ?? "uv", options.runnerOverride);
  const child = spawn(invocation.command, invocation.args, {
    cwd: runRoot,
    env: runtimeEnvironment(pack.cacheRoot),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const startedAt = Date.now();
  let result: ClassificationTrainingRunManifest | null = null;
  let stderr = "";
  let cancellationRequested = false;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let killEscalation: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveCompletion!: (value: ClassificationTrainingRunManifest) => void;
  const completion = new Promise<ClassificationTrainingRunManifest>((resolvePromise) => {
    resolveCompletion = resolvePromise;
  });
  const deliver = (event: ClassificationTrainingEvent) => {
    appendPrivateJsonl(eventsPath, event);
    try {
      options.onEvent?.(event);
    } catch (error) {
      stderr = `${stderr}\nEvent listener failed: ${error instanceof Error ? error.message : String(error)}`
        .slice(-MAX_STDERR_BYTES);
    }
  };
  const terminate = () => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ESRCH") throw error;
    }
    if (!killEscalation) {
      killEscalation = setTimeout(() => {
        if (settled) return;
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch (error) {
          if (!isRecord(error) || error.code !== "ESRCH") {
            stderr = `${stderr}\nCould not force-stop local training: ${String(error)}`.slice(-MAX_STDERR_BYTES);
          }
        }
      }, 2_000);
      killEscalation.unref();
    }
  };
  const forwardSignal = () => {
    if (settled || cancellationRequested) return;
    cancellationRequested = true;
    terminate();
  };
  process.once("SIGTERM", forwardSignal);
  process.once("SIGINT", forwardSignal);
  const stdout = createInterface({ input: child.stdout });
  stdout.on("line", (line) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      // Native libraries may write informational text to stdout. Only the
      // runtime's validated JSON events become durable evidence.
      return;
    }
    try {
      if (isRecord(parsed) && parsed.type === "phase") {
        deliver(validatePhaseEvent(parsed, options.runId));
      } else if (isRecord(parsed) && parsed.type === "result") {
        if (result) throw new Error("Classifier runtime emitted more than one result.");
        result = validateCompletedManifest(
          parsed.result,
          verified,
          options.runId,
          runRoot,
          manifestPath,
          eventsPath,
          pack,
          modelId,
          modelRevision,
          seed,
          training,
          resourcePreflight,
        );
      } else {
        throw new Error("Classifier runtime emitted an unsupported JSONL event.");
      }
    } catch (error) {
      stderr = `${stderr}\n${error instanceof Error ? error.message : String(error)}`.slice(-MAX_STDERR_BYTES);
    }
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_BYTES);
  });
  const finalize = (manifest: ClassificationTrainingRunManifest) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (killEscalation) clearTimeout(killEscalation);
    process.removeListener("SIGTERM", forwardSignal);
    process.removeListener("SIGINT", forwardSignal);
    writePrivateImmutable(manifestPath, manifest);
    const event: ClassificationTrainingResultEvent = { type: "result", result: manifest };
    deliver(event);
    resolveCompletion(manifest);
  };
  child.on("error", (error) => {
    stderr = `${stderr}\n${error.message}`.slice(-MAX_STDERR_BYTES);
  });
  child.on("close", (code, signal) => {
    stdout.close();
    const elapsed = Date.now() - startedAt;
    if (timedOut) {
      finalize(terminalManifest("failed", "timeout", "Local training exceeded its runtime limit.", generatedAt,
        options.runId, manifestPath, eventsPath, verified, elapsed, training, resourcePreflight));
    } else if (cancellationRequested) {
      finalize(terminalManifest("cancelled", "cancelled", "Local training was cancelled.", generatedAt, options.runId,
        manifestPath, eventsPath, verified, elapsed, training, resourcePreflight));
    } else if (code === 0 && result) {
      finalize(result);
    } else {
      const detail = stderr.trim().split("\n").filter(Boolean).slice(-8).join("\n");
      const suffix = signal ? ` (signal ${signal})` : code === null ? "" : ` (exit ${code})`;
      finalize(terminalManifest("failed", "runtime_failed",
        `Local classifier training failed${suffix}${detail ? `: ${detail}` : "."}`,
        generatedAt, options.runId, manifestPath, eventsPath, verified, elapsed, training, resourcePreflight));
    }
  });
  timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, maxRuntimeMs);
  timeout.unref();
  return {
    runId: options.runId,
    runRoot,
    requestPath,
    eventsPath,
    manifestPath,
    child,
    completion,
    cancel: () => {
      if (settled || cancellationRequested) return;
      cancellationRequested = true;
      terminate();
    },
  };
}

export async function trainLocalClassifier(
  options: StartLocalClassifierTrainingOptions,
): Promise<ClassificationTrainingRunManifest> {
  return startLocalClassifierTraining(options).completion;
}

function validatePrediction(value: unknown, run: ClassificationTrainingRunManifest, text: string): ClassificationPrediction {
  if (!isRecord(value) || value.schema_version !== PREDICTION_SCHEMA || value.run_id !== run.run_id ||
      value.local_only !== true || value.text_sha256 !== sha256(text) || !isNonEmptyString(value.label) ||
      value.model_id !== run.model?.resolved_id || !isFiniteNonNegative(value.latency_ms) || !Array.isArray(value.scores) ||
      value.scores.length !== run.model?.labels.length) {
    throw new Error("Classifier runtime emitted an invalid prediction.");
  }
  let total = 0;
  const scoreLabels: string[] = [];
  let previousScore = Number.POSITIVE_INFINITY;
  for (const score of value.scores) {
    if (!isRecord(score) || !isNonEmptyString(score.label) || !isMetric(score.score)) {
      throw new Error("Classifier runtime emitted an invalid prediction score.");
    }
    total += score.score;
    scoreLabels.push(score.label);
    if (score.score > previousScore) {
      throw new Error("Classifier prediction scores are not ranked.");
    }
    previousScore = score.score;
  }
  const expectedLabels = [...(run.model?.labels ?? [])].sort();
  if (new Set(scoreLabels).size !== scoreLabels.length ||
      JSON.stringify([...scoreLabels].sort()) !== JSON.stringify(expectedLabels) ||
      Math.abs(total - 1) > 0.001 || value.label !== (value.scores[0] as Record<string, unknown>).label) {
    throw new Error("Classifier prediction scores are not normalized and ranked.");
  }
  const runtimePrediction = value as Omit<ClassificationPrediction, "model_id" | "base_model_id"> & {
    model_id: string;
  };
  return {
    ...runtimePrediction,
    model_id: `classifier.${run.run_id}`,
    base_model_id: runtimePrediction.model_id,
  };
}

export function predictLocalClassifier(options: PredictLocalClassifierOptions): ClassificationPrediction {
  const manifestPath = resolve(options.runManifestPath);
  const run = parseJsonObject(manifestPath) as unknown as ClassificationTrainingRunManifest;
  if (run.schema_version !== RUN_SCHEMA || run.status !== "completed" || !run.model || !run.runtime ||
      run.local_only !== true || run.data_boundary?.dataset_uploaded !== false ||
      run.data_boundary.telemetry_sent !== false || resolve(run.manifest_path) !== manifestPath) {
    throw new Error("Prediction requires a completed local classification run.");
  }
  if (!isNonEmptyString(options.text) || options.text.length > 100_000) {
    throw new Error("Prediction text must contain between 1 and 100,000 characters.");
  }
  const expectedModelPath = join(dirname(manifestPath), "model");
  if (resolve(run.model.path) !== expectedModelPath || !existsSync(expectedModelPath) ||
      !statSync(expectedModelPath).isDirectory()) {
    throw new Error("The completed classifier model artifact is missing.");
  }
  if (!Array.isArray(run.model.labels) || run.model.labels.length < 2 ||
      !run.model.labels.every(isNonEmptyString) || new Set(run.model.labels).size !== run.model.labels.length ||
      !isNonEmptyString(run.model.sha256) || !isFiniteNonNegative(run.model.size_bytes)) {
    throw new Error("The completed classifier has invalid model provenance.");
  }
  const actualModel = directoryEvidence(expectedModelPath);
  if (actualModel.sha256 !== run.model.sha256 || actualModel.sizeBytes !== run.model.size_bytes) {
    throw new Error("The saved classifier changed after its immutable run was recorded.");
  }
  const runtimeRoot = resolve(options.runtimeRoot ?? join(dirname(dirname(manifestPath)), "..", "training-runtime"));
  const pack = prepareRuntimePack(runtimeRoot, options.runtimePackages ?? DEFAULT_CLASSIFIER_RUNTIME_PACKAGES);
  if (pack.runtimeSha256 !== run.runtime.runtime_sha256) {
    throw new Error("The installed classifier runtime does not match the completed training run.");
  }
  const maxLength = options.maxLength ?? 256;
  if (!Number.isInteger(maxLength) || maxLength < 8 || maxLength > 8192) {
    throw new Error("Prediction max length must be an integer between 8 and 8192.");
  }
  const request = {
    schema_version: "understudy.local_classifier.prediction_request.v1",
    run_manifest_path: manifestPath,
    text: options.text,
    max_length: maxLength,
    local_only: true,
  };
  const invocation = runtimeInvocation("predict", null, pack, options.uvBinary ?? "uv", options.runnerOverride);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: dirname(manifestPath),
    env: runtimeEnvironment(pack.cacheRoot),
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`Local classifier prediction failed: ${detail}`);
  }
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const value = JSON.parse(lines.at(-1) ?? "null") as unknown;
  return validatePrediction(value, run, options.text);
}
