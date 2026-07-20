import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { globalConfigDir } from "./config/paths.js";

export type CaptureSourceKind =
  | "eval-fixture"
  | "golden-fixture"
  | "jsonl-data"
  | "csv-data"
  | "prompt-file"
  | "app-route"
  | "provider-trace"
  | "document"
  | "spreadsheet"
  | "source-file"
  | "media-file"
  | "local-file";

export type CaptureSource = {
  id: string;
  path: string;
  kind: CaptureSourceKind;
  bytes: number;
  extension: string;
  evidence: string[];
};

export type RedactionManifest = {
  generated_at: string;
  repo: string;
  policy: "metadata-only";
  rules: string[];
  source_count: number;
  payload_fields_omitted: string[];
};

export type CaptureScanManifest = {
  generated_at: string;
  repo: string;
  input_source: string;
  input_kind: "file" | "directory";
  scanned_file_count: number;
  scan_file_limit: number;
  scan_source_limit: number;
  truncated: boolean;
  source_count: number;
  sources: CaptureSource[];
  redaction_manifest_path: string;
};

export type CaptureCompileResult = {
  generated_at: string;
  source_name: string;
  source_path: string;
  source_type: "file" | "directory";
  scanned_file_count: number;
  source_count: number;
  total_bytes: number;
  source_kinds: Partial<Record<CaptureSourceKind, number>>;
  truncated: boolean;
  local_only: true;
  payload_read: false;
  artifact_root: string;
  manifest_path: string;
  workload_card_path: string;
};

export type CaptureCsvColumnSummary = {
  name: string;
  non_empty_count: number;
  empty_count: number;
  unique_count: number;
  unique_ratio: number;
  numeric_count: number;
  numeric_ratio: number;
  profile_kind: "number" | "date" | "category" | "text";
  profile_bars: number[];
};

export type CaptureCsvInspection = {
  schema_version: "understudy.capture_import.csv_inspection.v1";
  generated_at: string;
  source_name: string;
  source_path: string;
  source_sha256: string;
  source_bytes: number;
  local_only: true;
  payload_read: true;
  source_rows_persisted: false;
  row_preview_persisted: false;
  persisted_data: "statistics-and-label-aggregates";
  row_count: number;
  column_count: number;
  duplicate_row_count: number;
  row_preview: {
    row_number: number;
    values: Record<string, string>;
  }[];
  columns: CaptureCsvColumnSummary[];
  recommended_mapping: {
    label_column: string | null;
    input_columns: string[];
    group_column: string | null;
    confidence: "high" | "low" | "none";
    requires_confirmation: true;
  };
  label_distribution: {
    value: string;
    count: number;
  }[];
  label_distribution_truncated: boolean;
  training_readiness: {
    ready: boolean;
    status: "ready" | "needs_mapping" | "needs_data" | "needs_cleanup";
    class_count: number;
    minimum_examples_per_class: number | null;
    reasons: string[];
    warnings: string[];
  };
  limits: {
    max_bytes: number;
    max_rows: number;
    max_columns: number;
    max_field_characters: number;
    max_reported_labels: number;
  };
  artifact_path: string;
};

export type CaptureClassificationDataset = {
  schema_version: "understudy.capture_import.classification_dataset.v2";
  dataset_id: string;
  generated_at: string;
  source_path: string;
  source_sha256: string;
  mapping_sha256: string;
  local_only: true;
  network_required: false;
  mapping_confirmation: "caller-provided";
  source_rows_persisted_as_transformed_examples: true;
  source_row_count: number;
  duplicate_rows_removed: number;
  unusable_rows_removed: number;
  row_count: number;
  mapping: {
    input_columns: string[];
    label_column: string;
    group_column: string;
    text_template: "named-fields-v1";
  };
  labels: string[];
  label_distribution: { value: string; count: number }[];
  split_policy: {
    name: "deterministic-stratified-group-aware-v2";
    allocation: "per-label-deterministic-group-greedy-v1";
    group_key: string;
    group_normalization: "casefold-reference-stripping-v1";
    no_group_overlap: true;
    target_train_ratio: 0.7;
    target_dev_ratio: 0.15;
    target_holdout_ratio: 0.15;
    holdout_reserved_for_final_validation: true;
  };
  splits: {
    train: CaptureClassificationSplit;
    dev: CaptureClassificationSplit;
    holdout: CaptureClassificationSplit;
  };
  artifact_root: string;
  manifest_path: string;
};

export type CaptureClassificationSplit = {
  path: string;
  row_count: number;
  sha256: string;
};

export type CapturePreview = {
  generated_at: string;
  repo: string;
  source_id: string;
  limit: number;
  source: CaptureSource;
  data_class: "metadata-only";
  payload_read: false;
  approval_required_before_payload_read: true;
};

export type WorkloadCard = {
  schema_version: "understudy.workload_card.v1";
  workload_id: string;
  workload_name: string | null;
  owner: null;
  candidate_id: string;
  source_path: string | null;
  mode: "local-only";
  workload_shape: string[];
  value_lens: string[];
  success_metric: null;
  validator: {
    name: string | null;
    type: "unit" | "golden" | "llm-judge" | "human-review" | "custom";
    source_path: string | null;
    approval_required_for_payload_access: true;
  };
  harness: {
    name: string | null;
    command: string | null;
    source_path: string | null;
    environment: {
      runtime: string | null;
      dependencies_lockfile: string | null;
      provider_keys_required: false;
      network_required: false;
    };
  };
  baseline: {
    provider: null;
    model: null;
    latency_ms: null;
    input_tokens: null;
    output_tokens: null;
    cost_usd: null;
    rerun_required: true;
    rerun_reason: string;
    rerun_artifact: null;
    harness_sha256: null;
    metric_sha256: null;
    splits_sha256: null;
  };
  data_class: "source-metadata-only";
  split_boundary: {
    train: null;
    dev: null;
    holdout: null;
  };
  evaluation_inputs: CaptureSource[];
  promotion_gate: null;
  fallback_route: null;
  route_requirements: {
    privacy_boundary: "workflow-bound cloud unless Local is selected";
    latency_target_ms: null;
    structured_output_required: boolean;
    tool_calling_required: boolean;
    pricing_source_required_before_hosted_recommendation: true;
    supplier_profile_required_before_hosted_recommendation: true;
  };
  optimization_rules: {
    gepa_uses_train_dev_only: true;
    holdout_reserved_for_final_validation: true;
  };
  approval_gates: string[];
  discovery: {
    generated_at: string;
    generated_from: "understudy capture-import scan";
    repo: string;
    source_count: number;
    source_kinds: Record<CaptureSourceKind, number>;
    recommended_next_steps: string[];
    evidence_paths: string[];
    capture_sources: string;
    redaction_manifest: string;
  };
};

