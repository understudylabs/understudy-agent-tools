import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";

import {
  doctorMlxVlmRuntime,
  installMlxVlmRuntime,
  MLX_VLM_COMMIT,
  MLX_VLM_RUNTIME_VERSION,
  MLX_VLM_SOURCE,
  mlxVlmRuntimeStatus,
} from "../dist/runtime/mlx-vlm/lifecycle.js";

const root = mkdtempSync(join(tmpdir(), "understudy-mlx-vlm-runtime-"));
const runtimeHome = join(root, "runtime");
const versionRoot = join(runtimeHome, MLX_VLM_COMMIT);
const uvLog = join(root, "uv-args.txt");
const mockUv = join(root, "uv");
const cli = [process.execPath, resolve("dist/bin.js")];

after(() => rmSync(root, { recursive: true, force: true }));

function environment() {
  return {
    ...process.env,
    UNDERSTUDY_TELEMETRY: "0",
    UNDERSTUDY_MLX_VLM_HOME: runtimeHome,
    UNDERSTUDY_MLX_VLM_ALLOW_UNSUPPORTED: "1",
    UNDERSTUDY_UV_BIN: mockUv,
    UNDERSTUDY_TEST_UV_LOG: uvLog,
  };
}

async function withEnvironment(run) {
  const previous = new Map();
  for (const [key, value] of Object.entries(environment())) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writeExecutable(path, source = "#!/bin/sh\nexit 0\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function createCompatibleRuntimeFiles() {
  writeExecutable(join(versionRoot, "bin", "mlx_vlm.server"));
  writeExecutable(join(versionRoot, "tools", "mlx-vlm", "bin", "python"));
  const sourcePath = join(
    versionRoot,
    "tools",
    "mlx-vlm",
    "lib",
    "python3.13",
    "site-packages",
    "mlx_vlm",
    "models",
    "gemma4",
    "gemma4.py",
  );
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(
    sourcePath,
    [
      "if v.shape[-1] != expected_in:",
      '    if "depthwise_conv1d.weight" in new_key:',
      "        if v.shape[-1] != 1:",
      "            pass",
    ].join("\n"),
  );
  return sourcePath;
}

writeExecutable(
  mockUv,
  [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then',
    '  echo "uv 0.11.14"',
    "  exit 0",
    "fi",
    'printf "UV_TOOL_DIR=%s\\nUV_TOOL_BIN_DIR=%s\\n" "$UV_TOOL_DIR" "$UV_TOOL_BIN_DIR" > "$UNDERSTUDY_TEST_UV_LOG"',
    'printf "%s\\n" "$@" >> "$UNDERSTUDY_TEST_UV_LOG"',
    "exit 0",
    "",
  ].join("\n"),
);

test("managed MLX/VLM install pins provenance and verifies the Gemma layout fix", async () => {
  const sourcePath = createCompatibleRuntimeFiles();
  await withEnvironment(async () => {
    const report = await installMlxVlmRuntime();
    assert.equal(report.ok, true);
    assert.equal(report.status.runtime_version, MLX_VLM_RUNTIME_VERSION);
    assert.equal(report.status.commit, MLX_VLM_COMMIT);
    assert.equal(report.status.source, MLX_VLM_SOURCE);
    assert.equal(statSync(report.status.manifest_path).mode & 0o077, 0);

    const args = readFileSync(uvLog, "utf8").trim().split("\n");
    assert.equal(args[0], `UV_TOOL_DIR=${join(versionRoot, "tools")}`);
    assert.equal(args[1], `UV_TOOL_BIN_DIR=${join(versionRoot, "bin")}`);
    assert.deepEqual(args.slice(2, 4), ["tool", "install"]);
    assert.ok(args.includes("--managed-python"));
    assert.ok(args.includes("--constraints"));
    assert.ok(args.includes(MLX_VLM_SOURCE));

    const manifest = JSON.parse(readFileSync(report.status.manifest_path, "utf8"));
    assert.equal(manifest.commit, MLX_VLM_COMMIT);
    assert.match(manifest.constraints_sha256, /^[0-9a-f]{64}$/);

    writeFileSync(sourcePath, "v = v.transpose(0, 2, 3, 1)\n");
    const incompatible = doctorMlxVlmRuntime();
    assert.equal(incompatible.ok, false);
    assert.equal(
      incompatible.checks.find((check) => check.name === "gemma4_audio_layout")?.ok,
      false,
    );
    assert.match(incompatible.repair_command, /models runtime repair/);
  });
});

test("models runtime CLI exposes exact version and actionable status", async () => {
  createCompatibleRuntimeFiles();
  await withEnvironment(() => installMlxVlmRuntime({ force: true }));
  const version = spawnSync(cli[0], [cli[1], "models", "runtime", "version", "--json"], {
    encoding: "utf8",
    env: environment(),
  });
  assert.equal(version.status, 0, version.stderr);
  const versionPayload = JSON.parse(version.stdout);
  assert.equal(versionPayload.commit, MLX_VLM_COMMIT);
  assert.equal(versionPayload.source, MLX_VLM_SOURCE);

  const status = spawnSync(cli[0], [cli[1], "models", "runtime", "status", "--json"], {
    encoding: "utf8",
    env: environment(),
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).healthy, true);
  assert.equal((await withEnvironment(() => mlxVlmRuntimeStatus())).healthy, true);
});
