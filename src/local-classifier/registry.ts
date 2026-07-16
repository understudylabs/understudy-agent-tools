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
import { dirname, join, resolve } from "node:path";

import { globalConfigDir } from "../config/paths.js";

const RUN_SCHEMA = "understudy.capture_import.classification_run.v1";
const REGISTRY_SCHEMA = "understudy.local_classifier.registry.v1";
const LIFECYCLE_SCHEMA = "understudy.local_classifier.lifecycle.v1";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CAPTURE_ROOTS = 2_000;
const MAX_RUNS_PER_CAPTURE = 2_000;
const COMPLETED_VERDICTS = new Set(["not_better", "improved_not_ready", "promising"]);

type RunStatus = "completed" | "failed" | "cancelled";

type RunManifest = {
  schema_version?: unknown;
  run_id?: unknown;
  generated_at?: unknown;
  status?: unknown;
  local_only?: unknown;
  data_boundary?: { dataset_uploaded?: unknown; telemetry_sent?: unknown };
  model?: {
    requested_id?: unknown;
    resolved_id?: unknown;
    path?: unknown;
    size_bytes?: unknown;
    labels?: unknown;
  } | null;
  heldout?: {
    row_count?: unknown;
    accuracy?: unknown;
    macro_f1?: unknown;
    latency_ms_p50?: unknown;
    failure_count?: unknown;
  } | null;
  verdict?: { status?: unknown } | null;
  timings_ms?: { total?: unknown };
  manifest_path?: unknown;
  error?: { code?: unknown; message?: unknown };
};

type LifecycleRecord = {
  schema_version: typeof LIFECYCLE_SCHEMA;
  run_id: string;
  display_name: string;
  archived_at: string | null;
  updated_at: string;
};

export type LocalClassifierRunSummary = {
  schema_version: typeof REGISTRY_SCHEMA;
  model_id: string;
  kind: "classifier";
  run_id: string;
  display_name: string;
  run_status: RunStatus;
  archived_at: string | null;
  generated_at: string;
  updated_at: string;
  local_only: true;
  manifest_path: string;
  model: null | {
    requested_id: string;
    resolved_id: string;
    path: string;
    size_bytes: number;
    label_count: number;
    available: boolean;
  };
  evaluation: null | {
    row_count: number;
    accuracy: number;
    macro_f1: number;
    latency_ms_p50: number;
    failure_count: number;
    verdict: string;
  };
  timing_ms: number | null;
  failure: null | { code: string; message: string };
};

export type ListLocalClassifierRunsOptions = {
  captureRoot?: string;
  archived?: boolean;
  limit?: number;
};

