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
    privacy_boundary: "local-only until explicit approval";
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
      privacy_boundary: "local-only until explicit approval",
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
      "reading source, prompts, traces, eval rows, or customer data",
      "running live model calls",
      "downloading local models",
      "submitting hosted benchmarks or training jobs",
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

function setPrivateMode(path: string, mode: number): void {
  if (process.platform === "win32") return;
  chmodSync(path, mode);
}
