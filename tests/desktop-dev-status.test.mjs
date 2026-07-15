import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { collectDesktopDeveloperStatus, PUBLIC_UPDATER_URL } from "../scripts/desktop-dev-status.mjs";
import {
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

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo(root) {
  const plan = createDesktopReleasePlan({
    desktopVersion: targetDesktopVersion,
    cliVersion: targetCliVersion,
  });
  for (const operation of plan.operations) {
    const target = join(root, operation.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repositoryRoot, operation.path), target);
  }
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Understudy Status Test"]);
  git(root, ["config", "user.email", "status-test@invalid.example"]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
}

test("developer status help is zero-exit and documents its network and eligibility flags", () => {
  const result = spawnSync(process.execPath, ["scripts/desktop-dev-status.mjs", "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: desktop-dev-status/);
  assert.match(result.stdout, /--check-updater\s+Query the public updater manifest \(network request\)/);
  assert.match(result.stdout, /--require-release-eligible\s+Exit non-zero/);
  assert.equal(result.stderr, "");
});

test("developer status is one JSON view of worktree, compatibility, eligibility, and updater", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-desktop-status-"));
  try {
    makeRepo(root);
    const fetchImpl = async (url) => {
      assert.equal(String(url), PUBLIC_UPDATER_URL);
      return new Response(JSON.stringify({
        version: currentDesktopVersion,
        pub_date: "2026-07-15T00:00:00Z",
        platforms: {
          "darwin-aarch64": {
            url: "https://example.invalid/Understudy.app.tar.gz",
            signature: "signed-update-fixture-value-long-enough",
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const ready = await collectDesktopDeveloperStatus({ root, checkUpdater: true, fetchImpl });
    assert.equal(ready.git.clean, true);
    assert.equal(ready.git.head_matches_origin_main, true);
    assert.equal(ready.release.eligible_from_source_state, true);
    assert.deepEqual(ready.release.blockers, []);
    assert.equal(ready.versions.desktop_version, currentDesktopVersion);
    assert.equal(ready.versions.cli_version, currentCliVersion);
    assert.equal(ready.versions.compatibility.desktop_runtime_aligned, true);
    assert.equal(ready.versions.compatibility.desktop_cli_floor_matches_package, true);
    assert.equal(ready.public_updater.version, currentDesktopVersion);
    assert.equal(ready.public_updater.signature_present, true);
    assert.equal(ready.privacy.secrets_read, false);

    writeFileSync(join(root, "package.json"), `${readFileSync(join(root, "package.json"), "utf8")}\n`);
    writeFileSync(join(root, "untracked.txt"), "local-only\n");
    const dirty = await collectDesktopDeveloperStatus({ root });
    assert.equal(dirty.release.eligible_from_source_state, false);
    assert.deepEqual(dirty.release.blockers, ["worktree_dirty"]);
    assert.equal(dirty.git.changed_paths.includes("package.json"), true);
    assert.equal(dirty.git.changed_paths.includes("untracked.txt"), true);
    assert.equal(dirty.public_updater.checked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
