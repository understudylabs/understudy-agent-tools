#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const VERIFIED_MODELS = {
  "gemma-4-e2b-it-mlx-vlm-4bit": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-4bit&ttl=21600",
    destName: "gemma-4-e2b-it-mlx-vlm-4bit",
    name: "Gemma 4 E2B IT MLX-VLM 4-bit",
    approxGb: 3.3,
    loader: "mlx_vlm",
  },
  "gemma-4-e4b-it-mlx-vlm-4bit": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-e4b-it-mlx-vlm-4bit&ttl=21600",
    destName: "gemma-4-e4b-it-mlx-vlm-4bit",
    name: "Gemma 4 E4B IT MLX-VLM 4-bit",
    approxGb: 4.8,
    loader: "mlx_vlm",
  },
  "gemma-4-12b-it-mlx-vlm-4bit": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-12b-it-mlx-vlm-4bit&ttl=21600",
    destName: "gemma-4-12b-it-mlx-vlm-4bit",
    name: "Gemma 4 12B IT MLX-VLM 4-bit",
    approxGb: 6.3,
    loader: "mlx_vlm",
  },
  "gemma-4-12b-it-mlx-vlm-bf16": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-12b-it-mlx-vlm-bf16&ttl=21600",
    destName: "gemma-4-12b-it-mlx-vlm-bf16",
    name: "Gemma 4 12B IT MLX-VLM BF16",
    approxGb: 22,
    loader: "mlx_vlm",
  },
  "gemma-4-26b-a4b-it-mlx-vlm-4bit": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-26b-a4b-it-mlx-vlm-4bit&ttl=21600",
    destName: "gemma-4-26b-a4b-it-mlx-vlm-4bit",
    name: "Gemma 4 26B A4B IT MLX-VLM 4-bit",
    approxGb: 14,
    loader: "mlx_vlm",
  },
  "gemma-4-31b-it-mlx-vlm-4bit": {
    sessionUrl: "https://models.understudylabs.com/session?model=gemma-4-31b-it-mlx-vlm-4bit&ttl=21600",
    destName: "gemma-4-31b-it-mlx-vlm-4bit",
    name: "Gemma 4 31B IT MLX-VLM 4-bit",
    approxGb: 17,
    loader: "mlx_vlm",
  },
};

function usage() {
  console.log(`Usage: node pull-understudy-snapshot.mjs --model <id> [--dest <dir>] [--session-url <url>] [--dry-run]

Verified ids:
  ${Object.keys(VERIFIED_MODELS).join("\n  ")}

Downloads signed Understudy model snapshot files into ~/.understudy/models/<id>
by default. This is a skill helper, not a public CLI command.`);
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--model") {
      args.model = argv[++i];
    } else if (arg === "--dest") {
      args.dest = argv[++i];
    } else if (arg === "--session-url") {
      args.sessionUrl = argv[++i];
    } else if (arg === "--log-dir") {
      args.logDir = argv[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function nowCompact() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function formatBytes(bytes) {
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

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.ceil(seconds / 3600)}h`;
}

function logLine(logFile, message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  if (logFile) {
    writeFileSync(logFile, `${line}\n`, { flag: "a", mode: 0o600 });
  }
}

async function getContentLength(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) return null;
    const value = response.headers.get("content-length");
    return value ? Number(value) : null;
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`session request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function fileRows(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error("session manifest must include files[]");
  }
  return manifest.files.map((file) => ({
    name: file.name || file.path,
    url: file.url,
    size: Number(file.size_bytes ?? file.size ?? 0) || null,
    sha256: file.sha256 || null,
  }));
}

function safeTarget(dest, name) {
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

async function downloadFile({ row, target, logFile }) {
  mkdirSync(dirname(target), { recursive: true });
  const expectedSize = row.size || (await getContentLength(row.url));
  if (existsSync(target) && expectedSize && statSync(target).size === expectedSize) {
    logLine(logFile, `cached ${row.name} (${expectedSize} bytes)`);
    return { name: row.name, bytes: expectedSize, cached: true };
  }
  if (existsSync(target) && !expectedSize && statSync(target).size > 0) {
    logLine(logFile, `cached ${row.name}`);
    return { name: row.name, bytes: statSync(target).size, cached: true };
  }

  const partial = `${target}.part`;
  rmSync(partial, { force: true });
  logLine(logFile, `downloading ${row.name}${expectedSize ? ` (${expectedSize} bytes)` : ""}`);
  const response = await fetch(row.url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed for ${row.name}: ${response.status} ${response.statusText}`);
  }
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let downloaded = 0;
  const hash = row.sha256 ? createHash("sha256") : null;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      downloaded += chunk.length;
      if (hash) hash.update(chunk);
      const now = Date.now();
      if (expectedSize && (now - lastProgressAt > 5000 || downloaded === expectedSize)) {
        const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
        const bytesPerSecond = downloaded / elapsedSeconds;
        const remainingSeconds = (expectedSize - downloaded) / bytesPerSecond;
        logLine(
          logFile,
          `progress ${row.name} ${formatBytes(downloaded)}/${formatBytes(expectedSize)} eta=${formatEta(remainingSeconds)}`,
        );
        lastProgressAt = now;
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial, { mode: 0o600 }));
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.model) {
    throw new Error("--model is required");
  }
  const model = VERIFIED_MODELS[args.model];
  if (!model && !args.sessionUrl) {
    throw new Error(`unknown verified model id: ${args.model}`);
  }
  const modelInfo = model || {
    sessionUrl: args.sessionUrl,
    destName: args.model,
    name: args.model,
    approxGb: null,
    loader: null,
  };
  const dest = args.dest || join(homedir(), ".understudy", "models", modelInfo.destName);
  const logDir = args.logDir || join(homedir(), ".understudy", "agent-tools", "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `model-pull-${modelInfo.destName}-${nowCompact()}.log`);

  logLine(logFile, `model=${args.model}`);
  logLine(logFile, `name=${modelInfo.name}`);
  logLine(logFile, `session=${args.sessionUrl || modelInfo.sessionUrl}`);
  logLine(logFile, `dest=${dest}`);
  if (modelInfo.approxGb) logLine(logFile, `approx_gb=${modelInfo.approxGb}`);
  if (args.dryRun) {
    logLine(logFile, "dry_run=true");
    console.log(JSON.stringify({ model: args.model, dest, sessionUrl: args.sessionUrl || modelInfo.sessionUrl, logFile }, null, 2));
    return;
  }

  mkdirSync(dest, { recursive: true });
  const manifest = await fetchJson(args.sessionUrl || modelInfo.sessionUrl);
  const rows = fileRows(manifest);
  const results = [];
  for (const row of rows) {
    if (!row.name || !row.url) {
      throw new Error("manifest file entries must include name/path and url");
    }
    results.push(await downloadFile({ row, target: safeTarget(dest, row.name), logFile }));
  }

  const metadata = {
    schema_version: "understudy.model_snapshot.v1",
    model_id: args.model,
    name: modelInfo.name,
    loader: modelInfo.loader,
    session_url: args.sessionUrl || modelInfo.sessionUrl,
    pulled_at: new Date().toISOString(),
    destination: dest,
    files: results,
  };
  writeFileSync(join(dest, ".understudy-snapshot.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  logLine(logFile, `complete files=${results.length} dest=${dest}`);
  console.log(JSON.stringify({ model: args.model, dest, logFile, files: results.length }, null, 2));
}

main().catch((error) => {
  console.error(`understudy model pull failed: ${error.message}`);
  process.exit(1);
});