const ignoredDirs = new Set([
  ".git",
  ".understudy",
  "dist",
  "node_modules",
  "__pycache__",
  ".next",
  ".turbo",
]);

const kindOrder: CaptureSourceKind[] = [
  "eval-fixture",
  "golden-fixture",
  "jsonl-data",
  "csv-data",
  "prompt-file",
  "app-route",
  "provider-trace",
  "document",
  "spreadsheet",
  "source-file",
  "media-file",
  "local-file",
];

const MAX_SCAN_FILES = 5_000;
const MAX_CAPTURE_SOURCES = 1_000;
const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_CSV_ROWS = 50_000;
const MAX_CSV_COLUMNS = 128;
const MAX_CSV_FIELD_CHARACTERS = 65_536;
const MAX_CSV_PREVIEW_ROWS = 2;
const MAX_CSV_PREVIEW_FIELD_CHARACTERS = 800;
const MAX_REPORTED_LABELS = 50;
const MIN_EXAMPLES_PER_CLASS = 20;

export function artifactDir(repo: string): string {
  return join(repo, ".understudy", "capture-import");
}

export function scanCaptureImport(
  repoInput: string,
  now = new Date(),
  sourceInput?: string,
  outputDirInput?: string,
): CaptureScanManifest {
  const repoResolved = resolve(repoInput);
  if (!existsSync(repoResolved)) {
    throw new Error(`Repository path does not exist: ${repoResolved}`);
  }
  const repo = repoResolved;
  const sourceResolved = resolve(sourceInput ?? repo);
  if (!existsSync(sourceResolved)) {
    throw new Error(`Capture/import source does not exist: ${sourceResolved}`);
  }
  const inputSource = sourceResolved;
  const canonicalRepo = realpathSync(repo);
  const canonicalSource = realpathSync(inputSource);
  const sourceRelativeToRepo = relative(canonicalRepo, canonicalSource);
  if (
    sourceRelativeToRepo === ".." ||
    sourceRelativeToRepo.startsWith("../") ||
    sourceRelativeToRepo.startsWith("..\\") ||
    resolve(canonicalRepo, sourceRelativeToRepo) !== canonicalSource
  ) {
    throw new Error(`Capture/import source must be inside the repository root: ${inputSource}`);
  }
  const inputStat = statSync(inputSource);
  if (!inputStat.isFile() && !inputStat.isDirectory()) {
    throw new Error(`Capture/import source must be a file or directory: ${inputSource}`);
  }
  const collected = collectSources(repo, inputSource, sourceInput !== undefined);
  const generated_at = now.toISOString();
  const outputDir = outputDirInput ? resolve(outputDirInput) : artifactDir(repo);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  setPrivateMode(outputDir, 0o700);

  const redactionManifest: RedactionManifest = {
    generated_at,
    repo,
    policy: "metadata-only",
    rules: [
      "Record paths, file sizes, extensions, and detection evidence only.",
      "Do not read or persist prompts, completions, traces, examples, customer data, or secrets.",
      "Keep artifacts local under .understudy/capture-import.",
    ],
    source_count: collected.sources.length,
    payload_fields_omitted: ["contents", "prompt", "completion", "messages", "input", "output", "trace"],
  };

  const redactionPath = join(outputDir, "redaction-manifest.json");
  writeJson(redactionPath, redactionManifest);

  const manifest: CaptureScanManifest = {
    generated_at,
    repo,
    input_source: inputSource,
    input_kind: inputStat.isFile() ? "file" : "directory",
    scanned_file_count: collected.scannedFileCount,
    scan_file_limit: MAX_SCAN_FILES,
    scan_source_limit: MAX_CAPTURE_SOURCES,
    truncated: collected.truncated,
    source_count: collected.sources.length,
    sources: collected.sources,
    redaction_manifest_path: artifactReference(repo, redactionPath),
  };
  writeJson(join(outputDir, "capture-sources.json"), manifest);
  return manifest;
}

