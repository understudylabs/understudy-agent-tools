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
  shortName?: string;
  certified?: boolean;
  family?: string;
  tier?: string;
  quant?: string;
  fileCount?: number;
};

export type SnapshotCatalogSource = "live" | "fallback";

export type SnapshotCatalog = {
  models: Record<string, SnapshotModelInfo>;
  source: SnapshotCatalogSource;
  url: string;
};

export type SnapshotPullOptions = {
  modelId: string;
  dest?: string;
  sessionUrl?: string;
  logDir?: string;
  dryRun?: boolean;
  onLog?: (message: string) => void;
  /** Resolved model catalog (live or fallback). Defaults to the bundled table. */
  catalog?: Record<string, SnapshotModelInfo>;
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
  /** True when the file's sha256 was verified against the manifest or SHA256SUMS this run. */
  verified?: boolean;
};

// Shared model-cache convention (same semantics as skills/ladder/serve.py and
// the desktop app): UNDERSTUDY_MODEL_HOME overrides, else ~/.understudy/models.
export const DEFAULT_MODELS_DIR =
  process.env.UNDERSTUDY_MODEL_HOME && process.env.UNDERSTUDY_MODEL_HOME.trim() !== ""
    ? process.env.UNDERSTUDY_MODEL_HOME
    : join(homedir(), ".understudy", "models");
export const DEFAULT_MODEL_LOG_DIR = join(homedir(), ".understudy", "agent-tools", "logs");

export const DEFAULT_CATALOG_URL = "https://models.understudylabs.com/catalog";
export const CATALOG_SCHEMA_VERSION = "understudy.model_catalog.v1";
const CATALOG_TIMEOUT_MS = 5000;

