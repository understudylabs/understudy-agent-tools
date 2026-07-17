import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { packagePath } from "../../internal/package-root.js";

export const MLX_VLM_COMMIT = "bc3461b13a636d7cb8213b0008d885a9965f1e69";
export const MLX_VLM_SOURCE = `git+https://github.com/Blaizzy/mlx-vlm.git@${MLX_VLM_COMMIT}`;
export const MLX_VLM_RUNTIME_VERSION = `0.6.4+${MLX_VLM_COMMIT.slice(0, 12)}`;
export const MLX_VLM_PYTHON = "3.13.13";

type ManagedManifest = {
  schema_version: "understudy-mlx-vlm-runtime-v1";
  runtime_version: string;
  commit: string;
  source: string;
  python: string;
  constraints_sha256: string;
  installed_at: string;
};

export type MlxVlmRuntimeStatus = {
  installed: boolean;
  healthy: boolean;
  runtime_version: string;
  commit: string;
  source: string;
  root: string;
  server_binary: string;
  python_binary: string;
  manifest_path: string;
  detail: string;
};

export type MlxVlmRuntimeDoctor = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  status: MlxVlmRuntimeStatus;
  repair_command: "understudy models runtime repair";
};

export function mlxVlmRuntimeHome(): string {
  return resolve(
    process.env.UNDERSTUDY_MLX_VLM_HOME ??
      join(homedir(), ".understudy", "runtime", "mlx-vlm"),
  );
}

function versionRoot(): string {
  return join(mlxVlmRuntimeHome(), MLX_VLM_COMMIT);
}

function paths() {
  const root = versionRoot();
  return {
    root,
    toolDir: join(root, "tools"),
    binDir: join(root, "bin"),
    server: join(root, "bin", "mlx_vlm.server"),
    python: join(root, "tools", "mlx-vlm", "bin", "python"),
    manifest: join(root, "runtime.json"),
  };
}

export function mlxVlmConstraintsPath(): string {
  return packagePath("runtime-assets", "mlx-vlm-constraints.txt");
}

function constraintsSha256(): string {
  return createHash("sha256")
    .update(readFileSync(mlxVlmConstraintsPath()))
    .digest("hex");
}

function readManifest(path: string): ManagedManifest | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ManagedManifest;
    if (value.schema_version !== "understudy-mlx-vlm-runtime-v1") return null;
    return value;
  } catch {
    return null;
  }
}

function supportedPlatform(): boolean {
  return (
    (process.platform === "darwin" && process.arch === "arm64") ||
    process.env.UNDERSTUDY_MLX_VLM_ALLOW_UNSUPPORTED === "1"
  );
}

function uvBinary(): string {
  return process.env.UNDERSTUDY_UV_BIN?.trim() || "uv";
}

function uvVersion(): { ok: boolean; detail: string } {
  const binary = uvBinary();
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 3_000,
  });
  const detail = result.status === 0 ? result.stdout.trim() : result.error?.message || result.stderr.trim();
  return { ok: result.status === 0, detail: detail || `${binary} is unavailable` };
}

