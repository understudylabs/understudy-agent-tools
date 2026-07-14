import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  desktopArtifactPaths,
  inspectDesktopVersions,
  repositoryRoot,
  runtimeCliAdvancementError,
} from "../scripts/desktop-release-check.mjs";

test("desktop release sources share one exact version", () => {
  const report = inspectDesktopVersions();
  assert.deepEqual(report.errors, []);
  assert.match(report.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual([...new Set(Object.values(report.versions))], [report.version]);
  assert.equal(report.compatibility.cli_package, report.compatibility.minimum_cli);
  const artifacts = desktopArtifactPaths(report.version);
  assert.match(artifacts.app, /Understudy\.app$/);
  assert.match(artifacts.dmg, new RegExp(`Understudy_${report.version}_aarch64\\.dmg$`));
});

test("desktop release source drift fails closed with every version named", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-release-check-"));
  const files = [
    "apps/homescreen/package.json",
    "apps/homescreen/src-tauri/tauri.conf.json",
    "apps/homescreen/src-tauri/Cargo.toml",
    "apps/homescreen/src-tauri/Cargo.lock",
    "apps/homescreen/src-tauri/src/conversation_runtime.rs",
    "apps/homescreen/src-tauri/src/bootstrap.rs",
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

test("runtime releases require a newer distributed CLI sidecar", () => {
  assert.equal(
    runtimeCliAdvancementError({
      runtime_version: "0.3.10",
      cli_version: "0.6.6",
      baseline_runtime_version: "0.3.9",
      baseline_cli_version: "0.6.5",
    }),
    null,
  );
  assert.match(
    runtimeCliAdvancementError({
      runtime_version: "0.3.10",
      cli_version: "0.6.5",
      baseline_runtime_version: "0.3.9",
      baseline_cli_version: "0.6.5",
    }),
    /CLI 0\.6\.5 did not advance/,
  );
  assert.equal(
    runtimeCliAdvancementError({
      runtime_version: "0.3.9",
      cli_version: "0.6.5",
      baseline_runtime_version: "0.3.9",
      baseline_cli_version: "0.6.5",
    }),
    null,
  );
});
