#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDir, "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function capture(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function firstMatch(text, pattern, label, errors) {
  const match = text.match(pattern);
  if (!match) {
    errors.push(`could not read ${label}`);
    return null;
  }
  return match[1];
}

function cargoLockVersion(text, errors) {
  const block = text
    .split("[[package]]")
    .find((candidate) => /^\s*name\s*=\s*"understudy"\s*$/m.test(candidate));
  return block
    ? firstMatch(block, /^\s*version\s*=\s*"([^"]+)"\s*$/m, "Cargo.lock understudy version", errors)
    : (errors.push("could not find the understudy package in Cargo.lock"), null);
}

export function inspectDesktopVersions(root = repositoryRoot) {
  const errors = [];
  const homescreen = join(root, "apps", "homescreen");
  const tauri = join(homescreen, "src-tauri");
  const cargoToml = readFileSync(join(tauri, "Cargo.toml"), "utf8");
  const cargoLock = readFileSync(join(tauri, "Cargo.lock"), "utf8");
  const rustContract = readFileSync(join(tauri, "src", "conversation_runtime.rs"), "utf8");
  const tsContract = readFileSync(
    join(root, "src", "runtime", "conversation", "contract.ts"),
    "utf8",
  );
  const versions = {
    desktop_package: readJson(join(homescreen, "package.json")).version,
    tauri_config: readJson(join(tauri, "tauri.conf.json")).version,
    cargo_manifest: firstMatch(
      cargoToml,
      /^version\s*=\s*"([^"]+)"\s*$/m,
      "Cargo.toml package version",
      errors,
    ),
    cargo_lock: cargoLockVersion(cargoLock, errors),
    rust_runtime: firstMatch(
      rustContract,
      /RUNTIME_VERSION:\s*&str\s*=\s*"([^"]+)"/,
      "Rust runtime version",
      errors,
    ),
    typescript_runtime: firstMatch(
      tsContract,
      /RUNTIME_VERSION\s*=\s*"([^"]+)"/,
      "TypeScript runtime version",
      errors,
    ),
  };
  const values = Object.values(versions).filter(Boolean);
  const unique = [...new Set(values)];
  if (unique.length !== 1) {
    errors.push(
      `desktop release versions drifted: ${Object.entries(versions)
        .map(([source, version]) => `${source}=${version ?? "missing"}`)
        .join(", ")}`,
    );
  }
  return { version: unique.length === 1 ? unique[0] : null, versions, errors };
}

export function desktopArtifactPaths(version, root = repositoryRoot, arch = "aarch64") {
  const bundle = join(root, "apps", "homescreen", "src-tauri", "target", "release", "bundle");
  return {
    app: join(bundle, "macos", "Understudy.app"),
    dmg: join(bundle, "dmg", `Understudy_${version}_${arch}.dmg`),
  };
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function runCheck(label, command, args, cwd, errors) {
  try {
    capture(command, args, cwd);
    return true;
  } catch (error) {
    const detail = error?.stderr?.toString().trim().split("\n").at(-1);
    errors.push(`${label} failed${detail ? `: ${detail}` : ""}`);
    return false;
  }
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export async function inspectDesktopRelease({
  root = repositoryRoot,
  stage = "source",
  arch = "aarch64",
  allowDirty = false,
  allowUnmerged = false,
} = {}) {
  if (!new Set(["source", "signed", "notarized"]).has(stage)) {
    throw new Error(`unknown stage ${JSON.stringify(stage)}`);
  }
  const versionState = inspectDesktopVersions(root);
  const errors = [...versionState.errors];
  let head = null;
  let originMain = null;
  let clean = null;
  try {
    head = capture("git", ["rev-parse", "HEAD"], root);
    originMain = capture("git", ["rev-parse", "origin/main"], root);
    clean = capture("git", ["status", "--porcelain"], root).length === 0;
  } catch (error) {
    errors.push(`git release-state inspection failed: ${error.message}`);
  }
  if (!allowDirty && clean === false) errors.push("release worktree is dirty");
  if (!allowUnmerged && head && originMain && head !== originMain) {
    errors.push(`release HEAD ${head} does not match origin/main ${originMain}`);
  }

  const artifacts = versionState.version
    ? desktopArtifactPaths(versionState.version, root, arch)
    : null;
  const artifactState = artifacts
    ? {
        app: { path: artifacts.app, exists: existsSync(artifacts.app) },
        dmg: { path: artifacts.dmg, exists: existsSync(artifacts.dmg), sha256: null },
      }
    : null;

  if (stage !== "source" && artifactState) {
    if (!artifactState.app.exists) errors.push(`signed app is missing: ${artifacts.app}`);
    if (!artifactState.dmg.exists) errors.push(`signed DMG is missing: ${artifacts.dmg}`);
    if (artifactState.app.exists) {
      runCheck(
        "app code-signature verification",
        "codesign",
        ["--verify", "--deep", "--strict", "--verbose=2", artifacts.app],
        root,
        errors,
      );
      try {
        const builtVersion = capture(
          "/usr/libexec/PlistBuddy",
          ["-c", "Print:CFBundleShortVersionString", join(artifacts.app, "Contents", "Info.plist")],
          root,
        );
        if (builtVersion !== versionState.version) {
          errors.push(
            `built app version ${builtVersion} does not match source ${versionState.version}`,
          );
        }
      } catch (error) {
        errors.push(`could not read the built app version: ${error.message}`);
      }
    }
    if (artifactState.dmg.exists) {
      runCheck("DMG verification", "hdiutil", ["verify", artifacts.dmg], root, errors);
      artifactState.dmg.sha256 = await sha256(artifacts.dmg);
    }
  }

  if (stage === "notarized" && artifactState?.dmg.exists) {
    runCheck(
      "notarization ticket validation",
      "xcrun",
      ["stapler", "validate", artifacts.dmg],
      root,
      errors,
    );
    runCheck(
      "Gatekeeper assessment",
      "spctl",
      [
        "--assess",
        "--type",
        "open",
        "--context",
        "context:primary-signature",
        "--verbose=2",
        artifacts.dmg,
      ],
      root,
      errors,
    );
  }

  return {
    stage,
    ok: errors.length === 0,
    version: versionState.version,
    versions: versionState.versions,
    git: { head, origin_main: originMain, clean },
    artifacts: artifactState,
    errors,
  };
}

async function main(args = process.argv.slice(2)) {
  const stage = valueAfter(args, "--stage") ?? "source";
  const arch = valueAfter(args, "--arch") ?? "aarch64";
  const report = await inspectDesktopRelease({
    stage,
    arch,
    allowDirty: args.includes("--allow-dirty"),
    allowUnmerged: args.includes("--allow-unmerged"),
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${report.ok ? "ok" : "blocked"} desktop ${report.version ?? "unknown"} ${report.stage} release check\n`,
    );
    if (report.artifacts?.dmg.sha256) {
      process.stdout.write(`DMG SHA-256 ${report.artifacts.dmg.sha256}\n`);
    }
    for (const error of report.errors) process.stderr.write(`- ${error}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
