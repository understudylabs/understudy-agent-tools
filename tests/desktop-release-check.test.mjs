import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  builtCliRuntimeVersion,
  builtCliRuntimeVersionError,
  desktopArtifactPaths,
  inspectDesktopRelease,
  inspectDesktopVersions,
  repositoryRoot,
  runtimeCliAdvancementError,
} from "../scripts/desktop-release-check.mjs";

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function replaceOnce(path, from, to) {
  const source = readFileSync(path, "utf8");
  assert.ok(source.includes(from), `${path} must contain ${from}`);
  writeFileSync(path, source.replace(from, to));
}

function previousPatch(version, steps = 1) {
  const parts = version.split(".").map(Number);
  parts[2] -= steps;
  assert.ok(parts[2] >= 0, `cannot decrement ${version} by ${steps} patches`);
  return parts.join(".");
}

test("desktop release sources share one exact version", () => {
  const report = inspectDesktopVersions();
  assert.deepEqual(report.errors, []);
  assert.match(report.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual([...new Set(Object.values(report.versions))], [report.version]);
  assert.equal(report.compatibility.cli_package, report.compatibility.minimum_cli);
  const artifacts = desktopArtifactPaths(report.version);
  assert.match(artifacts.app, /Understudy\.app$/);
  assert.match(artifacts.dmg, new RegExp(`Understudy_${report.version}_aarch64\\.dmg$`));
  assert.match(artifacts.updater_archive, /Understudy\.app\.tar\.gz$/);
  assert.match(artifacts.updater_signature, /Understudy\.app\.tar\.gz\.sig$/);
  assert.match(artifacts.updater_manifest, /latest\.json$/);
});

test("desktop release source drift fails closed with every version named", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-release-check-"));
  const files = [
    "apps/homescreen/package.json",
    "apps/homescreen/src-tauri/tauri.conf.json",
    "apps/homescreen/src-tauri/capabilities/default.json",
    "apps/homescreen/src-tauri/tauri.macos.conf.json",
    "apps/homescreen/src-tauri/Entitlements.plist",
    "apps/homescreen/src-tauri/Cargo.toml",
    "apps/homescreen/src-tauri/Cargo.lock",
    "apps/homescreen/src-tauri/src/conversation_runtime.rs",
    "apps/homescreen/src-tauri/src/bootstrap.rs",
    "apps/homescreen/src-tauri/src/lib.rs",
    "package.json",
    "src/runtime/conversation/contract.ts",
  ];
  try {
    for (const relative of files) {
      const target = join(root, relative);
      cpSync(join(repositoryRoot, relative), target, { recursive: false });
    }
    const packagePath = join(root, "apps/homescreen/package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    pkg.version = "9.9.9";
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    const report = inspectDesktopVersions(root);
    assert.equal(report.version, null);
    assert.equal(report.versions.desktop_package, "9.9.9");
    assert.match(report.errors.join("\n"), /desktop release versions drifted/);
    for (const source of Object.keys(report.versions)) {
      assert.match(report.errors.join("\n"), new RegExp(`${source}=`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("built CLI reports the exact runtime version the desktop app requires", () => {
  const report = inspectDesktopVersions();
  assert.deepEqual(report.errors, []);
  const cliRuntime = builtCliRuntimeVersion(repositoryRoot);
  assert.equal(cliRuntime, report.versions.rust_runtime);
  assert.equal(builtCliRuntimeVersionError(cliRuntime, report.versions.rust_runtime), null);
});

test("a bundled CLI with a drifted runtime version blocks the release", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-cli-runtime-drift-"));
  try {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(
      join(root, "dist", "bin.js"),
      'process.stdout.write(JSON.stringify({ runtime_version: "0.0.1" }));\n',
    );
    const cliRuntime = builtCliRuntimeVersion(root);
    assert.equal(cliRuntime, "0.0.1");
    assert.match(
      builtCliRuntimeVersionError(cliRuntime, "0.3.34"),
      /built CLI reports conversation runtime 0\.0\.1, but the desktop app requires 0\.3\.34/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.match(builtCliRuntimeVersionError(null, "0.3.34"), /did not report a runtime version/);
  assert.match(builtCliRuntimeVersionError("0.3.34", null), /could not read the app's required/);
  assert.throws(
    () => builtCliRuntimeVersion(join(tmpdir(), "understudy-no-such-root")),
    /built CLI is missing/,
  );
});

test("runtime releases require a newer distributed CLI sidecar", () => {
  assert.equal(
    runtimeCliAdvancementError({
      runtime_version: "0.3.12",
      cli_version: "0.6.8",
      baseline_runtime_version: "0.3.11",
      baseline_cli_version: "0.6.7",
    }),
    null,
  );
  assert.match(
    runtimeCliAdvancementError({
      runtime_version: "0.3.12",
      cli_version: "0.6.7",
      baseline_runtime_version: "0.3.11",
      baseline_cli_version: "0.6.7",
    }),
    /CLI 0\.6\.7 did not advance/,
  );
  assert.equal(
    runtimeCliAdvancementError({
      runtime_version: "0.3.11",
      cli_version: "0.6.7",
      baseline_runtime_version: "0.3.11",
      baseline_cli_version: "0.6.7",
    }),
    null,
  );
});

test("release history rejects one CLI version for two runtime builds", async () => {
  const current = inspectDesktopVersions();
  assert.deepEqual(current.errors, []);
  const currentRuntimeVersion = current.version;
  const currentCliVersion = current.compatibility.cli_package;
  const baselineRuntimeVersion = previousPatch(currentRuntimeVersion, 2);
  const transitionRuntimeVersion = previousPatch(currentRuntimeVersion);
  const baselineCliVersion = previousPatch(currentCliVersion, 2);
  const transitionCliVersion = previousPatch(currentCliVersion);
  const root = mkdtempSync(join(tmpdir(), "understudy-runtime-transition-"));
  const files = [
    "apps/homescreen/package.json",
    "apps/homescreen/src-tauri/tauri.conf.json",
    "apps/homescreen/src-tauri/capabilities/default.json",
    "apps/homescreen/src-tauri/tauri.macos.conf.json",
    "apps/homescreen/src-tauri/Entitlements.plist",
    "apps/homescreen/src-tauri/Cargo.toml",
    "apps/homescreen/src-tauri/Cargo.lock",
    "apps/homescreen/src-tauri/src/conversation_runtime.rs",
    "apps/homescreen/src-tauri/src/bootstrap.rs",
    "apps/homescreen/src-tauri/src/lib.rs",
    "package.json",
    "src/runtime/conversation/contract.ts",
  ];
  const paths = Object.fromEntries(files.map((relative) => [relative, join(root, relative)]));
  try {
    for (const relative of files) {
      cpSync(join(repositoryRoot, relative), paths[relative], { recursive: false });
    }
    // A stub built CLI that reports the runtime version this synthetic
    // history lands on, so the built-CLI runtime assertion stays green.
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(
      join(root, "dist", "bin.js"),
      `process.stdout.write(JSON.stringify({ runtime_version: "${transitionRuntimeVersion}" }));\n`,
    );
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.name", "Understudy Release Test"]);
    git(root, ["config", "user.email", "release-test@invalid.example"]);

    replaceOnce(
      paths["package.json"],
      `"version": "${currentCliVersion}"`,
      `"version": "${baselineCliVersion}"`,
    );
    replaceOnce(
      paths["apps/homescreen/src-tauri/src/bootstrap.rs"],
      `MIN_UNDERSTUDY_CLI_VERSION: &str = "${currentCliVersion}"`,
      `MIN_UNDERSTUDY_CLI_VERSION: &str = "${baselineCliVersion}"`,
    );
    replaceOnce(
      paths["apps/homescreen/package.json"],
      `"version": "${currentRuntimeVersion}"`,
      `"version": "${baselineRuntimeVersion}"`,
    );
    replaceOnce(
      paths["apps/homescreen/src-tauri/tauri.conf.json"],
      `"version": "${currentRuntimeVersion}"`,
      `"version": "${baselineRuntimeVersion}"`,
    );
    replaceOnce(
      paths["apps/homescreen/src-tauri/Cargo.toml"],
      `version = "${currentRuntimeVersion}"`,
      `version = "${baselineRuntimeVersion}"`,
    );
    replaceOnce(
      paths["apps/homescreen/src-tauri/Cargo.lock"],
      `name = "understudy"\nversion = "${currentRuntimeVersion}"`,
      `name = "understudy"\nversion = "${baselineRuntimeVersion}"`,
    );
    replaceOnce(
      paths["apps/homescreen/src-tauri/src/conversation_runtime.rs"],
      `RUNTIME_VERSION: &str = "${currentRuntimeVersion}"`,
      `RUNTIME_VERSION: &str = "${baselineRuntimeVersion}"`,
    );
    replaceOnce(
      paths["src/runtime/conversation/contract.ts"],
      `RUNTIME_VERSION = "${currentRuntimeVersion}"`,
      `RUNTIME_VERSION = "${baselineRuntimeVersion}"`,
    );
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "baseline runtime and CLI"]);
    const transitionCommit = git(root, ["rev-parse", "HEAD"]);

    replaceOnce(
      paths["apps/homescreen/package.json"],
      `"version": "${baselineRuntimeVersion}"`,
      `"version": "${transitionRuntimeVersion}"`,
    );
    replaceOnce(
      paths["apps/homescreen/src-tauri/tauri.conf.json"],
      `"version": "${baselineRuntimeVersion}"`,
      `"version": "${transitionRuntimeVersion}"`,
    );
    replaceOnce(
      paths["apps/homescreen/src-tauri/Cargo.toml"],
      `version = "${baselineRuntimeVersion}"`,
      `version = "${transitionRuntimeVersion}"`,
    );
    replaceOnce(
      paths["apps/homescreen/src-tauri/Cargo.lock"],
      `name = "understudy"\nversion = "${baselineRuntimeVersion}"`,
      `name = "understudy"\nversion = "${transitionRuntimeVersion}"`,
    );
    replaceOnce(
      paths["apps/homescreen/src-tauri/src/conversation_runtime.rs"],
      `RUNTIME_VERSION: &str = "${baselineRuntimeVersion}"`,
      `RUNTIME_VERSION: &str = "${transitionRuntimeVersion}"`,
    );
    replaceOnce(
      paths["src/runtime/conversation/contract.ts"],
      `RUNTIME_VERSION = "${baselineRuntimeVersion}"`,
      `RUNTIME_VERSION = "${transitionRuntimeVersion}"`,
    );
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "runtime without CLI bump"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const stale = await inspectDesktopRelease({ root });
    assert.equal(stale.ok, false);
    assert.match(
      stale.errors.join("\n"),
      new RegExp(`runtime transition:.*CLI ${baselineCliVersion.replaceAll(".", "\\.")} did not advance`),
    );
    assert.equal(stale.compatibility.runtime_transition.commit, transitionCommit);

    replaceOnce(
      paths["package.json"],
      `"version": "${baselineCliVersion}"`,
      `"version": "${transitionCliVersion}"`,
    );
    replaceOnce(
      paths["apps/homescreen/src-tauri/src/bootstrap.rs"],
      `MIN_UNDERSTUDY_CLI_VERSION: &str = "${baselineCliVersion}"`,
      `MIN_UNDERSTUDY_CLI_VERSION: &str = "${transitionCliVersion}"`,
    );
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "advance CLI for runtime"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const ready = await inspectDesktopRelease({ root });
    assert.equal(ready.ok, true, ready.errors.join("\n"));
    assert.equal(ready.compatibility.runtime_transition.commit, transitionCommit);
    assert.equal(ready.compatibility.runtime_transition.cli_version, baselineCliVersion);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
