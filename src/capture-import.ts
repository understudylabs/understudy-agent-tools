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
  generated_at: string;
  repo: string;
  source_count: number;
  source_kinds: Record<CaptureSourceKind, number>;
  recommended_next_steps: string[];
  evidence_paths: string[];
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
    generated_at: now.toISOString(),
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