function gemma4SourcePath(): string | null {
  const location = paths();
  const libraryRoot = join(location.toolDir, "mlx-vlm", "lib");
  if (!existsSync(libraryRoot)) return null;
  for (const name of readdirSync(libraryRoot).sort()) {
    if (!name.startsWith("python")) continue;
    const candidate = join(
      libraryRoot,
      name,
      "site-packages",
      "mlx_vlm",
      "models",
      "gemma4",
      "gemma4.py",
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function gemma4LayoutCompatible(): { ok: boolean; detail: string } {
  const path = gemma4SourcePath();
  if (!path) return { ok: false, detail: "Gemma 4 implementation is missing" };
  const source = readFileSync(path, "utf8");
  const ok =
    source.includes("v.shape[-1] != expected_in") &&
    source.includes('"depthwise_conv1d.weight"') &&
    source.includes("v.shape[-1] != 1");
  return {
    ok,
    detail: ok
      ? `already-converted Gemma 4 audio layouts are preserved (${path})`
      : `known-bad Gemma 4 audio transpose behavior detected (${path})`,
  };
}

function manifestCompatible(manifest: ManagedManifest | null): boolean {
  return Boolean(
    manifest &&
      manifest.runtime_version === MLX_VLM_RUNTIME_VERSION &&
      manifest.commit === MLX_VLM_COMMIT &&
      manifest.source === MLX_VLM_SOURCE &&
      manifest.python === MLX_VLM_PYTHON &&
      manifest.constraints_sha256 === constraintsSha256(),
  );
}

export function mlxVlmRuntimeStatus(): MlxVlmRuntimeStatus {
  const location = paths();
  const manifest = readManifest(location.manifest);
  const serverPresent = existsSync(location.server);
  const pythonPresent = existsSync(location.python);
  const provenanceOk = manifestCompatible(manifest);
  const layout = gemma4LayoutCompatible();
  const installed = Boolean(manifest && serverPresent && pythonPresent);
  const healthy = installed && provenanceOk && layout.ok;
  let detail = "not installed";
  if (installed && !provenanceOk) detail = "installed runtime provenance does not match the managed pin";
  else if (installed && !layout.ok) detail = layout.detail;
  else if (healthy) detail = "managed MLX/VLM runtime is ready";
  return {
    installed,
    healthy,
    runtime_version: MLX_VLM_RUNTIME_VERSION,
    commit: MLX_VLM_COMMIT,
    source: MLX_VLM_SOURCE,
    root: location.root,
    server_binary: location.server,
    python_binary: location.python,
    manifest_path: location.manifest,
    detail,
  };
}

function serverCliProbe(path: string): { ok: boolean; detail: string } {
  if (!existsSync(path)) return { ok: false, detail: `${path} is missing` };
  const result = spawnSync(path, ["--help"], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      HF_DATASETS_OFFLINE: "1",
    },
  });
  if (result.status === 0) return { ok: true, detail: path };
  if (result.signal) return { ok: false, detail: `${path} terminated with ${result.signal}` };
  return {
    ok: false,
    detail: result.error?.message || result.stderr.trim() || `${path} exited ${result.status}`,
  };
}

export function doctorMlxVlmRuntime(): MlxVlmRuntimeDoctor {
  const status = mlxVlmRuntimeStatus();
  const manifest = readManifest(status.manifest_path);
  const uv = uvVersion();
  const layout = gemma4LayoutCompatible();
  const server = serverCliProbe(status.server_binary);
  const checks = [
    {
      name: "apple_silicon",
      ok: supportedPlatform(),
      detail: `${process.platform}/${process.arch}; managed MLX requires Apple Silicon`,
    },
    { name: "uv", ...uv },
    {
      name: "runtime_provenance",
      ok: manifestCompatible(manifest),
      detail: manifest
        ? `${manifest.runtime_version} @ ${manifest.commit}`
        : `${status.manifest_path} is missing`,
    },
    { name: "gemma4_audio_layout", ...layout },
    { name: "server_cli", ...server },
  ];
  return {
    ok: checks.every((check) => check.ok),
    checks,
    status,
    repair_command: "understudy models runtime repair",
  };
}

async function runUvInstall(onLog?: (line: string) => void): Promise<void> {
  const location = paths();
  mkdirSync(location.root, { recursive: true, mode: 0o700 });
  const args = [
    "tool",
    "install",
    "--force",
    "--managed-python",
    "--python",
    MLX_VLM_PYTHON,
    "--constraints",
    mlxVlmConstraintsPath(),
    MLX_VLM_SOURCE,
  ];
  await new Promise<void>((accept, reject) => {
    const child = spawn(uvBinary(), args, {
      env: {
        ...process.env,
        UV_NO_PROGRESS: "1",
        UV_TOOL_DIR: location.toolDir,
        UV_TOOL_BIN_DIR: location.binDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        if (stream === child.stderr) stderr += chunk;
        for (const line of chunk.split(/\r?\n/).filter(Boolean)) onLog?.(line);
      });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(`uv tool install failed (${signal ?? code}): ${stderr.trim()}`));
    });
  });
}

function writeManifest(): void {
  const location = paths();
  const manifest: ManagedManifest = {
    schema_version: "understudy-mlx-vlm-runtime-v1",
    runtime_version: MLX_VLM_RUNTIME_VERSION,
    commit: MLX_VLM_COMMIT,
    source: MLX_VLM_SOURCE,
    python: MLX_VLM_PYTHON,
    constraints_sha256: constraintsSha256(),
    installed_at: new Date().toISOString(),
  };
  mkdirSync(dirname(location.manifest), { recursive: true, mode: 0o700 });
  writeFileSync(location.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(location.manifest, 0o600);
}

export async function installMlxVlmRuntime(options: {
  force?: boolean;
  onLog?: (line: string) => void;
} = {}): Promise<MlxVlmRuntimeDoctor> {
  if (!supportedPlatform()) {
    throw new Error(`managed MLX/VLM requires Apple Silicon; found ${process.platform}/${process.arch}`);
  }
  const current = doctorMlxVlmRuntime();
  if (current.ok && !options.force) return current;
  const uv = uvVersion();
  if (!uv.ok) throw new Error(`uv is required to install the managed MLX/VLM runtime: ${uv.detail}`);
  await runUvInstall(options.onLog);
  writeManifest();
  const repaired = doctorMlxVlmRuntime();
  if (!repaired.ok) {
    const failed = repaired.checks.filter((check) => !check.ok);
    throw new Error(
      `managed MLX/VLM install failed verification: ${failed.map((check) => `${check.name}: ${check.detail}`).join("; ")}`,
    );
  }
  return repaired;
}

export function mlxVlmServerBinary(): string {
  const status = mlxVlmRuntimeStatus();
  if (!status.healthy) {
    throw new Error(
      `managed MLX/VLM runtime is unavailable: ${status.detail}; run understudy models runtime repair`,
    );
  }
  return status.server_binary;
}
