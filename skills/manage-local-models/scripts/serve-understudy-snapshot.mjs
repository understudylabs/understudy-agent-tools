#!/usr/bin/env node
// Reads <artifact-dir>/understudy.serving.json and emits (or runs) the exact
// correct serve command for a local model: the launcher + model arg + required
// flags (e.g. --top-logprobs-k 20) + prescribed decode + optional MTP wiring.
// The model card is the source of truth; this helper enforces it so serving
// flags cannot be forgotten or mis-specified by hand.
//
// Usage:
//   node serve-understudy-snapshot.mjs --model <id> [--port 8094] [--host 127.0.0.1] [--mtp] [--exec]
//
// Default: prints the command + decode env (review/copy-paste). --exec: spawns it.
// --mtp: append the manifest's MTP draft flags (warns if the assistant is not bf16).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const MODELS_DIR = join(homedir(), ".understudy", "models");
const SCHEMA_VERSION = "understudy.serving.v1";

function parseArgs(argv) {
  const a = { port: "8094", host: "127.0.0.1", mtp: false, exec: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") a.model = argv[++i];
    else if (arg === "--port") a.port = argv[++i];
    else if (arg === "--host") a.host = argv[++i];
    else if (arg === "--mtp") a.mtp = true;
    else if (arg === "--exec") a.exec = true;
    else if (arg === "-h" || arg === "--help") a.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return a;
}

function readManifest(modelId) {
  const dir = join(MODELS_DIR, modelId);
  const path = join(dir, "understudy.serving.json");
  if (!existsSync(path)) {
    throw new Error(
      `No understudy.serving.json at ${path}\n` +
        `Pull the model first, or create the manifest (see skills/manage-local-models/references/serving-manifest.md).`,
    );
  }
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported schema_version ${manifest.schema_version} (expected ${SCHEMA_VERSION}) at ${path}`,
    );
  }
  return { dir, manifest };
}

// Build the exact serve argv from the manifest.
function buildCommand({ manifest, dir, host, port, mtp }) {
  const s = manifest.server || {};
  if (!s.launcher || !s.model_arg) {
    throw new Error("manifest.server.launcher and model_arg are required");
  }
  const launcher = s.launcher.split(/\s+/); // e.g. ["python", "-m", "mlx_vlm.server"]
  const argv = [...launcher, s.model_arg, dir, "--host", host, "--port", port];
  // Required flags from the manifest (e.g. ["--top-logprobs-k", "20"]).
  for (const flag of s.required_flags || []) argv.push(flag);

  if (mtp) {
    const m = manifest.mtp;
    if (!m || !m.assistant_model) {
      throw new Error("manifest has no mtp.assistant_model; cannot enable --mtp");
    }
    const fmt = (m.assistant_format || "").toLowerCase();
    const isBf16 = /bf16|fp16|\bf16\b|bfloat16/.test(fmt);
    const isQuantized = /\b[248]-?bits?\b|\bint[248]\b|nvfp4|mxfp4|q4_0/.test(fmt);
    if (isQuantized && !isBf16) {
      throw new Error(
        `manifest.mtp.assistant_format=${m.assistant_format} — MTP requires a bf16 assistant ` +
          `(mlx-vlm #1391). Re-convert the assistant without -q.`,
      );
    }
    const assistantDir = join(MODELS_DIR, m.assistant_model);
    if (!existsSync(assistantDir)) {
      throw new Error(`MTP assistant not found: ${assistantDir}`);
    }
    const flags = m.server_flags_when_enabled || [
      "--draft-model",
      assistantDir,
      "--draft-kind",
      m.draft_kind || "mtp",
    ];
    // Resolve a <assistant-path> placeholder if the manifest uses one.
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "<assistant-path>") flags[i] = assistantDir;
    }
    argv.push(...flags);
  }
  return { argv, cwd: s.cwd ? s.cwd.replace(/^~/, homedir()) : undefined };
}

function decodeEnv(manifest) {
  const d = manifest.decode;
  if (!d) return [];
  const env = [];
  if (d.temperature != null) env.push(`UNDERSTUDY_TEMPERATURE=${d.temperature}`);
  if (d.top_p != null) env.push(`UNDERSTUDY_TOP_P=${d.top_p}`);
  if (d.top_k != null) env.push(`UNDERSTUDY_TOP_K=${d.top_k}`);
  return env;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.model) {
    console.log(
      `Usage: node serve-understudy-snapshot.mjs --model <id> [--port 8094] [--host 127.0.0.1] [--mtp] [--exec]`,
    );
    process.exit(args.help ? 0 : 1);
  }
  const { dir, manifest } = readManifest(args.model);
  const { argv, cwd } = buildCommand({
    manifest,
    dir,
    host: args.host,
    port: args.port,
    mtp: args.mtp,
  });
  const envExports = decodeEnv(manifest);

  console.log(`# model: ${manifest.model_id}`);
  console.log(`# artifact: ${dir}`);
  if (cwd) console.log(`# cwd: ${cwd}`);
  console.log(`# prescribed decode (export before evaluating):`);
  for (const e of envExports) console.log(`export ${e}`);
  if (args.mtp && manifest.mtp?.note) console.log(`# mtp note: ${manifest.mtp.note}`);
  console.log(`\n${argv.join(" ")}\n`);

  if (manifest.decode?.warning) console.log(`# WARNING: ${manifest.decode.warning}`);

  if (args.exec) {
    console.log(`# spawning (detached)...`);
    const child = spawn(argv[0], argv.slice(1), {
      cwd: cwd || undefined,
      stdio: "inherit",
      detached: true,
    });
    child.unref();
  }
}

try {
  main();
} catch (err) {
  console.error(`understudy serve failed: ${err.message}`);
  process.exit(1);
}
