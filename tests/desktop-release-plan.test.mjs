import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  applyDesktopReleasePlan,
  createDesktopReleasePlan,
  inspectReleaseVersionSources,
  repositoryRoot,
} from "../scripts/desktop-release-plan.mjs";

function nextPatch(version) {
  const parts = version.split(".").map(Number);
  parts[2] += 1;
  return parts.join(".");
}

const canonicalVersions = inspectReleaseVersionSources(repositoryRoot);
const currentDesktopVersion = canonicalVersions.desktop_version;
const currentCliVersion = canonicalVersions.cli_version;
const targetDesktopVersion = nextPatch(currentDesktopVersion);
const targetCliVersion = nextPatch(currentCliVersion);

function copyCanonicalSources(root) {
  const plan = createDesktopReleasePlan({
    desktopVersion: targetDesktopVersion,
    cliVersion: targetCliVersion,
  });
  for (const operation of plan.operations) {
    const target = join(root, operation.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repositoryRoot, operation.path), target);
  }
}

test("release plan help is zero-exit and distinguishes verification from mutation", () => {
  const result = spawnSync(process.execPath, ["scripts/desktop-release-plan.mjs", "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /desktop-release-plan --verify/);
  assert.match(result.stdout, /--apply\s+Apply the freshly generated plan after integrity checks/);
  assert.match(result.stdout, /without changing them/);
  assert.equal(result.stderr, "");
});

test("one release plan advances every canonical Desktop, runtime, CLI, and adapter source", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-release-plan-"));
  try {
    copyCanonicalSources(root);
    const before = inspectReleaseVersionSources(root);
    assert.deepEqual(before.errors, []);
    assert.equal(before.compatibility.desktop_cli_floor_matches_package, true);
    const plan = createDesktopReleasePlan({
      root,
      desktopVersion: targetDesktopVersion,
      cliVersion: targetCliVersion,
    });
    assert.equal(plan.from.desktop_version, currentDesktopVersion);
    assert.equal(plan.from.cli_version, currentCliVersion);
    assert.ok(plan.operations.length >= 15);
    const after = applyDesktopReleasePlan(plan, root);
    assert.deepEqual(after.errors, []);
    assert.equal(after.desktop_version, targetDesktopVersion);
    assert.equal(after.cli_version, targetCliVersion);
    assert.equal(after.sources.every((source) => (
      source.version === (source.group === "desktop" ? targetDesktopVersion : targetCliVersion)
    )), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release plan refuses stale file bytes instead of applying a partial bump", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-release-plan-stale-"));
  try {
    copyCanonicalSources(root);
    const plan = createDesktopReleasePlan({
      root,
      desktopVersion: targetDesktopVersion,
      cliVersion: targetCliVersion,
    });
    appendFileSync(join(root, "package.json"), "\n");
    assert.throws(() => applyDesktopReleasePlan(plan, root), /stale for package\.json/);
    const after = inspectReleaseVersionSources(root);
    assert.equal(after.desktop_version, currentDesktopVersion);
    assert.equal(after.cli_version, currentCliVersion);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release planning refuses a same-version or downgrade release", () => {
  assert.throws(
    () => createDesktopReleasePlan({ desktopVersion: currentDesktopVersion, cliVersion: targetCliVersion }),
    /Desktop target .* must advance/,
  );
  assert.throws(
    () => createDesktopReleasePlan({ desktopVersion: targetDesktopVersion, cliVersion: currentCliVersion }),
    /CLI target .* must advance/,
  );
});

test("release application rejects a changed operation before mutating any source", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-release-plan-tampered-"));
  try {
    copyCanonicalSources(root);
    const before = inspectReleaseVersionSources(root);
    const plan = createDesktopReleasePlan({
      root,
      desktopVersion: targetDesktopVersion,
      cliVersion: targetCliVersion,
    });
    const operation = plan.operations.find((candidate) => candidate.path === "package.json");
    operation.replacements[0].to = "9.9.9";
    assert.throws(
      () => applyDesktopReleasePlan(plan, root),
      /release plan operation changed for package\.json/,
    );
    assert.deepEqual(inspectReleaseVersionSources(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