// Offline fallback table. Kept in sync with the set of snapshots that are
// actually pullable from models.understudylabs.com (verified against R2
// 2026-07-01). The live /catalog endpoint supersedes this when reachable.
export const VERIFIED_SNAPSHOT_MODELS: Record<string, SnapshotModelInfo> = {
  "gemma-4-e2b-it-qat-mlx-vlm-understudy": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-e2b-it-qat-mlx-vlm-understudy&ttl=21600",
    destName: "gemma-4-e2b-it-qat-mlx-vlm-understudy",
    name: "Gemma 4 E2B IT QAT -> MLX 4-bit (group_size=32), Understudy",
    approxGb: 3.6,
    loader: "mlx_vlm",
    defaultRung: true,
    shortName: "understudy-small",
    certified: true,
    family: "gemma-4",
    tier: "e2b",
    quant: "qat-4bit-g32",
    notes:
      "Default onboarding rung. QAT-derived 4-bit at group_size=32. Certified generation, OpenAI-compatible serving, logprobs+top_logprobs, and tool_calls at the prescribed decode.",
  },
  "gemma-4-e2b-it-mlx-vlm-4bit": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-4bit&ttl=21600",
    destName: "gemma-4-e2b-it-mlx-vlm-4bit",
    name: "Gemma 4 E2B IT MLX-VLM 4-bit",
    approxGb: 3.3,
    loader: "mlx_vlm",
    certified: false,
    family: "gemma-4",
    tier: "e2b",
    quant: "4bit",
    notes:
      "Vanilla non-QAT bf16 -> MLX 4-bit. Diagnostic rung for isolating quantization artifacts against the QAT default.",
  },
  "gemma-4-e4b-it-mlx-vlm-4bit": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-e4b-it-mlx-vlm-4bit&ttl=21600",
    destName: "gemma-4-e4b-it-mlx-vlm-4bit",
    name: "Gemma 4 E4B IT MLX-VLM 4-bit",
    approxGb: 4.8,
    loader: "mlx_vlm",
    certified: false,
    family: "gemma-4",
    tier: "e4b",
    quant: "4bit",
  },
  "gemma-4-12b-it-mlx-vlm-4bit": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-12b-it-mlx-vlm-4bit&ttl=21600",
    destName: "gemma-4-12b-it-mlx-vlm-4bit",
    name: "Gemma 4 12B IT MLX-VLM 4-bit",
    approxGb: 6.3,
    loader: "mlx_vlm",
    certified: false,
    family: "gemma-4",
    tier: "12b",
    quant: "4bit",
  },
  "gemma-4-12b-it-mlx-vlm-bf16": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-12b-it-mlx-vlm-bf16&ttl=21600",
    destName: "gemma-4-12b-it-mlx-vlm-bf16",
    name: "Gemma 4 12B IT MLX-VLM BF16",
    approxGb: 22,
    loader: "mlx_vlm",
    certified: false,
    family: "gemma-4",
    tier: "12b",
    quant: "bf16",
  },
  "gemma-4-26b-a4b-it-mlx-vlm-bf16": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-26b-a4b-it-mlx-vlm-bf16&ttl=21600",
    destName: "gemma-4-26b-a4b-it-mlx-vlm-bf16",
    name: "Gemma 4 26B A4B IT MLX-VLM BF16",
    approxGb: 52,
    loader: "mlx_vlm",
    certified: false,
    family: "gemma-4",
    tier: "26b-a4b",
    quant: "bf16",
  },
  "gemma-4-26b-a4b-it-qat-mlx-vlm-understudy": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-26b-a4b-it-qat-mlx-vlm-understudy&ttl=21600",
    destName: "gemma-4-26b-a4b-it-qat-mlx-vlm-understudy",
    name: "Gemma 4 26B A4B IT QAT -> MLX 4-bit (group_size=32 + 8-bit routers), Understudy",
    approxGb: 16,
    loader: "mlx_vlm",
    shortName: "understudy-fast",
    certified: true,
    family: "gemma-4",
    tier: "26b-a4b",
    quant: "qat-4bit-g32",
  },
  "gemma-4-31b-it-mlx-vlm-bf16": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-31b-it-mlx-vlm-bf16&ttl=21600",
    destName: "gemma-4-31b-it-mlx-vlm-bf16",
    name: "Gemma 4 31B IT MLX-VLM BF16",
    approxGb: 62,
    loader: "mlx_vlm",
    certified: false,
    family: "gemma-4",
    tier: "31b",
    quant: "bf16",
  },
  "diffusiongemma-26b-a4b-it-mlx-vlm-4bit": {
    sessionUrl: "https://models.understudylabs.com/session?model=diffusiongemma-26b-a4b-it-mlx-vlm-4bit&ttl=21600",
    destName: "diffusiongemma-26b-a4b-it-mlx-vlm-4bit",
    name: "DiffusionGemma 26B A4B IT MLX-VLM 4-bit",
    approxGb: 16,
    loader: "mlx_vlm",
    certified: false,
    family: "diffusiongemma",
    tier: "26b-a4b",
    quant: "4bit",
  },
  "diffusiongemma-26b-a4b-it-mlx-vlm-bf16": {
    sessionUrl: "https://models.understudylabs.com/session?model=diffusiongemma-26b-a4b-it-mlx-vlm-bf16&ttl=21600",
    destName: "diffusiongemma-26b-a4b-it-mlx-vlm-bf16",
    name: "DiffusionGemma 26B A4B IT MLX-VLM BF16",
    approxGb: 52,
    loader: "mlx_vlm",
    certified: false,
    family: "diffusiongemma",
    tier: "26b-a4b",
    quant: "bf16",
  },
};

export function snapshotModelIds(): string[] {
  return Object.keys(VERIFIED_SNAPSHOT_MODELS);
}

export function catalogUrl(): string {
  const override = process.env.UNDERSTUDY_CATALOG_URL;
  if (override && override.trim() !== "") return override;
  return DEFAULT_CATALOG_URL;
}