export function readCaptureManifest(repoInput: string, outputDirInput?: string): CaptureScanManifest {
  const repo = resolve(repoInput);
  const outputDir = outputDirInput ? resolve(outputDirInput) : artifactDir(repo);
  const manifestPath = join(outputDir, "capture-sources.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing capture/import scan manifest: ${relative(process.cwd(), manifestPath)}`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as CaptureScanManifest;
}

export function previewCaptureImport(repoInput: string, sourceId: string, limit: number, now = new Date()): CapturePreview {
  const repo = resolve(repoInput);
  const manifest = readCaptureManifest(repoInput);
  const source = manifest.sources.find((candidate) => candidate.id === sourceId);
  if (!source) {
    throw new Error(`Unknown capture/import source id: ${sourceId}`);
  }
  const preview: CapturePreview = {
    generated_at: now.toISOString(),
    repo,
    source_id: sourceId,
    limit,
    source,
    data_class: "metadata-only",
    payload_read: false,
    approval_required_before_payload_read: true,
  };
  writeJson(join(artifactDir(repo), `preview-${sourceId}.json`), preview);
  return preview;
}

export function buildWorkloadCard(repoInput: string, now = new Date(), outputDirInput?: string): WorkloadCard {
  const repo = resolve(repoInput);
  const outputDir = outputDirInput ? resolve(outputDirInput) : artifactDir(repo);
  const manifest = readCaptureManifest(repo, outputDir);
  const source_kinds = Object.fromEntries(kindOrder.map((kind) => [kind, 0])) as Record<CaptureSourceKind, number>;
  for (const source of manifest.sources) {
    source_kinds[source.kind] += 1;
  }
  const card: WorkloadCard = {
    schema_version: "understudy.workload_card.v1",
    workload_id: "capture-import",
    workload_name: basename(manifest.input_source),
    owner: null,
    candidate_id: "metadata-discovery",
    source_path: manifest.input_source,
    mode: "local-only",
    workload_shape: ["metadata-discovered"],
    value_lens: ["quality", "cost", "latency"],
    success_metric: null,
    validator: {
      name: null,
      type: "custom",
      source_path: null,
      approval_required_for_payload_access: true,
    },
    harness: {
      name: null,
      command: null,
      source_path: null,
      environment: {
        runtime: null,
        dependencies_lockfile: null,
        provider_keys_required: false,
        network_required: false,
      },
    },
    baseline: {
      provider: null,
      model: null,
      latency_ms: null,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      rerun_required: true,
      rerun_reason: "capture-import records metadata only; measure the incumbent after capture-evidence artifacts exist",
      rerun_artifact: null,
      harness_sha256: null,
      metric_sha256: null,
      splits_sha256: null,
    },
    data_class: "source-metadata-only",
    split_boundary: {
      train: null,
      dev: null,
      holdout: null,
    },
    evaluation_inputs: manifest.sources,
    promotion_gate: null,
    fallback_route: null,
    route_requirements: {
      privacy_boundary: "workflow-bound cloud unless Local is selected",
      latency_target_ms: null,
      structured_output_required: manifest.sources.some((source) => source.kind === "jsonl-data" || source.kind === "app-route"),
      tool_calling_required: manifest.sources.some((source) => source.kind === "provider-trace"),
      pricing_source_required_before_hosted_recommendation: true,
      supplier_profile_required_before_hosted_recommendation: true,
    },
    optimization_rules: {
      gepa_uses_train_dev_only: true,
      holdout_reserved_for_final_validation: true,
    },
    approval_gates: [
      "expanding the activated data classes or destination",
      "increasing the activated spend or retention envelope",
      "adding production writes not shown in the activated plan",
    ],
    discovery: {
      generated_at: now.toISOString(),
      generated_from: "understudy capture-import scan",
      repo,
      source_count: manifest.source_count,
      source_kinds,
      recommended_next_steps: [
        "Confirm which metadata-only sources belong to the workload.",
        "Create or update the capture-evidence harness, metric, splits, and baseline artifacts.",
        "Run optimize-workload only after the workload contract is hash-bound.",
      ],
      evidence_paths: [
        artifactReference(repo, join(outputDir, "capture-sources.json")),
        artifactReference(repo, join(outputDir, "redaction-manifest.json")),
      ],
      capture_sources: artifactReference(repo, join(outputDir, "capture-sources.json")),
      redaction_manifest: artifactReference(repo, join(outputDir, "redaction-manifest.json")),
    },
  };
  writeJson(join(outputDir, "workload-card.json"), card);
  return card;
}

export function compileCaptureImport(
  sourceInput: string,
  now = new Date(),
  outputRootInput = join(globalConfigDir(), "capture-imports"),
): CaptureCompileResult {
  const sourceResolved = resolve(sourceInput);
  if (!existsSync(sourceResolved)) {
    throw new Error(`Capture/import source does not exist: ${sourceResolved}`);
  }
  const source = sourceResolved;
  const sourceStat = statSync(source);
  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    throw new Error(`Capture/import source must be a file or directory: ${source}`);
  }
  const repo = sourceStat.isDirectory() ? source : dirname(source);
  const dropId = createHash("sha256")
    .update(`${source}\0${now.toISOString()}`)
    .digest("hex")
    .slice(0, 12);
  const outputDir = join(resolve(outputRootInput), dropId);
  const manifest = scanCaptureImport(repo, now, source, outputDir);
  const card = buildWorkloadCard(repo, now, outputDir);
  const sourceKinds = Object.fromEntries(
    Object.entries(card.discovery.source_kinds).filter(([, count]) => count > 0),
  ) as Partial<Record<CaptureSourceKind, number>>;
  return {
    generated_at: now.toISOString(),
    source_name: basename(source),
    source_path: source,
    source_type: sourceStat.isFile() ? "file" : "directory",
    scanned_file_count: manifest.scanned_file_count,
    source_count: manifest.source_count,
    total_bytes: manifest.sources.reduce((total, item) => total + item.bytes, 0),
    source_kinds: sourceKinds,
    truncated: manifest.truncated,
    local_only: true,
    payload_read: false,
    artifact_root: outputDir,
    manifest_path: join(outputDir, "capture-sources.json"),
    workload_card_path: join(outputDir, "workload-card.json"),
  };
}