export type UpdateLocalClassifierRunOptions = {
  runManifestPath: string;
  displayName?: string;
  archived?: boolean;
  now?: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isMetric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function defaultCaptureRoot(): string {
  return join(globalConfigDir(), "capture-imports");
}

function lifecyclePath(manifestPath: string): string {
  return join(dirname(manifestPath), "lifecycle.json");
}

function validateManifest(path: string): { manifest: RunManifest; runId: string; status: RunStatus } {
  const canonicalPath = resolve(path);
  const value = parseJson(canonicalPath);
  if (!isRecord(value)) throw new Error("The local classifier run manifest is malformed.");
  const manifest = value as RunManifest;
  if (manifest.schema_version !== RUN_SCHEMA || manifest.local_only !== true ||
      manifest.data_boundary?.dataset_uploaded !== false || manifest.data_boundary.telemetry_sent !== false ||
      !isNonEmptyString(manifest.run_id) || !RUN_ID_PATTERN.test(manifest.run_id) ||
      !["completed", "failed", "cancelled"].includes(String(manifest.status)) ||
      resolve(String(manifest.manifest_path)) !== canonicalPath) {
    throw new Error("The local classifier run manifest failed its local evidence contract.");
  }
  if (!isNonEmptyString(manifest.generated_at) || Number.isNaN(Date.parse(manifest.generated_at))) {
    throw new Error("The local classifier run manifest omitted its creation time.");
  }
  return { manifest, runId: manifest.run_id, status: manifest.status as RunStatus };
}

function readLifecycle(manifestPath: string, runId: string, generatedAt: string): LifecycleRecord {
  const path = lifecyclePath(manifestPath);
  if (!existsSync(path)) {
    return {
      schema_version: LIFECYCLE_SCHEMA,
      run_id: runId,
      display_name: runId,
      archived_at: null,
      updated_at: generatedAt,
    };
  }
  const value = parseJson(path);
  if (!isRecord(value) || value.schema_version !== LIFECYCLE_SCHEMA || value.run_id !== runId ||
      !isNonEmptyString(value.display_name) || value.display_name.length > 80 ||
      !(value.archived_at === null || (isNonEmptyString(value.archived_at) && !Number.isNaN(Date.parse(value.archived_at)))) ||
      !isNonEmptyString(value.updated_at) || Number.isNaN(Date.parse(value.updated_at))) {
    throw new Error(`The lifecycle record for ${runId} is malformed.`);
  }
  return value as LifecycleRecord;
}

function summary(path: string): LocalClassifierRunSummary {
  const { manifest, runId, status } = validateManifest(path);
  const generatedAt = String(manifest.generated_at);
  const lifecycle = readLifecycle(path, runId, generatedAt);
  let model: LocalClassifierRunSummary["model"] = null;
  if (manifest.model !== null && isRecord(manifest.model) &&
      isNonEmptyString(manifest.model.requested_id) && isNonEmptyString(manifest.model.resolved_id) &&
      isNonEmptyString(manifest.model.path) && isSafeNonNegativeInteger(manifest.model.size_bytes) &&
      resolve(manifest.model.path) === join(dirname(resolve(path)), "model") &&
      Array.isArray(manifest.model.labels) && manifest.model.labels.length >= 2 &&
      manifest.model.labels.every(isNonEmptyString) &&
      new Set(manifest.model.labels).size === manifest.model.labels.length) {
    model = {
      requested_id: manifest.model.requested_id,
      resolved_id: manifest.model.resolved_id,
      path: resolve(manifest.model.path),
      size_bytes: manifest.model.size_bytes,
      label_count: manifest.model.labels.length,
      available: existsSync(resolve(manifest.model.path)) && statSync(resolve(manifest.model.path)).isDirectory(),
    };
  }
  let evaluation: LocalClassifierRunSummary["evaluation"] = null;
  if (manifest.heldout !== null && isRecord(manifest.heldout) && manifest.verdict !== null &&
      isRecord(manifest.verdict) && isNonEmptyString(manifest.verdict.status) &&
      COMPLETED_VERDICTS.has(manifest.verdict.status) &&
      isSafeNonNegativeInteger(manifest.heldout.row_count) && manifest.heldout.row_count > 0 &&
      isMetric(manifest.heldout.accuracy) && isMetric(manifest.heldout.macro_f1) &&
      isFiniteNonNegative(manifest.heldout.latency_ms_p50) &&
      isSafeNonNegativeInteger(manifest.heldout.failure_count) &&
      manifest.heldout.failure_count <= manifest.heldout.row_count) {
    evaluation = {
      row_count: manifest.heldout.row_count,
      accuracy: manifest.heldout.accuracy,
      macro_f1: manifest.heldout.macro_f1,
      latency_ms_p50: manifest.heldout.latency_ms_p50,
      failure_count: manifest.heldout.failure_count,
      verdict: manifest.verdict.status,
    };
  }
  const failure = manifest.error && isNonEmptyString(manifest.error.code) && isNonEmptyString(manifest.error.message)
    ? { code: manifest.error.code, message: manifest.error.message }
    : null;
  if (status === "completed" && (model === null || evaluation === null)) {
    throw new Error("The completed local classifier omitted model or evaluation evidence.");
  }
  if (status === "completed" && failure !== null) {
    throw new Error("The completed local classifier contains contradictory failure evidence.");
  }
  if (status !== "completed" && (manifest.model !== null || manifest.heldout !== null || manifest.verdict !== null)) {
    throw new Error("The terminal local classifier run contains contradictory completion evidence.");
  }
  if (status !== "completed" && failure === null) {
    throw new Error("The terminal local classifier run omitted its failure evidence.");
  }
  return {
    schema_version: REGISTRY_SCHEMA,
    model_id: `classifier.${runId}`,
    kind: "classifier",
    run_id: runId,
    display_name: lifecycle.display_name,
    run_status: status,
    archived_at: lifecycle.archived_at,
    generated_at: generatedAt,
    updated_at: lifecycle.updated_at,
    local_only: true,
    manifest_path: resolve(path),
    model,
    evaluation,
    timing_ms: isFiniteNonNegative(manifest.timings_ms?.total) ? manifest.timings_ms.total : null,
    failure,
  };
}

function childDirectories(path: string, maximum: number): string[] {
  if (!existsSync(path) || !statSync(path).isDirectory()) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, maximum)
    .map((entry) => join(path, entry.name));
}

export function listLocalClassifierRuns(
  options: ListLocalClassifierRunsOptions = {},
): LocalClassifierRunSummary[] {
  const captureRoot = resolve(options.captureRoot ?? defaultCaptureRoot());
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Classification run list limit must be between 1 and 1,000.");
  }
  const runs: LocalClassifierRunSummary[] = [];
  for (const capturePath of childDirectories(captureRoot, MAX_CAPTURE_ROOTS)) {
    const trainingRoot = join(capturePath, "training-runs");
    for (const runPath of childDirectories(trainingRoot, MAX_RUNS_PER_CAPTURE)) {
      const manifestPath = join(runPath, "run-manifest.json");
      if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) continue;
      try {
        const item = summary(manifestPath);
        if (Boolean(item.archived_at) === Boolean(options.archived)) runs.push(item);
      } catch {
        // Registry discovery is resilient to an unrelated corrupt or partial
        // directory. Opening a specific run still fails closed with the exact error.
      }
    }
  }
  return runs
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.run_id.localeCompare(left.run_id))
    .slice(0, limit);
}

export function getLocalClassifierRun(runManifestPath: string): LocalClassifierRunSummary {
  const canonical = resolve(runManifestPath);
  if (!existsSync(canonical) || !statSync(canonical).isFile()) {
    throw new Error("The local classifier run is unavailable.");
  }
  return summary(canonical);
}

export function updateLocalClassifierRun(
  options: UpdateLocalClassifierRunOptions,
): LocalClassifierRunSummary {
  const canonical = resolve(options.runManifestPath);
  const { manifest, runId } = validateManifest(canonical);
  if (options.displayName === undefined && options.archived === undefined) {
    throw new Error("Choose a new display name, archive state, or both.");
  }
  const generatedAt = String(manifest.generated_at);
  const current = readLifecycle(canonical, runId, generatedAt);
  let displayName = current.display_name;
  if (options.displayName !== undefined) {
    displayName = options.displayName.trim();
    if (displayName.length < 1 || displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(displayName)) {
      throw new Error("Classifier display name must contain 1 to 80 printable characters.");
    }
  }
  const updatedAt = (options.now ?? new Date()).toISOString();
  const next: LifecycleRecord = {
    schema_version: LIFECYCLE_SCHEMA,
    run_id: runId,
    display_name: displayName,
    archived_at: options.archived === undefined
      ? current.archived_at
      : options.archived ? updatedAt : null,
    updated_at: updatedAt,
  };
  const path = lifecyclePath(canonical);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return summary(canonical);
}
