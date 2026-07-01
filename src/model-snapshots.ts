import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type SnapshotModelInfo = {
  sessionUrl: string;
  destName: string;
  name: string;
  approxGb: number | null;
  loader: string | null;
  defaultRung?: boolean;
  notes?: string;
};

export type SnapshotPullOptions = {
  modelId: string;
  dest?: string;
  sessionUrl?: string;
  logDir?: string;
  dryRun?: boolean;
  onLog?: (message: string) => void;
};

export type SnapshotPullResult = {
  model: string;
  dest: string;
  sessionUrl: string;
  logFile: string;
  files: number;
  dryRun?: boolean;
};

type SessionFile = {
  name?: string;
  path?: string;
  url?: string;
  size_bytes?: number;
  size?: number;
  sha256?: string;
};

type SessionManifest = {
  files?: SessionFile[];
};

type FileRow = {
  name: string;
  url: string;
  size: number | null;
  sha256: string | null;
};

type DownloadResult = {
  name: string;
  bytes: number;
  cached: boolean;
};

export const DEFAULT_MODELS_DIR = join(homedir(), ".understudy", "models");
export const DEFAULT_MODEL_LOG_DIR = join(homedir(), ".understudy", "agent-tools", "logs");

export const VERIFIED_SNAPSHOT_MODELS: Record<string, SnapshotModelInfo> = {
  "gemma-4-e2b-it-qat-mlx-vlm-understudy": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-e2b-it-qat-mlx-vlm-understudy&ttl=21600",
    destName: "gemma-4-e2b-it-qat-mlx-vlm-understudy",
    name: "Gemma 4 E2B IT QAT -> MLX 4-bit (group_size=32), Understudy",
    approxGb: 3.6,
    loader: "mlx_vlm",
    defaultRung: true,
    notes:
      "Default onboarding rung. QAT-derived 4-bit at group_size=32. Certified generation, OpenAI-compatible serving, logprobs+top_logprobs, and tool_calls at the prescribed decode.",
  },
  "gemma-4-26b-a4b-it-qat-mlx-vlm-understudy": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-26b-a4b-it-qat-mlx-vlm-understudy&ttl=21600",
    destName: "gemma-4-26b-a4b-it-qat-mlx-vlm-understudy",
    name: "Gemma 4 26B A4B IT QAT -> MLX 4-bit (group_size=32 + 8-bit routers), Understudy",
    approxGb: 16,
    loader: "mlx_vlm",
  },
};

export function snapshotModelIds(): string[] {
  return Object.keys(VERIFIED_SNAPSHOT_MODELS);
}

export function resolveSnapshotPlan(options: SnapshotPullOptions): SnapshotPullResult {
  const modelInfo = modelInfoFor(options.modelId, options.sessionUrl);
  const dest = options.dest ?? join(DEFAULT_MODELS_DIR, modelInfo.destName);
  const logDir = options.logDir ?? DEFAULT_MODEL_LOG_DIR;
  const logFile = join(logDir, `model-pull-${modelInfo.destName}-${nowCompact()}.log`);
  return {
    model: options.modelId,
    dest,
    sessionUrl: options.sessionUrl ?? modelInfo.sessionUrl,
    logFile,
    files: 0,
    dryRun: true,
  };
}

export async function pullSnapshotModel(options: SnapshotPullOptions): Promise<SnapshotPullResult> {
  const modelInfo = modelInfoFor(options.modelId, options.sessionUrl);
  const dest = options.dest ?? join(DEFAULT_MODELS_DIR, modelInfo.destName);
  const logDir = options.logDir ?? DEFAULT_MODEL_LOG_DIR;
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `model-pull-${modelInfo.destName}-${nowCompact()}.log`);
  const sessionUrl = options.sessionUrl ?? modelInfo.sessionUrl;
  const log = (message: string) => logLine(logFile, message, options.onLog);

  log(`model=${options.modelId}`);
  log(`name=${modelInfo.name}`);
  log(`session=${sessionUrl}`);
  log(`dest=${dest}`);
  if (modelInfo.approxGb) log(`approx_gb=${modelInfo.approxGb}`);

  if (options.dryRun) {
    log("dry_run=true");
    return { model: options.modelId, dest, sessionUrl, logFile, files: 0, dryRun: true };
  }

  mkdirSync(dest, { recursive: true });
  const incompletePath = join(dest, ".understudy-snapshot.incomplete");
  writeFileSync(
    incompletePath,
    `${JSON.stringify({ model_id: options.modelId, started_at: new Date().toISOString(), logFile }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const manifest = await fetchJson(sessionUrl);
  const rows = orderedRows(fileRows(manifest));
  const results: DownloadResult[] = [];
  try {
    for (const row of rows) {
      if (!row.name || !row.url) {
        throw new Error("manifest file entries must include name/path and url");
      }
      results.push(await downloadFile({ row, target: safeTarget(dest, row.name), log }));
    }
    await verifySha256Sums(dest, log);
  } catch (error) {
    log(`incomplete error=${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }

  const metadata = {
    schema_version: "understudy.model_snapshot.v1",
    model_id: options.modelId,
    name: modelInfo.name,
    loader: modelInfo.loader,
    session_url: sessionUrl,
    pulled_at: new Date().toISOString(),
    destination: dest,
    files: results,
  };
  writeFileSync(join(dest, ".understudy-snapshot.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  rmSync(incompletePath, { force: true });
  log(`complete files=${results.length} dest=${dest}`);
  return { model: options.modelId, dest, sessionUrl, logFile, files: results.length };
}

function modelInfoFor(modelId: string, sessionUrl?: string): SnapshotModelInfo {
  const model = VERIFIED_SNAPSHOT_MODELS[modelId];
  if (model) return model;
  if (!sessionUrl) {
    throw new Error(`unknown verified snapshot model id: ${modelId}`);
  }
  return {
    sessionUrl,
    destName: modelId,
    name: modelId,
    approxGb: null,
    loader: null,
  };
}

function nowCompact(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.ceil(seconds / 3600)}h`;
}

function logLine(logFile: string, message: string, onLog?: (message: string) => void): void {
  const line = `${new Date().toISOString()} ${message}`;
  onLog?.(line);
  writeFileSync(logFile, `${line}\n`, { flag: "a", mode: 0o600 });
}

async function getContentLength(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) return null;
    const value = response.headers.get("content-length");
    return value ? Number(value) : null;
  } catch {
    return null;
  }
}

async function fetchJson(url: string): Promise<SessionManifest> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`session request failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<SessionManifest>;
}

function fileRows(manifest: SessionManifest): FileRow[] {
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error("session manifest must include files[]");
  }
  return manifest.files.map((file) => ({
    name: file.name || file.path || "",
    url: file.url || "",
    size: Number(file.size_bytes ?? file.size ?? 0) || null,
    sha256: file.sha256 || null,
  }));
}