type CatalogRow = {
  id?: unknown;
  name?: unknown;
  approx_gb?: unknown;
  loader?: unknown;
  default_rung?: unknown;
  short_name?: unknown;
  certified?: unknown;
  family?: unknown;
  tier?: unknown;
  quant?: unknown;
  session_url?: unknown;
  file_count?: unknown;
  notes?: unknown;
};

function catalogRowToModelInfo(row: CatalogRow): SnapshotModelInfo | null {
  if (typeof row?.id !== "string" || row.id.trim() === "") return null;
  const id = row.id;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value : undefined;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return {
    sessionUrl:
      str(row.session_url) ?? `https://models.understudylabs.com/session?model=${encodeURIComponent(id)}&ttl=21600`,
    destName: id,
    name: str(row.name) ?? id,
    approxGb: num(row.approx_gb) ?? null,
    loader: str(row.loader) ?? null,
    ...(row.default_rung === true ? { defaultRung: true } : {}),
    ...(str(row.short_name) ? { shortName: str(row.short_name) } : {}),
    ...(typeof row.certified === "boolean" ? { certified: row.certified } : {}),
    ...(str(row.family) ? { family: str(row.family) } : {}),
    ...(str(row.tier) ? { tier: str(row.tier) } : {}),
    ...(str(row.quant) ? { quant: str(row.quant) } : {}),
    ...(num(row.file_count) !== undefined ? { fileCount: num(row.file_count) } : {}),
    ...(str(row.notes) ? { notes: str(row.notes) } : {}),
  };
}

/**
 * Fetch the model catalog from the snapshot service and convert it to the
 * same shape as VERIFIED_SNAPSHOT_MODELS. Degrades silently to the bundled
 * fallback table on any fetch error, non-200 status, timeout, or
 * schema_version mismatch — a catalog fetch must never block or fail a
 * command that can proceed on the fallback.
 */
export async function fetchSnapshotCatalog(options?: { timeoutMs?: number }): Promise<SnapshotCatalog> {
  const url = catalogUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? CATALOG_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`catalog request failed: ${response.status}`);
    const body = (await response.json()) as { schema_version?: unknown; models?: unknown };
    if (body?.schema_version !== CATALOG_SCHEMA_VERSION || !Array.isArray(body.models)) {
      throw new Error("catalog schema mismatch");
    }
    const models: Record<string, SnapshotModelInfo> = {};
    for (const row of body.models as CatalogRow[]) {
      const info = catalogRowToModelInfo(row);
      if (info) models[row.id as string] = info;
    }
    if (Object.keys(models).length === 0) throw new Error("catalog listed no models");
    return { models, source: "live", url };
  } catch {
    return { models: VERIFIED_SNAPSHOT_MODELS, source: "fallback", url };
  } finally {
    clearTimeout(timer);
  }
}

export function resolveSnapshotPlan(options: SnapshotPullOptions): SnapshotPullResult {
  const modelInfo = modelInfoFor(options.modelId, options.sessionUrl, options.catalog);
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
  const modelInfo = modelInfoFor(options.modelId, options.sessionUrl, options.catalog);
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
    }
    // Download SHA256SUMS first and never treat an existing copy as cached: a
    // stale sums file left by a previous snapshot in the same dest would
    // validate the wrong weights. The session manifest carries no file sizes,
    // so the fresh sums file is the only way to tell a cached file of the
    // right name from a leftover of a different model.
    const sumsRow = rows.find((row) => normalizeSumsName(row.name) === "SHA256SUMS");
    let sums: Map<string, string> | null = null;
    const verifiedNames = new Set<string>();
    if (sumsRow) {
      results.push(await downloadFile({ row: sumsRow, target: safeTarget(dest, sumsRow.name), log, neverCache: true }));
      sums = parseSha256Sums(readFileSync(safeTarget(dest, sumsRow.name), "utf8"));
    } else {
      log("warning: snapshot has no SHA256SUMS; cached files cannot be verified");
    }
    for (const row of rows) {
      if (row === sumsRow) continue;
      const expectedSha = sums?.get(normalizeSumsName(row.name)) ?? row.sha256 ?? null;
      const result = await downloadFile({
        row: { ...row, sha256: expectedSha },
        target: safeTarget(dest, row.name),
        log,
      });
      if (result.verified) verifiedNames.add(normalizeSumsName(row.name));
      results.push(result);
    }
    await verifySha256Sums(dest, log, verifiedNames);
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

