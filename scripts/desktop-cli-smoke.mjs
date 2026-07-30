#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDesktopCli,
  desktopCliPaths,
  repositoryRoot,
} from "./build-desktop-cli.mjs";

function run(binary, args, env) {
  return execFileSync(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 15_000,
  }).trim();
}

export function smokeDesktopCli({ root = repositoryRoot, build = false } = {}) {
  const paths = build ? buildDesktopCli({ root }) : desktopCliPaths(root);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const runtimeHome = mkdtempSync(join(tmpdir(), "understudy-desktop-cli-smoke-"));
  const nodeBin = existsSync(paths.nodeBinary) ? paths.nodeBinary : process.execPath;
  const env = {
    HOME: process.env.HOME ?? runtimeHome,
    PATH: "/usr/bin:/bin",
    UNDERSTUDY_PACKAGE_ROOT: paths.resourceRoot,
    UNDERSTUDY_CONVERSATION_RUNTIME_HOME: runtimeHome,
    UNDERSTUDY_RUNTIME_TOOL_TOKEN: "desktop-cli-smoke-token-0000000000000000",
    UNDERSTUDY_TELEMETRY: "0",
  };
  try {
    const cli = (args) => run(nodeBin, [paths.entry, ...args], env);
    const version = cli(["--version"]);
    if (version !== packageJson.version) {
      throw new Error(`bundled CLI version ${version} does not match ${packageJson.version}`);
    }
    run(
      nodeBin,
      [
        "-e",
        "const r=require('node:module').createRequire(process.argv[1]);" +
          "r('@silvia-odwyer/photon-node');r('undici')",
        paths.entry,
      ],
      env,
    );
    const started = JSON.parse(cli(["runtime", "start", "--json"]));
    if (!started.installed || !started.running || !started.healthy) {
      throw new Error(`bundled runtime did not become healthy: ${JSON.stringify(started)}`);
    }
    const doctor = JSON.parse(cli(["runtime", "doctor", "--json"]));
    if (!doctor.ok) throw new Error(`bundled runtime doctor failed: ${JSON.stringify(doctor)}`);
    const stopped = JSON.parse(cli(["runtime", "stop", "--json"]));
    if (stopped.running) throw new Error("bundled runtime did not stop");
    return { version, runtime_version: started.runtime_version, node: doctor.checks[0]?.detail };
  } finally {
    try {
      run(nodeBin, [paths.entry, "runtime", "stop", "--json"], env);
    } catch {
      // Best-effort cleanup after a failed assertion.
    }
    rmSync(runtimeHome, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = smokeDesktopCli({ build: process.argv.includes("--build") });
    process.stdout.write(
      `ok Desktop CLI ${result.version}; runtime ${result.runtime_version}; ${result.node}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
