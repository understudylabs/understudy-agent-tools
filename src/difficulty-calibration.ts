import { taskBands } from "./automationbench-offline.js";
import { v2TaskBands } from "./automationbench-v2.js";

export type CalibrationFixture = "v1" | "v2" | "auto";

export type CalibrationRow = {
  task_id: string;
  family?: string;
  band?: string;
  tier?: string;
  split?: string;
  score?: number | null;
  [key: string]: unknown;
};

export type CalibrationOptions = {
  fixture?: CalibrationFixture;
  model?: string | null;
  split?: string | null;
  threshold?: number;
  minSample?: number;
  generatedAt?: string;
  source?: {
    path?: string | null;
    sha256?: string | null;
  };
};

export type BandStatus = "saturated" | "measurable" | "insufficient_sample";
export type BandVerdict = "block_training" | "invest" | "caution";

export type BandSummary = {
  tasks: number;
  scored: number;
  mean_score: number | null;
  exact_1: number;
  zero: number;
  headroom: number | null;
  ci: { lower: number; upper: number } | null;
  low_sample: boolean;
  saturated: boolean;
  saturated_lower_bound: boolean;
  status: BandStatus;
  verdict: BandVerdict;
};

export type CalibrationReport = {
  schema_version: "understudy.difficulty_calibration.v1";
  generated_at: string;
  source_run: {
    path: string | null;
    sha256: string | null;
  };
  fixture: string;
  model: string | null;
  split: string | null;
  threshold: number;
  min_sample: number;
  overall: {
    tasks: number;
    scored: number;
    mean: number | null;
    headroom: number | null;
  };
  bands: Record<string, BandSummary>;
  saturated_bands: string[];
  measurable_bands: string[];
  gate: {
    worth_investing: boolean;
    reason: string;
  };
};

const DEFAULT_THRESHOLD = 0.95;
const DEFAULT_MIN_SAMPLE = 10;
const V1_FIXTURE = "automationbench-simple-api-offline-v1";
const V2_FIXTURE = "automationbench-simple-api-offline-v2";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function rowFromUnknown(value: unknown): CalibrationRow | null {
  if (!isRecord(value) || !nonEmptyString(value.task_id)) return null;
  const row: CalibrationRow = { task_id: value.task_id };
  if (nonEmptyString(value.family)) row.family = value.family;
  if (nonEmptyString(value.band)) row.band = value.band;
  if (nonEmptyString(value.tier)) row.tier = value.tier;
  if (nonEmptyString(value.split)) row.split = value.split;
  if (typeof value.score === "number" && Number.isFinite(value.score)) row.score = value.score;
  else if (value.score === null) row.score = null;
  return row;
}

function familyFromTaskId(taskId: string): string | null {
  const match = /^(?:simple|hard)-api-(.+)-\d{2}$/.exec(taskId);
  return match?.[1] ?? null;
}

function fixtureId(fixture: CalibrationFixture): string {
  return fixture === "v2" ? V2_FIXTURE : V1_FIXTURE;
}

function normalizeThreshold(value: number | undefined): number {
  const threshold = value ?? DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error("threshold must be a finite number in (0, 1]");
  }
  return threshold;
}

function normalizeMinSample(value: number | undefined): number {
  const minSample = value ?? DEFAULT_MIN_SAMPLE;
  if (!Number.isInteger(minSample) || minSample < 1) {
    throw new Error("minSample must be a positive integer");
  }
  return minSample;
}

function rowBandMaps(): Record<string, string> {
  return { ...taskBands(), ...v2TaskBands() };
}

/**
 * Resolve a reporting-only difficulty band without allowing malformed rows to
 * throw. Explicit row labels win over fixture-derived family labels.
 */
export function resolveBand(row: unknown, fixture: CalibrationFixture = "auto"): string {
  if (!isRecord(row)) return "unknown";
  if (nonEmptyString(row.band)) return row.band;

  const taskId = nonEmptyString(row.task_id) ? row.task_id : "";
  const family = nonEmptyString(row.family) ? row.family : familyFromTaskId(taskId);
  if (!family) return "unknown";

  const maps = rowBandMaps();
  if (fixture === "v1") return taskBands()[family] ?? "unknown";
  if (fixture === "v2") return v2TaskBands()[family] ?? "unknown";
  return maps[family] ?? "unknown";
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function confidenceInterval(values: readonly number[], average: number | null): { lower: number; upper: number } | null {
  if (average === null) return null;
  if (values.length < 2) return { lower: average, upper: average };
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance) / Math.sqrt(values.length);
  return {
    lower: Math.max(0, average - margin),
    upper: Math.min(1, average + margin),
  };
}