function modelInfoFor(
  modelId: string,
  sessionUrl?: string,
  catalog?: Record<string, SnapshotModelInfo>,
): SnapshotModelInfo {
  const model = catalog?.[modelId] ?? VERIFIED_SNAPSHOT_MODELS[modelId];
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

async function downloadFile({
  row,
  target,
  log,
  neverCache,
}: {
  row: FileRow;
  target: string;
  log: (message: string) => void;
  neverCache?: boolean;
}): Promise<DownloadResult> {
  mkdirSync(dirname(target), { recursive: true });
  let expectedSize = row.size || (await getContentLength(row.url));
  const sizeLooksCached = !neverCache
    && existsSync(target)
    && (expectedSize ? statSync(target).size === expectedSize : statSync(target).size > 0);
  if (sizeLooksCached) {
    // A name+size match alone can hide a leftover file from a different
    // snapshot pulled into the same dest. When we know the expected hash,
    // stream-verify the cached file and fall through to a re-download on
    // mismatch; when we don't, keep it but say so.
    const bytes = statSync(target).size;
    if (row.sha256) {
      log(`verifying cached ${row.name}`);
      const actualSha = await fileSha256(target);
      if (actualSha === row.sha256.toLowerCase()) {
        log(`cached ${row.name} (sha256 verified)`);
        return { name: row.name, bytes, cached: true, verified: true };
      }
      log(`cached ${row.name} sha256 mismatch; re-downloading`);
    } else {
      log(`warning: cached ${row.name} kept without sha256 verification (no hash available)`);
      return { name: row.name, bytes, cached: true };
    }
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
    if (actualSha !== row.sha256?.toLowerCase()) {
      rmSync(partial, { force: true });
      throw new Error(`sha256 mismatch for ${row.name}: got ${actualSha}, expected ${row.sha256}`);
    }
  }
  renameSync(partial, target);
  return { name: row.name, bytes: actualSize, cached: false, ...(hash ? { verified: true } : {}) };
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

function normalizeSumsName(name: string): string {
  return name.replace(/^\*/, "").replace(/^\.\//, "");
}

function parseSha256Sums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    map.set(normalizeSumsName(match[2]!), match[1]!.toLowerCase());
  }
  return map;
}

async function verifySha256Sums(
  dest: string,
  log: (message: string) => void,
  alreadyVerified?: Set<string>,
): Promise<string[] | null> {
  const sumsPath = join(dest, "SHA256SUMS");
  if (!existsSync(sumsPath)) return null;
  const lines = readFileSync(sumsPath, "utf8").split(/\r?\n/).filter(Boolean);
  const verified: string[] = [];
  for (const line of lines) {
    const match = /^([a-fA-F0-9]{64})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const [, expected, rawPath] = match;
    const name = normalizeSumsName(rawPath!);
    const target = safeTarget(dest, name);
    if (!existsSync(target)) {
      throw new Error(`SHA256SUMS references missing file: ${name}`);
    }
    if (alreadyVerified?.has(name)) {
      // Hash already confirmed against this run's fresh sums during
      // download/cache-check; don't re-stream multi-GB weights.
      verified.push(name);
      continue;
    }
    const actual = await fileSha256(target);
    if (actual !== expected!.toLowerCase()) {
      throw new Error(`sha256 mismatch for ${name}: got ${actual}, expected ${expected}`);
    }
    verified.push(name);
  }
  log(`sha256sums_verified files=${verified.length}`);
  return verified;
}