function orderedRows(rows: FileRow[]): FileRow[] {
  return [...rows].sort((a, b) => {
    const aLarge = /\.safetensors$/i.test(a.name) ? 1 : 0;
    const bLarge = /\.safetensors$/i.test(b.name) ? 1 : 0;
    if (aLarge !== bLarge) return aLarge - bLarge;
    return a.name.localeCompare(b.name);
  });
}

function safeTarget(dest: string, name: string): string {
  if (isAbsolute(name)) {
    throw new Error(`manifest file path must be relative: ${name}`);
  }
  const root = resolve(dest);
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`manifest file path escapes destination: ${name}`);
  }
  return target;
}

async function downloadFile({ row, target, log }: { row: FileRow; target: string; log: (message: string) => void }): Promise<DownloadResult> {
  mkdirSync(dirname(target), { recursive: true });
  let expectedSize = row.size || (await getContentLength(row.url));
  if (existsSync(target) && expectedSize && statSync(target).size === expectedSize) {
    log(`cached ${row.name} (${expectedSize} bytes)`);
    return { name: row.name, bytes: expectedSize, cached: true };
  }
  if (existsSync(target) && !expectedSize && statSync(target).size > 0) {
    log(`cached ${row.name}`);
    return { name: row.name, bytes: statSync(target).size, cached: true };
  }

  const partial = `${target}.part`;
  rmSync(partial, { force: true });
  log(`downloading ${row.name}${expectedSize ? ` (${expectedSize} bytes)` : ""}`);
  const response = await fetch(row.url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed for ${row.name}: ${response.status} ${response.statusText}`);
  }
  expectedSize ||= Number(response.headers.get("content-length")) || null;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let downloaded = 0;
  const hash = row.sha256 ? createHash("sha256") : null;
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloaded += chunk.length;
      if (hash) hash.update(chunk);
      const now = Date.now();
      if (now - lastProgressAt > 5000 || (expectedSize && downloaded === expectedSize)) {
        const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
        const bytesPerSecond = downloaded / elapsedSeconds;
        const remainingSeconds = expectedSize ? (expectedSize - downloaded) / bytesPerSecond : NaN;
        const total = expectedSize ? `/${formatBytes(expectedSize)}` : "";
        const eta = expectedSize ? ` eta=${formatEta(remainingSeconds)}` : "";
        log(`progress ${row.name} ${formatBytes(downloaded)}${total} rate=${formatBytes(bytesPerSecond)}/s${eta}`);
        lastProgressAt = now;
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), progress, createWriteStream(partial, { mode: 0o600 }));
  const actualSize = statSync(partial).size;
  if (expectedSize && actualSize !== expectedSize) {
    rmSync(partial, { force: true });
    throw new Error(`size mismatch for ${row.name}: got ${actualSize}, expected ${expectedSize}`);
  }
  if (hash) {
    const actualSha = hash.digest("hex");
    if (actualSha !== row.sha256) {
      rmSync(partial, { force: true });
      throw new Error(`sha256 mismatch for ${row.name}: got ${actualSha}, expected ${row.sha256}`);
    }
  }
  renameSync(partial, target);
  return { name: row.name, bytes: actualSize, cached: false };
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  }));
  return hash.digest("hex");
}

async function verifySha256Sums(dest: string, log: (message: string) => void): Promise<string[] | null> {
  const sumsPath = join(dest, "SHA256SUMS");
  if (!existsSync(sumsPath)) return null;
  const lines = readFileSync(sumsPath, "utf8").split(/\r?\n/).filter(Boolean);
  const verified: string[] = [];
  for (const line of lines) {
    const match = /^([a-fA-F0-9]{64})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const [, expected, rawPath] = match;
    const name = rawPath.replace(/^\*/, "").replace(/^\.\//, "");
    const target = safeTarget(dest, name);
    if (!existsSync(target)) {
      throw new Error(`SHA256SUMS references missing file: ${name}`);
    }
    const actual = await fileSha256(target);
    if (actual !== expected.toLowerCase()) {
      throw new Error(`sha256 mismatch for ${name}: got ${actual}, expected ${expected}`);
    }
    verified.push(name);
  }
  log(`sha256sums_verified files=${verified.length}`);
  return verified;
}