function summarizeValues(values: readonly number[], tasks: number, threshold: number, minSample: number): BandSummary {
  const average = mean(values);
  const lowSample = values.length < minSample;
  const saturated = average !== null && average >= threshold;
  const ci = confidenceInterval(values, average);
  const status: BandStatus = saturated ? "saturated" : lowSample ? "insufficient_sample" : "measurable";
  return {
    tasks,
    scored: values.length,
    mean_score: average,
    exact_1: values.filter((value) => value === 1).length,
    zero: values.filter((value) => value === 0).length,
    headroom: average === null ? null : 1 - average,
    ci,
    saturated_lower_bound: ci !== null && ci.lower >= threshold,
    low_sample: lowSample,
    saturated,
    status,
    verdict: saturated ? "block_training" : lowSample ? "caution" : "invest",
  };
}

export function summarizeBands(
  rows: readonly unknown[],
  options: { fixture?: CalibrationFixture; threshold?: number; minSample?: number } = {},
): Record<string, BandSummary> {
  const threshold = normalizeThreshold(options.threshold);
  const minSample = normalizeMinSample(options.minSample);
  const buckets = new Map<string, { tasks: number; scores: number[] }>();

  for (const rawRow of rows) {
    const row = rowFromUnknown(rawRow);
    if (!row) continue;
    const band = resolveBand(row, options.fixture ?? "auto");
    const bucket = buckets.get(band) ?? { tasks: 0, scores: [] };
    bucket.tasks += 1;
    if (typeof row.score === "number" && row.score >= 0 && row.score <= 1) bucket.scores.push(row.score);
    buckets.set(band, bucket);
  }

  return Object.fromEntries(
    [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([band, bucket]) => [band, summarizeValues(bucket.scores, bucket.tasks, threshold, minSample)]),
  );
}

export function buildCalibrationReport(rows: readonly unknown[], options: CalibrationOptions = {}): CalibrationReport {
  const threshold = normalizeThreshold(options.threshold);
  const minSample = normalizeMinSample(options.minSample);
  const fixture = options.fixture ?? "auto";
  const bands = summarizeBands(rows, { fixture, threshold, minSample });
  const validRows = rows.map(rowFromUnknown).filter((row): row is CalibrationRow => row !== null);
  const scores = validRows
    .map((row) => row.score)
    .filter((score): score is number => typeof score === "number" && score >= 0 && score <= 1);
  const overallMean = mean(scores);
  const saturatedBands = Object.entries(bands).filter(([, summary]) => summary.status === "saturated").map(([band]) => band);
  const measurableBands = Object.entries(bands).filter(([, summary]) => summary.status === "measurable").map(([band]) => band);
  const worthInvesting = measurableBands.some((band) => (bands[band].headroom ?? 0) > 0);
  const reason = worthInvesting
    ? `Investable headroom remains in: ${measurableBands.join(", ")}.`
    : saturatedBands.length > 0
      ? `No measurable band has headroom; saturated bands block training: ${saturatedBands.join(", ")}.`
      : "No band has enough scored rows to support a training investment decision.";

  const detectedFixture = fixture === "auto"
    ? validRows.some((row) => row.task_id.startsWith("hard-api-") || row.tier === "hard") ? V2_FIXTURE : V1_FIXTURE
    : fixtureId(fixture);
  const detectedSplit = options.split ?? validRows.find((row) => nonEmptyString(row.split))?.split ?? null;
  const detectedModel = options.model ?? null;

  return {
    schema_version: "understudy.difficulty_calibration.v1",
    generated_at: options.generatedAt ?? new Date().toISOString(),
    source_run: {
      path: options.source?.path ?? null,
      sha256: options.source?.sha256 ?? null,
    },
    fixture: detectedFixture,
    model: detectedModel,
    split: detectedSplit,
    threshold,
    min_sample: minSample,
    overall: {
      tasks: validRows.length,
      scored: scores.length,
      mean: overallMean,
      headroom: overallMean === null ? null : 1 - overallMean,
    },
    bands,
    saturated_bands: saturatedBands,
    measurable_bands: measurableBands,
    gate: { worth_investing: worthInvesting, reason },
  };
}
