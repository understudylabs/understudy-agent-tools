import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

export type CaptureSourceKind =
  | "eval-fixture"
  | "golden-fixture"
  | "jsonl-data"
  | "csv-data"
  | "prompt-file"
  | "app-route"
  | "provider-trace";

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
  source_count: number;
  sources: CaptureSource[];
  redaction_manifest_path: string;
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
    generated_from: "understudy-tools capture-import scan";
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
];

export function artifactDir(repo: string): string {
  return join(repo, ".understudy", "capture-import");
}

export function scanCaptureImport(repoInput: string, now = new Date()): CaptureScanManifest {
  const repo = resolve(repoInput);
  const sources = collectSources(repo);
  const generated_at = now.toISOString();
  const outputDir = artifactDir(repo);
  mkdirSync(outputDir, { recursive: true });

  const redactionManifest: RedactionManifest = {
    generated_at,
    repo,
    policy: "metadata-only",
    rules: [
      "Record paths, file sizes, extensions, and detection evidence only.",
      "Do not read or persist prompts, completions, traces, examples, customer data, or secrets.",
      "Keep artifacts local under .understudy/capture-import.",
    ],
    source_count: sources.length,
    payload_fields_omitted: ["contents", "prompt", "completion", "messages", "input", "output", "trace"],
  };

  const redactionPath = join(outputDir, "redaction-manifest.json");
  writeJson(redactionPath, redactionManifest);

  const manifest: CaptureScanManifest = {
    generated_at,
    repo,
    source_count: sources.length,
    sources,
    redaction_manifest_path: relative(repo, redactionPath),
  };
  writeJson(join(outputDir, "capture-sources.json"), manifest);
  return manifest;
}

export function readCaptureManifest(repoInput: string): CaptureScanManifest {
  const repo = resolve(repoInput);
  const manifestPath = join(artifactDir(repo), "capture-sources.json");
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

export function buildWorkloadCard(repoInput: string, now = new Date()): WorkloadCard {
  const repo = resolve(repoInput);
  const manifest = readCaptureManifest(repo);
  const source_kinds = Object.fromEntries(kindOrder.map((kind) => [kind, 0])) as Record<CaptureSourceKind, number>;
  for (const source of manifest.sources) {
    source_kinds[source.kind] += 1;
  }
  const card: WorkloadCard = {
    schema_version: "understudy.workload_card.v1",
    workload_id: "capture-import",
    workload_name: null,
    owner: null,
    candidate_id: "metadata-discovery",
    source_path: null,
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
      generated_from: "understudy-tools capture-import scan",
      repo,
      source_count: manifest.source_count,
      source_kinds,
      recommended_next_steps: [
        "Confirm which metadata-only sources belong to the workload.",
        "Create or update the capture-evidence harness, metric, splits, and baseline artifacts.",
        "Run optimize-workload only after the workload contract is hash-bound.",
      ],
      evidence_paths: [
        ".understudy/capture-import/capture-sources.json",
        ".understudy/capture-import/redaction-manifest.json",
      ],
      capture_sources: ".understudy/capture-import/capture-sources.json",
      redaction_manifest: ".understudy/capture-import/redaction-manifest.json",
    },
  };
  writeJson(join(artifactDir(repo), "workload-card.json"), card);
  return card;
}

function collectSources(repo: string): CaptureSource[] {
  const files = walk(repo)
    .map((path) => ({ absolutePath: path, relativePath: relative(repo, path) }))
    .filter(({ relativePath }) => !relativePath.startsWith(".."))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const sources: CaptureSource[] = [];
  for (const file of files) {
    const detection = detectKind(file.relativePath);
    if (!detection) {
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
  return sources;
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
  return null;
}

function walk(root: string): string[] {
  if (!existsSync(root)) {
    throw new Error(`Repository path does not exist: ${root}`);
  }
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        files.push(...walk(join(root, entry.name)));
      }
      continue;
    }
    if (entry.isFile()) {
      files.push(join(root, entry.name));
    }
  }
  return files;
}

function writeJson(path: string, payload: unknown): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
