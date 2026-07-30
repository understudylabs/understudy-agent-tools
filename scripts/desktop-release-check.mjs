#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDir, "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function capture(command, args, cwd, env = process.env) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function versionTuple(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function runtimeCliAdvancementError({
  runtime_version: runtimeVersion,
  cli_version: cliVersion,
  baseline_runtime_version: baselineRuntimeVersion,
  baseline_cli_version: baselineCliVersion,
}) {
  if (runtimeVersion === baselineRuntimeVersion) return null;
  const comparison = compareVersions(cliVersion, baselineCliVersion);
  if (comparison === 1) return null;
  return (
    `conversation runtime advanced from ${baselineRuntimeVersion} to ${runtimeVersion}, ` +
    `but CLI ${cliVersion} did not advance beyond ${baselineCliVersion}`
  );
}

export function builtCliRuntimeVersionError(cliRuntimeVersion, appRuntimeVersion) {
  if (!appRuntimeVersion) return "could not read the app's required runtime version";
  if (!cliRuntimeVersion) return "built CLI did not report a runtime version";
  if (cliRuntimeVersion === appRuntimeVersion) return null;
  return (
    `built CLI reports conversation runtime ${cliRuntimeVersion}, but the desktop app ` +
    `requires ${appRuntimeVersion} (conversation_runtime.rs RUNTIME_VERSION)`
  );
}

// Query the built CLI exactly the way the desktop app does at health-check
// time (conversation_sidecar.rs): `understudy runtime status --json`, reading
// the `runtime_version` field. Uses an isolated runtime home so the check
// never touches (or depends on) the developer's live runtime state.
export function builtCliRuntimeVersion(root = repositoryRoot) {
  const entry = join(root, "dist", "bin.js");
  if (!existsSync(entry)) {
    throw new Error(`built CLI is missing (run the build first): ${entry}`);
  }
  const runtimeHome = mkdtempSync(join(tmpdir(), "understudy-runtime-version-check-"));
  try {
    // Like the app's parse_status, read stdout regardless of exit code: an
    // installed-but-stopped runtime still reports its version.
    let stdout;
    try {
      stdout = capture(process.execPath, [entry, "runtime", "status", "--json"], root, {
        ...process.env,
        UNDERSTUDY_CONVERSATION_RUNTIME_HOME: runtimeHome,
        UNDERSTUDY_TELEMETRY: "0",
      });
    } catch (error) {
      stdout = error?.stdout?.toString().trim();
      if (!stdout) throw error;
    }
    const status = JSON.parse(stdout);
    return typeof status.runtime_version === "string" ? status.runtime_version : null;
  } finally {
    rmSync(runtimeHome, { recursive: true, force: true });
  }
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
  const cliPackage = readJson(join(root, "package.json")).version;
  const bootstrap = readFileSync(join(tauri, "src", "bootstrap.rs"), "utf8");
  const tauriConfig = readJson(join(tauri, "tauri.conf.json"));
  const desktopPackage = readJson(join(homescreen, "package.json"));
  const capability = readJson(join(tauri, "capabilities", "default.json"));
  const tauriLib = readFileSync(join(tauri, "src", "lib.rs"), "utf8");
  const macTauriConfig = readJson(join(tauri, "tauri.macos.conf.json"));
  const entitlementsPath = join(tauri, "Entitlements.plist");
  const minimumCli = firstMatch(
    bootstrap,
    /MIN_UNDERSTUDY_CLI_VERSION:\s*&str\s*=\s*"([^"]+)"/,
    "minimum Desktop CLI version",
    errors,
  );
  if (cliPackage !== minimumCli) {
    errors.push(
      `Desktop minimum CLI must match the distributed package: package=${cliPackage}, minimum=${minimumCli ?? "missing"}`,
    );
  }
  if (
    Array.isArray(macTauriConfig.bundle?.externalBin) &&
    macTauriConfig.bundle.externalBin.includes("binaries/understudy-node")
  ) {
    errors.push("Desktop bundle must not statically include the Node sidecar (on-demand runtime)");
  }
  if (
    macTauriConfig.bundle?.resources?.["resources/understudy-cli/"] !==
      "understudy-cli-resources/"
  ) {
    errors.push(
      "Desktop bundle must map self-contained CLI resources to understudy-cli-resources/",
    );
  }
  if (macTauriConfig.bundle?.macOS?.entitlements !== "Entitlements.plist") {
    errors.push("Desktop bundle must apply Entitlements.plist to its signed Node sidecar");
  }
  try {
    const entitlements = readFileSync(entitlementsPath, "utf8");
    if (
      !entitlements.includes("com.apple.security.cs.allow-jit") ||
      !/<true\s*\/>/.test(entitlements)
    ) {
      errors.push("Desktop entitlements must allow JIT for the signed Node/V8 runtime");
    }
  } catch (error) {
    errors.push(`could not read Desktop entitlements: ${error.message}`);
  }
  if (!String(tauriConfig.build?.beforeBuildCommand ?? "").includes("build-desktop-cli.mjs")) {
    errors.push("Desktop beforeBuildCommand must prepare the self-contained CLI bundle");
  }
  if (tauriConfig.bundle?.createUpdaterArtifacts !== true) {
    errors.push("Desktop bundle must create Tauri v2 updater artifacts");
  }
  const updater = tauriConfig.plugins?.updater;
  if (typeof updater?.pubkey !== "string" || updater.pubkey.trim().length < 80) {
    errors.push("Desktop updater must embed its public signing key");
  }
  const updaterEndpoints = Array.isArray(updater?.endpoints) ? updater.endpoints : [];
  if (
    updaterEndpoints.length !== 1 ||
    updaterEndpoints[0] !==
      "https://github.com/understudylabs/understudy-agent-tools/releases/latest/download/latest.json"
  ) {
    errors.push("Desktop updater must use the canonical HTTPS latest.json endpoint");
  }
  if (!capability.permissions?.includes("updater:default")) {
    errors.push("Desktop main-window capability must allow the updater plugin");
  }
  if (!/tauri-plugin-updater\s*=\s*"2\.10\.1"/.test(cargoToml)) {
    errors.push("Desktop Rust updater dependency must be pinned to 2.10.1");
  }
  if (!tauriLib.includes("tauri_plugin_updater::Builder::new().build()")) {
    errors.push("Desktop must initialize the Tauri updater plugin");
  }
  if (desktopPackage.dependencies?.["@tauri-apps/plugin-updater"] !== "2.10.1") {
    errors.push("Desktop JavaScript updater dependency must be pinned to 2.10.1");
  }
  const versions = {
    desktop_package: desktopPackage.version,
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
  return {
    version: unique.length === 1 ? unique[0] : null,
    versions,
    compatibility: { cli_package: cliPackage, minimum_cli: minimumCli },
    errors,
  };
}