export function inspectCaptureCsv(
  sourceInput: string,
  artifactRootInput: string,
  now = new Date(),
): CaptureCsvInspection {
  const source = resolve(sourceInput);
  if (!existsSync(source)) {
    throw new Error(`CSV source does not exist: ${source}`);
  }
  const sourceStat = statSync(source);
  if (!sourceStat.isFile()) {
    throw new Error(`CSV inspection requires one file: ${source}`);
  }
  if (sourceStat.size > MAX_CSV_BYTES) {
    throw new Error(`Table is ${sourceStat.size} bytes; the local inspection limit is ${MAX_CSV_BYTES} bytes.`);
  }

  const artifactRoot = resolve(artifactRootInput);
  if (!existsSync(artifactRoot) || !statSync(artifactRoot).isDirectory()) {
    throw new Error(`Capture artifact root does not exist: ${artifactRoot}`);
  }

  const { bytes, headers, rows } = readDelimitedTable(source);
  if (headers.length > MAX_CSV_COLUMNS) {
    throw new Error(`Table has ${headers.length} columns; the local inspection limit is ${MAX_CSV_COLUMNS}.`);
  }
  if (headers.some((header) => header.length === 0)) {
    throw new Error("Table headers must not be empty.");
  }
  const normalizedHeaders = headers.map(normalizeHeader);
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length) {
    throw new Error("Table headers must be unique after case and spacing normalization.");
  }
  if (rows.length > MAX_CSV_ROWS) {
    throw new Error(`Table has more than ${MAX_CSV_ROWS} data rows; split it before local inspection.`);
  }
  rows.forEach((row, index) => {
    if (row.length !== headers.length) {
      throw new Error(
        `Table record ${index + 1} has ${row.length} fields; expected ${headers.length}.`,
      );
    }
  });

  const columns = headers.map((name, columnIndex): CaptureCsvColumnSummary => {
    const values = rows.map((row) => row[columnIndex].trim());
    const nonEmpty = values.filter(Boolean);
    const numericCount = nonEmpty.filter(isFiniteNumber).length;
    const dateCount = nonEmpty.filter(isDateLike).length;
    const uniqueCount = new Set(nonEmpty).size;
    const numericRatio = ratio(numericCount, nonEmpty.length);
    const dateRatio = ratio(dateCount, nonEmpty.length);
    const profileKind: CaptureCsvColumnSummary["profile_kind"] = dateRatio >= 0.8
      ? "date"
      : numericRatio >= 0.8
        ? "number"
        : uniqueCount <= Math.max(3, Math.min(14, Math.floor(rows.length / 4)))
          ? "category"
          : "text";
    return {
      name,
      non_empty_count: nonEmpty.length,
      empty_count: rows.length - nonEmpty.length,
      unique_count: uniqueCount,
      unique_ratio: ratio(uniqueCount, nonEmpty.length),
      numeric_count: numericCount,
      numeric_ratio: numericRatio,
      profile_kind: profileKind,
      profile_bars: profileBars(nonEmpty, profileKind),
    };
  });

  const labelCandidate = chooseLabelColumn(headers, columns);
  const labelIndex = labelCandidate ? headers.indexOf(labelCandidate.name) : -1;
  const inputColumns = headers.filter((name, index) => index !== labelIndex && columns[index].non_empty_count > 0);
  const groupColumn = chooseGroupColumn(headers, columns, labelIndex);
  const labelCounts = new Map<string, number>();
  if (labelIndex >= 0) {
    for (const row of rows) {
      const label = row[labelIndex].trim();
      if (label) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }
  const sortedLabels = [...labelCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const minimumExamples = sortedLabels.length > 0
    ? Math.min(...sortedLabels.map(([, count]) => count))
    : null;
  const duplicateRowCount = rows.length - new Set(rows.map((row) => JSON.stringify(row))).size;
  const previewIndexes = labelIndex >= 0
    ? sortedLabels.slice(0, MAX_CSV_PREVIEW_ROWS).map(([label]) =>
      rows.findIndex((row) => row[labelIndex].trim() === label),
    )
    : Array.from({ length: Math.min(MAX_CSV_PREVIEW_ROWS, rows.length) }, (_, index) =>
      Math.floor(index * Math.max(0, rows.length - 1) / Math.max(1, MAX_CSV_PREVIEW_ROWS - 1)),
    );
  const rowPreview = [...new Set(previewIndexes)]
    .filter((index) => index >= 0)
    .map((index) => ({
      row_number: index + 1,
      values: Object.fromEntries(headers.map((header, columnIndex) => [
        header,
        rows[index][columnIndex]
          .split(/\s+/)
          .filter(Boolean)
          .join(" ")
          .slice(0, MAX_CSV_PREVIEW_FIELD_CHARACTERS),
      ])),
    }));
  const reasons: string[] = [];
  const warnings: string[] = [];
  let status: CaptureCsvInspection["training_readiness"]["status"] = "ready";

  if (!labelCandidate) {
    status = "needs_mapping";
    reasons.push("Choose the column containing the expected category or label.");
  } else if (inputColumns.length === 0) {
    status = "needs_mapping";
    reasons.push("Choose at least one non-label input column.");
  } else if (!groupColumn) {
    status = "needs_mapping";
    reasons.push("Choose a merchant, payee, or description column so related rows stay in one split.");
  } else if (labelCounts.size < 2) {
    status = "needs_data";
    reasons.push("At least two label values are required for classification.");
  } else if (columns[labelIndex].empty_count > 0) {
    status = "needs_cleanup";
    reasons.push(`${columns[labelIndex].empty_count} row(s) have an empty label.`);
  } else if (minimumExamples !== null && minimumExamples < MIN_EXAMPLES_PER_CLASS) {
    status = "needs_data";
    reasons.push(
      `The smallest class has ${minimumExamples} row(s); collect at least ${MIN_EXAMPLES_PER_CLASS} per class for the first training run.`,
    );
  }

  if (labelCandidate && columns[labelIndex].unique_count === columns[labelIndex].non_empty_count && rows.length >= 5) {
    warnings.push("Every label is unique; this looks like an identifier rather than a reusable category.");
  } else if (labelCandidate && rows.length >= MIN_EXAMPLES_PER_CLASS && columns[labelIndex].unique_ratio > 0.5) {
    warnings.push("More than half of the labels are unique; this may be an identifier rather than a reusable category.");
  }
  if (duplicateRowCount > 0) {
    warnings.push(`${duplicateRowCount} exact duplicate row(s) will be removed before splitting the dataset.`);
  }
  if (groupColumn) {
    const groupIndex = headers.indexOf(groupColumn);
    const unusableGroupCount = rows.filter((row) =>
      !normalizeClassificationGroup(row[groupIndex]),
    ).length;
    if (unusableGroupCount > 0) {
      warnings.push(`${unusableGroupCount} row(s) with no usable ${groupColumn} value will be removed before splitting.`);
    }
  }
  if (sortedLabels.length > MAX_REPORTED_LABELS) {
    warnings.push(`Only the ${MAX_REPORTED_LABELS} most frequent labels are included in this summary.`);
  }

  const artifactPath = join(artifactRoot, "csv-inspection.json");
  const inspection: CaptureCsvInspection = {
    schema_version: "understudy.capture_import.csv_inspection.v1",
    generated_at: now.toISOString(),
    source_name: basename(source),
    source_path: source,
    source_sha256: createHash("sha256").update(bytes).digest("hex"),
    source_bytes: bytes.length,
    local_only: true,
    payload_read: true,
    source_rows_persisted: false,
    row_preview_persisted: false,
    persisted_data: "statistics-and-label-aggregates",
    row_count: rows.length,
    column_count: headers.length,
    duplicate_row_count: duplicateRowCount,
    row_preview: rowPreview,
    columns,
    recommended_mapping: {
      label_column: labelCandidate?.name ?? null,
      input_columns: inputColumns,
      group_column: groupColumn,
      confidence: labelCandidate?.confidence ?? "none",
      requires_confirmation: true,
    },
    label_distribution: sortedLabels
      .slice(0, MAX_REPORTED_LABELS)
      .map(([value, count]) => ({ value, count })),
    label_distribution_truncated: sortedLabels.length > MAX_REPORTED_LABELS,
    training_readiness: {
      ready: status === "ready",
      status,
      class_count: labelCounts.size,
      minimum_examples_per_class: minimumExamples,
      reasons,
      warnings,
    },
    limits: {
      max_bytes: MAX_CSV_BYTES,
      max_rows: MAX_CSV_ROWS,
      max_columns: MAX_CSV_COLUMNS,
      max_field_characters: MAX_CSV_FIELD_CHARACTERS,
      max_reported_labels: MAX_REPORTED_LABELS,
    },
    artifact_path: artifactPath,
  };
  const { row_preview: _ephemeralPreview, ...persistedInspection } = inspection;
  writeJson(artifactPath, persistedInspection);
  return inspection;
}

export function prepareCaptureClassificationDataset(
  sourceInput: string,
  artifactRootInput: string,
  inputColumnsInput: string[],
  labelColumnInput: string,
  groupColumnInput: string,
  now = new Date(),
): CaptureClassificationDataset {
  const source = resolve(sourceInput);
  const artifactRoot = resolve(artifactRootInput);
  const inspectionPath = join(artifactRoot, "csv-inspection.json");
  if (!existsSync(inspectionPath)) {
    throw new Error("Inspect this CSV locally before confirming its training mapping.");
  }
  const inspection = JSON.parse(readFileSync(inspectionPath, "utf8")) as Partial<CaptureCsvInspection>;
  if (inspection.schema_version !== "understudy.capture_import.csv_inspection.v1") {
    throw new Error("The CSV inspection has an unsupported schema version.");
  }

  const { bytes, headers, rows } = readCsvForTraining(source);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  if (inspection.source_sha256 !== sourceSha256) {
    throw new Error("The CSV changed after inspection; inspect it again before preparing training data.");
  }

  const headerByNormalized = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const labelColumn = headerByNormalized.get(normalizeHeader(labelColumnInput));
  if (!labelColumn) {
    throw new Error(`Unknown label column: ${labelColumnInput}`);
  }
  const inputColumns = [...new Set(inputColumnsInput.map((column) =>
    headerByNormalized.get(normalizeHeader(column)),
  ))].filter((column): column is string => Boolean(column));
  if (inputColumns.length !== new Set(inputColumnsInput.map(normalizeHeader)).size) {
    throw new Error("Every input column must match one inspected CSV header.");
  }
  if (inputColumns.length === 0) {
    throw new Error("Choose at least one input column.");
  }
  if (inputColumns.includes(labelColumn)) {
    throw new Error("The label column cannot also be an input column.");
  }
  const groupColumn = headerByNormalized.get(normalizeHeader(groupColumnInput));
  if (!groupColumn) {
    throw new Error(`Unknown leakage group column: ${groupColumnInput}`);
  }
  if (groupColumn === labelColumn) {
    throw new Error("The label column cannot also be the leakage group column.");
  }

  const labelIndex = headers.indexOf(labelColumn);
  const groupIndex = headers.indexOf(groupColumn);
  const inputIndexes = inputColumns.map((column) => headers.indexOf(column));
  const sourceRowCount = rows.length;
  const seenRows = new Set<string>();
  const uniqueRows = rows
    .map((row, sourceIndex) => ({ row, sourceIndex }))
    .filter(({ row }) => {
      const key = JSON.stringify(row);
      if (seenRows.has(key)) return false;
      seenRows.add(key);
      return true;
    });
  const duplicateRowsRemoved = sourceRowCount - uniqueRows.length;

  type Example = {
    schema_version: "understudy.classification_example.v2";
    example_id: string;
    group_id: string;
    text: string;
    label: string;
  };
  const groupsByLabel = new Map<string, Map<string, Example[]>>();
  const groupOwners = new Map<string, string>();
  let unusableRowsRemoved = 0;
  uniqueRows.forEach(({ row, sourceIndex }) => {
    const label = row[labelIndex].trim();
    if (!label) throw new Error(`Table record ${sourceIndex + 1} has an empty label.`);
    const normalizedGroup = normalizeClassificationGroup(row[groupIndex]);
    if (!normalizedGroup) {
      unusableRowsRemoved += 1;
      return;
    }
    const groupId = createHash("sha256").update(normalizedGroup).digest("hex").slice(0, 24);
    const existingOwner = groupOwners.get(groupId);
    if (existingOwner && existingOwner !== label) {
      throw new Error(
        `The confirmed leakage group maps to multiple labels (${existingOwner}, ${label}); choose a more specific group column or clean the labels.`,
      );
    }
    groupOwners.set(groupId, label);
    const text = inputIndexes
      .map((index) => ({ name: headers[index], value: row[index].trim() }))
      .filter(({ value }) => value.length > 0)
      .map(({ name, value }) => `${name}: ${value}`)
      .join("\n");
    if (!text) {
      unusableRowsRemoved += 1;
      return;
    }
    const example: Example = {
      schema_version: "understudy.classification_example.v2",
      example_id: createHash("sha256")
        .update(`${sourceSha256}\0${sourceIndex}\0${JSON.stringify(row)}`)
        .digest("hex")
        .slice(0, 24),
      group_id: groupId,
      text,
      label,
    };
    const labelGroups = groupsByLabel.get(label) ?? new Map<string, Example[]>();
    const group = labelGroups.get(groupId) ?? [];
    group.push(example);
    labelGroups.set(groupId, group);
    groupsByLabel.set(label, labelGroups);
  });
  if (groupsByLabel.size < 2) {
    throw new Error("At least two label values are required for classification.");
  }
  const labelCounts = new Map([...groupsByLabel.entries()].map(([label, groups]) => [
    label,
    [...groups.values()].reduce((total, examples) => total + examples.length, 0),
  ]));
  const undersized = [...labelCounts.entries()]
    .filter(([, count]) => count < MIN_EXAMPLES_PER_CLASS);
  if (undersized.length > 0) {
    const preview = undersized
      .slice(0, 20)
      .map(([label, count]) => `${label.slice(0, 80)} (${count})`)
      .join(", ");
    const remainder = undersized.length > 20 ? `, plus ${undersized.length - 20} more` : "";
    throw new Error(
      `Each class needs at least ${MIN_EXAMPLES_PER_CLASS} rows before splitting: ${preview}${remainder}`,
    );
  }
  const underGrouped = [...groupsByLabel.entries()].filter(([, groups]) => groups.size < 3);
  if (underGrouped.length > 0) {
    const preview = underGrouped
      .slice(0, 20)
      .map(([label, groups]) => `${label.slice(0, 80)} (${groups.size} distinct group${groups.size === 1 ? "" : "s"})`)
      .join(", ");
    const remainder = underGrouped.length > 20 ? `, plus ${underGrouped.length - 20} more` : "";
    throw new Error(
      `Each class needs at least three distinct leakage groups for train, dev, and holdout: ${preview}${remainder}`,
    );
  }

  const labels = [...groupsByLabel.keys()].sort((left, right) => left.localeCompare(right));
  const mapping = {
    input_columns: inputColumns,
    label_column: labelColumn,
    group_column: groupColumn,
    text_template: "named-fields-v1" as const,
  };
  const mappingSha256 = createHash("sha256").update(JSON.stringify(mapping)).digest("hex");
  const datasetId = createHash("sha256")
    .update(`${sourceSha256}\0${mappingSha256}`)
    .digest("hex")
    .slice(0, 16);
  const datasetRoot = join(artifactRoot, "classification", datasetId);
  mkdirSync(datasetRoot, { recursive: true, mode: 0o700 });
  setPrivateMode(datasetRoot, 0o700);
  const splitRows = { train: [] as Example[], dev: [] as Example[], holdout: [] as Example[] };
  for (const label of labels) {
    const rankedGroups = [...groupsByLabel.get(label)!.entries()].sort((left, right) =>
      stableGroupRank(sourceSha256, label, left[0]).localeCompare(stableGroupRank(sourceSha256, label, right[0])),
    );
    const total = labelCounts.get(label)!;
    const targets = { train: total * 0.7, dev: total * 0.15, holdout: total * 0.15 };
    const assigned = { train: 0, dev: 0, holdout: 0 };
    const splitOrder = ["dev", "holdout", "train"] as const;
    rankedGroups.forEach(([, examples], index) => {
      let split: keyof typeof splitRows;
      if (index < splitOrder.length) {
        split = splitOrder[index];
      } else {
        const candidates: (keyof typeof splitRows)[] = ["train", "dev", "holdout"];
        split = candidates.sort((left, right) => {
          const leftDeficit = (targets[left] - assigned[left]) / targets[left];
          const rightDeficit = (targets[right] - assigned[right]) / targets[right];
          return rightDeficit - leftDeficit;
        })[0];
      }
      splitRows[split].push(...examples);
      assigned[split] += examples.length;
    });
  }

  const splitGroupSets = Object.fromEntries(Object.entries(splitRows).map(([name, examples]) => [
    name,
    new Set(examples.map((example) => example.group_id)),
  ])) as Record<keyof typeof splitRows, Set<string>>;
  for (const [left, right] of [["train", "dev"], ["train", "holdout"], ["dev", "holdout"]] as const) {
    if ([...splitGroupSets[left]].some((groupId) => splitGroupSets[right].has(groupId))) {
      throw new Error(`Internal split error: leakage group overlap between ${left} and ${right}.`);
    }
  }

  const splitArtifacts = Object.fromEntries(
    Object.entries(splitRows).map(([name, examples]) => {
      const ordered = examples.sort((left, right) => left.example_id.localeCompare(right.example_id));
      const path = join(datasetRoot, `${name}.jsonl`);
      const content = ordered.map((example) => JSON.stringify(example)).join("\n") + "\n";
      writePrivateText(path, content);
      return [name, {
        path,
        row_count: ordered.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      }];
    }),
  ) as CaptureClassificationDataset["splits"];
  const manifestPath = join(datasetRoot, "dataset-manifest.json");
  const retainedRowCount = [...groupsByLabel.values()].reduce(
    (total, groups) => total + [...groups.values()].reduce((count, examples) => count + examples.length, 0),
    0,
  );
  const dataset: CaptureClassificationDataset = {
    schema_version: "understudy.capture_import.classification_dataset.v2",
    dataset_id: datasetId,
    generated_at: now.toISOString(),
    source_path: source,
    source_sha256: sourceSha256,
    mapping_sha256: mappingSha256,
    local_only: true,
    network_required: false,
    mapping_confirmation: "caller-provided",
    source_rows_persisted_as_transformed_examples: true,
    source_row_count: sourceRowCount,
    duplicate_rows_removed: duplicateRowsRemoved,
    unusable_rows_removed: unusableRowsRemoved,
    row_count: retainedRowCount,
    mapping,
    labels,
    label_distribution: labels.map((value) => ({ value, count: labelCounts.get(value)! })),
    split_policy: {
      name: "deterministic-stratified-group-aware-v2",
      allocation: "per-label-deterministic-group-greedy-v1",
      group_key: groupColumn,
      group_normalization: "casefold-reference-stripping-v1",
      no_group_overlap: true,
      target_train_ratio: 0.7,
      target_dev_ratio: 0.15,
      target_holdout_ratio: 0.15,
      holdout_reserved_for_final_validation: true,
    },
    splits: splitArtifacts,
    artifact_root: datasetRoot,
    manifest_path: manifestPath,
  };
  writeJson(manifestPath, dataset);
  return dataset;
}

function readCsvForTraining(source: string): { bytes: Buffer; headers: string[]; rows: string[][] } {
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`Training dataset preparation requires one delimited text file: ${source}`);
  }
  return readDelimitedTable(source);
}