function priorDesktopReleaseBaseline(root, head) {
  const tags = capture(
    "git",
    ["tag", "--merged", head, "--list", "desktop-v*-mvp", "--sort=-version:refname"],
    root,
  ).split("\n").filter(Boolean);
  for (const tag of tags) {
    const commit = capture("git", ["rev-list", "-n", "1", tag], root);
    if (commit === head) continue;
    const runtimeSource = capture(
      "git",
      ["show", `${tag}:src/runtime/conversation/contract.ts`],
      root,
    );
    const runtimeMatch = runtimeSource.match(/RUNTIME_VERSION\s*=\s*"([^"]+)"/);
    const cliPackage = JSON.parse(capture("git", ["show", `${tag}:package.json`], root));
    if (!runtimeMatch || typeof cliPackage.version !== "string") {
      throw new Error(`could not read runtime/CLI versions from ${tag}`);
    }
    return {
      tag,
      commit,
      runtime_version: runtimeMatch[1],
      cli_version: cliPackage.version,
    };
  }
  return null;
}

export function priorRuntimeTransitionBaseline(root, head, runtimeVersion) {
  const commits = capture(
    "git",
    ["rev-list", "--first-parent", head],
    root,
  ).split("\n").filter(Boolean);
  for (const commit of commits) {
    const runtimeSource = capture(
      "git",
      ["show", `${commit}:src/runtime/conversation/contract.ts`],
      root,
    );
    const runtimeMatch = runtimeSource.match(/RUNTIME_VERSION\s*=\s*"([^"]+)"/);
    if (!runtimeMatch) {
      throw new Error(`could not read runtime version from ${commit}`);
    }
    if (runtimeMatch[1] === runtimeVersion) continue;
    const cliPackage = JSON.parse(capture("git", ["show", `${commit}:package.json`], root));
    if (typeof cliPackage.version !== "string") {
      throw new Error(`could not read CLI version from ${commit}`);
    }
    return {
      commit,
      runtime_version: runtimeMatch[1],
      cli_version: cliPackage.version,
    };
  }
  return null;
}

export function desktopArtifactPaths(version, root = repositoryRoot, arch = "aarch64") {
  const bundle = join(root, "apps", "homescreen", "src-tauri", "target", "release", "bundle");
  return {
    app: join(bundle, "macos", "Understudy.app"),
    dmg: join(bundle, "dmg", `Understudy_${version}_${arch}.dmg`),
    updater_archive: join(bundle, "macos", "Understudy.app.tar.gz"),
    updater_signature: join(bundle, "macos", "Understudy.app.tar.gz.sig"),
    updater_manifest: join(bundle, "macos", "latest.json"),
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
  let builtCliRuntime = null;
  // The built-CLI runtime assertion needs dist/bin.js. It is mandatory in the
  // signed/notarized stages (the bundle is built by then). In the source stage
  // — which validates pristine checked-in sources on a fresh CI checkout —
  // dist/ may not be built yet, so enforce only when it already exists.
  const builtCliPresent = existsSync(join(root, "dist", "bin.js"));
  if (stage !== "source" || builtCliPresent) {
    try {
      builtCliRuntime = builtCliRuntimeVersion(root);
      const runtimeError = builtCliRuntimeVersionError(
        builtCliRuntime,
        versionState.versions.rust_runtime,
      );
      if (runtimeError) errors.push(runtimeError);
    } catch (error) {
      errors.push(`built CLI runtime-version check failed: ${error.message}`);
    }
  }
  let head = null;
  let originMain = null;
  let clean = null;
  let baseline = null;
  let runtimeTransition = null;
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
  if (head && versionState.version) {
    try {
      baseline = priorDesktopReleaseBaseline(root, head);
      if (baseline) {
        const error = runtimeCliAdvancementError({
          runtime_version: versionState.version,
          cli_version: versionState.compatibility.cli_package,
          baseline_runtime_version: baseline.runtime_version,
          baseline_cli_version: baseline.cli_version,
        });
        if (error) errors.push(error);
      }
    } catch (error) {
      errors.push(`release baseline inspection failed: ${error.message}`);
    }
    try {
      runtimeTransition = priorRuntimeTransitionBaseline(
        root,
        head,
        versionState.version,
      );
      if (runtimeTransition) {
        const error = runtimeCliAdvancementError({
          runtime_version: versionState.version,
          cli_version: versionState.compatibility.cli_package,
          baseline_runtime_version: runtimeTransition.runtime_version,
          baseline_cli_version: runtimeTransition.cli_version,
        });
        if (error) errors.push(`runtime transition: ${error}`);
      } else if (baseline && baseline.runtime_version !== versionState.version) {
        errors.push(
          `could not locate the ${baseline.runtime_version} -> ${versionState.version} ` +
          "runtime transition in first-parent history",
        );
      }
    } catch (error) {
      errors.push(`runtime transition inspection failed: ${error.message}`);
    }
  }

  const artifacts = versionState.version
    ? desktopArtifactPaths(versionState.version, root, arch)
    : null;
  const artifactState = artifacts
    ? {
        app: { path: artifacts.app, exists: existsSync(artifacts.app) },
        dmg: { path: artifacts.dmg, exists: existsSync(artifacts.dmg), sha256: null },
        updater: {
          archive: {
            path: artifacts.updater_archive,
            exists: existsSync(artifacts.updater_archive),
            sha256: null,
          },
          signature: {
            path: artifacts.updater_signature,
            exists: existsSync(artifacts.updater_signature),
          },
          manifest: {
            path: artifacts.updater_manifest,
            exists: existsSync(artifacts.updater_manifest),
          },
        },
        cli: {
          node: join(artifacts.app, "Contents", "MacOS", "understudy-node"),
          node_version: null,
          resource_root: join(
            artifacts.app,
            "Contents",
            "Resources",
            "understudy-cli-resources",
          ),
          path: join(
            artifacts.app,
            "Contents",
            "Resources",
            "understudy-cli-resources",
            "bundle",
            "understudy.js",
          ),
          exists: false,
          version: null,
          sha256: null,
          resources: null,
        },
      }
    : null;

  if (artifactState) {
    artifactState.cli.resources = join(
      artifactState.cli.resource_root,
      "desktop-cli-bundle.json",
    );
  }

  if (stage !== "source" && artifactState) {
    if (!artifactState.app.exists) errors.push(`signed app is missing: ${artifacts.app}`);
    if (!artifactState.dmg.exists) errors.push(`signed DMG is missing: ${artifacts.dmg}`);
    if (!artifactState.updater.archive.exists) {
      errors.push(`signed updater archive is missing: ${artifacts.updater_archive}`);
    }
    if (!artifactState.updater.signature.exists) {
      errors.push(`updater signature is missing: ${artifacts.updater_signature}`);
    }
    if (!artifactState.updater.manifest.exists) {
      errors.push(`updater manifest is missing: ${artifacts.updater_manifest}`);
    }
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
      artifactState.cli.exists = existsSync(artifactState.cli.path);
      if (!artifactState.cli.exists) {
        errors.push(`bundled Desktop CLI is missing: ${artifactState.cli.path}`);
      } else if (!existsSync(artifactState.cli.node)) {
        errors.push(`bundled Node runtime is missing: ${artifactState.cli.node}`);
      } else {
        const runtimeHome = mkdtempSync(join(tmpdir(), "understudy-signed-cli-smoke-"));
        const bundledEnvironment = {
          ...process.env,
          HOME: process.env.HOME ?? runtimeHome,
          PATH: "/usr/bin:/bin",
          UNDERSTUDY_PACKAGE_ROOT: artifactState.cli.resource_root,
          UNDERSTUDY_CONVERSATION_RUNTIME_HOME: runtimeHome,
          UNDERSTUDY_RUNTIME_TOOL_TOKEN: "desktop-signed-smoke-token-000000000000",
          UNDERSTUDY_TELEMETRY: "0",
        };
        try {
          artifactState.cli.sha256 = await sha256(artifactState.cli.node);
          const nodeEntitlements = capture(
            "codesign",
            ["-d", "--entitlements", ":-", artifactState.cli.node],
            root,
          );
          if (!nodeEntitlements.includes("com.apple.security.cs.allow-jit")) {
            errors.push("signed bundled Node is missing the allow-jit entitlement");
          }
          artifactState.cli.node_version = capture(
            artifactState.cli.node,
            ["--version"],
            root,
            bundledEnvironment,
          );
          artifactState.cli.version = capture(
            artifactState.cli.node,
            [artifactState.cli.path, "--version"],
            root,
            bundledEnvironment,
          );
          if (artifactState.cli.version !== versionState.compatibility.cli_package) {
            errors.push(
              `bundled CLI version ${artifactState.cli.version} does not match source ` +
                versionState.compatibility.cli_package,
            );
          }
          const started = JSON.parse(
            capture(
              artifactState.cli.node,
              [artifactState.cli.path, "runtime", "start", "--json"],
              root,
              bundledEnvironment,
            ),
          );
          if (!started.installed || !started.running || !started.healthy) {
            errors.push(`signed bundled runtime did not become healthy: ${JSON.stringify(started)}`);
          }
          const doctor = JSON.parse(
            capture(
              artifactState.cli.node,
              [artifactState.cli.path, "runtime", "doctor", "--json"],
              root,
              bundledEnvironment,
            ),
          );
          if (!doctor.ok) {
            errors.push(`signed bundled runtime doctor failed: ${JSON.stringify(doctor)}`);
          }
        } catch (error) {
          errors.push(`bundled Desktop CLI failed to start: ${error.message}`);
        } finally {
          try {
            capture(
              artifactState.cli.node,
              [artifactState.cli.path, "runtime", "stop", "--json"],
              root,
              bundledEnvironment,
            );
          } catch {
            // Best-effort cleanup after a failed runtime assertion.
          }
          rmSync(runtimeHome, { recursive: true, force: true });
        }
      }
      if (!existsSync(artifactState.cli.resources)) {
        errors.push(`bundled Desktop CLI resources are missing: ${artifactState.cli.resources}`);
      } else {
        try {
          const manifest = readJson(artifactState.cli.resources);
          if (manifest.cli_version !== versionState.compatibility.cli_package) {
            errors.push(
              `bundled CLI manifest ${manifest.cli_version ?? "missing"} does not match source ` +
              versionState.compatibility.cli_package,
            );
          }
          if (manifest.node_version !== versionState.compatibility.node_version) {
            errors.push(
              `manifest Node ${manifest.node_version ?? "missing"} does not match ` +
                `pinned ${versionState.compatibility.node_version ?? "missing"}`,
            );
          }
          if (!/^[a-f0-9]{64}$/.test(String(manifest.node_sha256 ?? ""))) {
            errors.push("bundled CLI manifest is missing the unsigned Node provenance hash");
          }
          if (existsSync(artifactState.cli.path)) {
            const cliHash = await sha256(artifactState.cli.path);
            if (cliHash !== manifest.cli_bundle_sha256) {
              errors.push("bundled CLI checksum does not match its manifest");
            }
          }
          const nodeLicense = join(
            artifactState.cli.resource_root,
            "third-party",
            "node",
            "LICENSE",
          );
          if (!existsSync(nodeLicense)) {
            errors.push(`bundled Node license is missing: ${nodeLicense}`);
          }
          const externalModules = Array.isArray(manifest.external_modules)
            ? manifest.external_modules
            : [];
          const expectedExternalModules = ["@silvia-odwyer/photon-node", "undici"];
          for (const expected of expectedExternalModules) {
            if (!externalModules.some((dependency) => dependency?.name === expected)) {
              errors.push(`bundled CLI manifest is missing dependency: ${expected}`);
            }
          }
          for (const dependency of externalModules) {
            const packageJsonPath = join(
              artifactState.cli.resource_root,
              "bundle",
              "node_modules",
              ...String(dependency.name).split("/"),
              "package.json",
            );
            if (!existsSync(packageJsonPath)) {
              errors.push(`bundled CLI dependency is missing: ${dependency.name}`);
              continue;
            }
            const bundledDependency = readJson(packageJsonPath);
            if (bundledDependency.version !== dependency.version) {
              errors.push(
                `bundled CLI dependency ${dependency.name} is ` +
                  `${bundledDependency.version ?? "missing"}; manifest requires ` +
                  `${dependency.version ?? "missing"}`,
              );
            }
          }
        } catch (error) {
          errors.push(`could not read bundled CLI manifest: ${error.message}`);
        }
      }
    }
    if (artifactState.dmg.exists) {
      runCheck("DMG verification", "hdiutil", ["verify", artifacts.dmg], root, errors);
      artifactState.dmg.sha256 = await sha256(artifacts.dmg);
    }
    if (artifactState.updater.archive.exists) {
      artifactState.updater.archive.sha256 = await sha256(artifacts.updater_archive);
    }
    if (artifactState.updater.signature.exists && artifactState.updater.manifest.exists) {
      try {
        const signature = readFileSync(artifacts.updater_signature, "utf8").trim();
        const manifest = readJson(artifacts.updater_manifest);
        const platform = manifest.platforms?.["darwin-aarch64"];
        const expectedUrl =
          `https://github.com/understudylabs/understudy-agent-tools/releases/download/` +
          `desktop-v${versionState.version}-mvp/Understudy.app.tar.gz`;
        if (manifest.version !== versionState.version) {
          errors.push(
            `updater manifest version ${manifest.version ?? "missing"} does not match source ` +
              versionState.version,
          );
        }
        if (!signature || platform?.signature !== signature) {
          errors.push("updater manifest does not embed the exact artifact signature");
        }
        if (platform?.url !== expectedUrl) {
          errors.push(`updater manifest URL must be ${expectedUrl}`);
        }
      } catch (error) {
        errors.push(`could not validate updater manifest: ${error.message}`);
      }
    }
  }

  if (stage === "notarized" && artifactState?.dmg.exists) {
    if (artifactState.app.exists) {
      runCheck(
        "app notarization ticket validation",
        "xcrun",
        ["stapler", "validate", artifacts.app],
        root,
        errors,
      );
    }
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
    compatibility: {
      ...versionState.compatibility,
      built_cli_runtime: builtCliRuntime,
      baseline,
      runtime_transition: runtimeTransition,
    },
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
    if (report.artifacts?.updater.archive.sha256) {
      process.stdout.write(`Updater SHA-256 ${report.artifacts.updater.archive.sha256}\n`);
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