export function readCaptureDelimitedTable(sourceInput: string): { bytes: Buffer; headers: string[]; rows: string[][] } {
  return readDelimitedTable(resolve(sourceInput));
}

function readDelimitedTable(source: string): { bytes: Buffer; headers: string[]; rows: string[][] } {
  const bytes = readFileSync(source);
  if (bytes.length > MAX_CSV_BYTES) {
    throw new Error(`Table exceeds the ${MAX_CSV_BYTES}-byte local preparation limit.`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Table must be valid UTF-8 before local inspection.");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = detectTableDelimiter(source, text);
  const records = parseCsvRecordsBounded(text, delimiter).filter((record) =>
    record.some((field) => field.trim().length > 0),
  );
  if (records.length < 2) throw new Error("Table needs at least two non-empty rows.");
  const width = records[0].length;
  records.forEach((row, index) => {
    if (row.length !== width) {
      throw new Error(`Table record ${index + 1} has ${row.length} fields; expected ${width}.`);
    }
  });
  const sourceHeader = looksLikeHeaderRow(records);
  const headers = sourceHeader
    ? records[0].map((field) => field.trim())
    : inferredHeaders(records);
  const rows = sourceHeader ? records.slice(1) : records;
  return { bytes, headers, rows };
}

function detectTableDelimiter(source: string, text: string): "," | "\t" {
  const extension = extname(source).toLowerCase();
  if (extension === ".tsv" || extension === ".tab") return "\t";
  if (extension === ".csv") return ",";
  if (extension && extension !== ".txt") {
    throw new Error(`Local table inspection supports .csv, .tsv, .tab, .txt, or extensionless files: ${source}`);
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 20);
  if (lines.length < 2) throw new Error("Table needs at least two non-empty rows.");
  const tabCounts = lines.map((line) => (line.match(/\t/g) ?? []).length);
  if (tabCounts[0] > 0 && tabCounts.every((count) => count === tabCounts[0])) return "\t";
  const commaCounts = lines.map((line) => (line.match(/,/g) ?? []).length);
  if (commaCounts[0] > 0 && commaCounts.every((count) => count === commaCounts[0])) return ",";
  throw new Error("This file does not have a consistent comma or tab-delimited shape.");
}

function looksLikeHeaderRow(records: string[][]): boolean {
  const first = records[0].map((field) => field.trim());
  if (first.some((field) => !/^[\p{L}_][\p{L}\p{N}_ .-]{0,63}$/u.test(field))) return false;
  if (new Set(first.map(normalizeHeader)).size !== first.length) return false;
  return !first.some((field, column) =>
    records.slice(1, 21).some((row) => row[column]?.trim().toLowerCase() === field.toLowerCase()),
  );
}

function inferredHeaders(records: string[][]): string[] {
  if (records[0].length === 2) {
    const firstValues = records.map((row) => row[0].trim()).filter(Boolean);
    const secondValues = records.map((row) => row[1].trim()).filter(Boolean);
    const firstUnique = new Set(firstValues).size;
    const secondUnique = new Set(secondValues).size;
    if (
      firstUnique >= 2 &&
      firstUnique <= Math.min(100, Math.max(3, Math.floor(records.length / 4))) &&
      secondUnique > firstUnique
    ) {
      return ["label", "text"];
    }
  }
  return records[0].map((_, index) => `column_${index + 1}`);
}

function stableGroupRank(sourceSha256: string, label: string, groupId: string): string {
  return createHash("sha256")
    .update(`${sourceSha256}\0${label}\0${groupId}`)
    .digest("hex");
}

function normalizeClassificationGroup(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(?:ref(?:erence)?|txn|transaction|trace|confirmation|id)\s*[:#-]?\s*[a-z0-9-]{4,}\b/gi, " <reference> ")
    .replace(/\b[a-f0-9]{8,}\b/gi, " <identifier> ")
    .replace(/\b(?:rs|inr|usd|eur|gbp|cad|aud)?\s*\d+(?:[.,]\d+)?\b/gi, " <number> ")
    .replace(/[^a-z0-9<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCsvRecordsBounded(text: string, delimiter: "," | "\t" = ","): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;

  const append = (character: string) => {
    field += character;
    if (field.length > MAX_CSV_FIELD_CHARACTERS) {
      throw new Error(`CSV field exceeds ${MAX_CSV_FIELD_CHARACTERS} characters.`);
    }
  };
  const finishField = () => {
    row.push(field);
    field = "";
    afterQuote = false;
    if (row.length > MAX_CSV_COLUMNS) {
      throw new Error(`CSV has more than ${MAX_CSV_COLUMNS} columns.`);
    }
  };
  const finishRecord = () => {
    finishField();
    records.push(row);
    row = [];
    if (records.length > MAX_CSV_ROWS + 1) {
      throw new Error(`CSV has more than ${MAX_CSV_ROWS} data rows; split it before local inspection.`);
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          append('"');
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        append(character);
      }
      continue;
    }
    if (afterQuote) {
      if (character === delimiter) {
        finishField();
      } else if (character === "\n") {
        finishRecord();
      } else if (character === "\r") {
        if (text[index + 1] === "\n") continue;
        finishRecord();
      } else if (character !== " " && character !== "\t") {
        throw new Error("CSV contains characters after a closing quote.");
      }
      continue;
    }
    if (character === '"' && field.length === 0 && delimiter === ",") {
      quoted = true;
    } else if (character === '"') {
      if (delimiter === ",") throw new Error("CSV contains a quote inside an unquoted field.");
      append(character);
    } else if (character === delimiter) {
      finishField();
    } else if (character === "\n") {
      finishRecord();
    } else if (character === "\r" && text[index + 1] === "\n") {
      continue;
    } else if (character === "\r") {
      finishRecord();
    } else {
      append(character);
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  if (field.length > 0 || row.length > 0 || afterQuote) finishRecord();
  return records;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function chooseLabelColumn(
  headers: string[],
  columns: CaptureCsvColumnSummary[],
): { name: string; confidence: "high" | "low" } | null {
  const preferred = ["label", "target", "category", "class", "intent", "type", "status"];
  for (const name of preferred) {
    const index = headers.findIndex((header) => normalizeHeader(header) === name);
    if (index >= 0) return { name: headers[index], confidence: "high" };
  }
  const plausible = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.unique_count >= 2 && column.unique_count <= 100 && column.unique_ratio <= 0.5)
    .sort((left, right) => left.column.unique_count - right.column.unique_count || right.index - left.index);
  return plausible[0]
    ? { name: plausible[0].column.name, confidence: "low" }
    : null;
}

function chooseGroupColumn(
  headers: string[],
  columns: CaptureCsvColumnSummary[],
  labelIndex: number,
): string | null {
  const preferred = [
    "merchant",
    "vendor",
    "payee",
    "counterparty",
    "description",
    "transaction_narration",
    "narration",
    "memo",
    "title",
    "text",
    "input",
  ];
  for (const name of preferred) {
    const index = headers.findIndex((header) => normalizeHeader(header) === name);
    if (index >= 0 && index !== labelIndex && columns[index].non_empty_count > 0) return headers[index];
  }
  const fallback = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column, index }) =>
      index !== labelIndex && column.non_empty_count > 0 && column.numeric_ratio < 0.5,
    )
    .sort((left, right) =>
      right.column.non_empty_count - left.column.non_empty_count || left.index - right.index,
    )[0];
  return fallback ? headers[fallback.index] : null;
}

function isFiniteNumber(value: string): boolean {
  if (value.trim() === "") return false;
  return Number.isFinite(Number(value.replace(/[$,\s]/g, "")));
}

function isDateLike(value: string): boolean {
  if (!/\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function normalizedHistogram(values: number[], bins: number): number[] {
  if (values.length === 0) return Array.from({ length: bins }, () => 0);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const counts = Array.from({ length: bins }, () => 0);
  for (const value of values) {
    const index = high === low
      ? 0
      : Math.min(bins - 1, Math.floor(((value - low) / (high - low)) * bins));
    counts[index] += 1;
  }
  const maximum = Math.max(...counts, 1);
  return counts.map((count) => Number((count / maximum).toFixed(6)));
}

function profileBars(
  values: string[],
  kind: CaptureCsvColumnSummary["profile_kind"],
): number[] {
  if (kind === "number") {
    return normalizedHistogram(
      values.filter(isFiniteNumber).map((value) => Number(value.replace(/[$,\s]/g, ""))),
      12,
    );
  }
  if (kind === "date") {
    return normalizedHistogram(values.filter(isDateLike).map((value) => Date.parse(value)), 12);
  }
  if (kind === "category") {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    const topCounts = [...counts.values()].sort((left, right) => right - left).slice(0, 6);
    if (topCounts.length === 0) return [0];
    const maximum = Math.max(...topCounts, 1);
    return topCounts.map((count) => Number((count / maximum).toFixed(6)));
  }
  return normalizedHistogram(values.map((value) => value.length), 12);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function artifactReference(repo: string, path: string): string {
  const repoRelative = relative(repo, path);
  if (repoRelative === ".." || repoRelative.startsWith("../") || repoRelative.startsWith("..\\")) {
    return path;
  }
  return repoRelative;
}

function collectSources(
  repo: string,
  inputSource: string,
  includeUnknownFiles: boolean,
): { sources: CaptureSource[]; scannedFileCount: number; truncated: boolean } {
  const walked = walkBounded(inputSource, MAX_SCAN_FILES);
  const files = walked.files
    .map((path) => ({ absolutePath: path, relativePath: relative(repo, path) }))
    .filter(({ relativePath }) =>
      relativePath !== ".." &&
      !relativePath.startsWith("../") &&
      !relativePath.startsWith("..\\"))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const sources: CaptureSource[] = [];
  let sourceLimitReached = false;
  for (const file of files) {
    const detection = detectKind(file.relativePath) ??
      (includeUnknownFiles ? { kind: "local-file" as const, evidence: ["explicit:path-drop"] } : null);
    if (!detection) {
      continue;
    }
    if (sources.length >= MAX_CAPTURE_SOURCES) {
      sourceLimitReached = true;
      continue;
    }
    const stat = statSync(file.absolutePath);
    sources.push({
      id: `source-${String(sources.length + 1).padStart(3, "0")}`,
      path: file.relativePath,
      kind: detection.kind,
      bytes: stat.size,
      extension: extname(file.relativePath).toLowerCase(),
      evidence: detection.evidence,
    });
  }
  return {
    sources,
    scannedFileCount: files.length,
    truncated: walked.truncated || sourceLimitReached,
  };
}

function detectKind(path: string): { kind: CaptureSourceKind; evidence: string[] } | null {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const name = basename(normalized);
  const ext = extname(normalized);
  if (ext === ".jsonl") {
    return { kind: "jsonl-data", evidence: ["extension:.jsonl"] };
  }
  if (ext === ".csv") {
    return { kind: "csv-data", evidence: ["extension:.csv"] };
  }
  if (name.includes("golden") || normalized.includes("/golden")) {
    return { kind: "golden-fixture", evidence: ["path:golden"] };
  }
  if (name.includes("eval") || normalized.includes("/eval") || normalized.includes("/fixtures/")) {
    return { kind: "eval-fixture", evidence: ["path:eval-or-fixture"] };
  }
  if ([".prompt", ".prompty", ".md"].includes(ext) && /prompt|system|instruction/.test(name)) {
    return { kind: "prompt-file", evidence: ["path:prompt", `extension:${ext}`] };
  }
  if (/app\/.*\/(page|route)\.(ts|tsx|js|jsx)$/.test(normalized) || /routes?\/.*\.(ts|tsx|js|jsx)$/.test(normalized)) {
    return { kind: "app-route", evidence: ["path:app-route"] };
  }
  if (/trace|span|otel|openai|anthropic|provider/.test(normalized) && [".json", ".jsonl", ".ndjson"].includes(ext)) {
    return { kind: "provider-trace", evidence: ["path:trace-or-provider"] };
  }
  if ([".pdf", ".doc", ".docx", ".rtf", ".txt", ".md", ".markdown"].includes(ext)) {
    return { kind: "document", evidence: [`extension:${ext}`] };
  }
  if ([".xlsx", ".xls", ".ods", ".tsv"].includes(ext)) {
    return { kind: "spreadsheet", evidence: [`extension:${ext}`] };
  }
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".kt", ".swift", ".rb", ".php", ".c", ".cc", ".cpp", ".h", ".hpp"].includes(ext)) {
    return { kind: "source-file", evidence: [`extension:${ext}`] };
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".wav", ".mp3", ".m4a", ".mp4", ".mov"].includes(ext)) {
    return { kind: "media-file", evidence: [`extension:${ext}`] };
  }
  return null;
}

function walkBounded(root: string, maxFiles: number): { files: string[]; truncated: boolean } {
  if (!existsSync(root)) {
    throw new Error(`Capture/import source does not exist: ${root}`);
  }
  const rootStat = statSync(root);
  if (rootStat.isFile()) {
    return { files: [root], truncated: false };
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Capture/import source must be a file or directory: ${root}`);
  }
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    const childDirectories: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          childDirectories.push(join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (files.length >= maxFiles) {
        return { files, truncated: true };
      }
      files.push(join(directory, entry.name));
    }
    for (const child of childDirectories.reverse()) {
      pending.push(child);
    }
  }
  return { files, truncated: false };
}

function writeJson(path: string, payload: unknown): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  setPrivateMode(path, 0o600);
}

function writePrivateText(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  setPrivateMode(path, 0o600);
}

function setPrivateMode(path: string, mode: number): void {
  if (process.platform === "win32") return;
  chmodSync(path, mode);
}
