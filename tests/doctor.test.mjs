import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const cli = ["node", resolve("dist/bin.js")];

// Strip every UNDERSTUDY_* var and FORCE_COLOR so host/CI state cannot leak
// into spawned CLIs. Each test explicitly sets only what it needs.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^UNDERSTUDY_/i.test(key) && key !== "FORCE_COLOR",
  ),
);

function runDoctor(env) {
  return spawnSync(cli[0], [cli[1], "doctor"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...baseEnv,
      UNDERSTUDY_TELEMETRY: "0",
      ...env,
    },
  });
}

// ── Tables matching the source of truth in src/index.ts (printDoctorJson) ──

// Required files checked by the local doctor.
const requiredFiles = [
  "README.md",
  "LICENSE",
  "package.json",
  "dist/index.js",
  "skills/understudy/SKILL.md",
];

// Version-bearing manifests checked for consistency (path → JSON key in the
// doctor output, plus the shape needed so readManifestVersion picks it up).
const versionManifests = [
  // { path, key, shape } — shape("X") returns the JSON to write for version X
  { path: "package.json",                     key: "cli",              shape: (v) => ({ version: v }) },
  { path: ".claude-plugin/plugin.json",       key: "plugin",           shape: (v) => ({ version: v }) },
  { path: ".claude-plugin/marketplace.json",  key: "marketplace",      shape: (v) => ({ metadata: { version: v } }) },
  { path: ".cursor-plugin/plugin.json",       key: "cursorPlugin",     shape: (v) => ({ version: v }) },
  { path: ".codex-plugin/plugin.json",        key: "codexPlugin",      shape: (v) => ({ version: v }) },
  { path: ".agents/plugins/marketplace.json", key: "codexMarketplace", shape: (v) => ({ metadata: { version: v } }) },
  { path: ".opencode/adapter.json",           key: "opencodeAdapter",  shape: (v) => ({ version: v }) },
  { path: ".hermes/adapter.json",             key: "hermesAdapter",    shape: (v) => ({ version: v }) },
  { path: ".devin/adapter.json",              key: "devinAdapter",     shape: (v) => ({ version: v }) },
];

function createMockRepo() {
  const root = mkdtempSync(join(tmpdir(), "understudy-doctor-test-"));
  const home = mkdtempSync(join(tmpdir(), "understudy-doctor-home-"));

  // Create every directory that the required files and manifests live in.
  const dirs = [
    "dist",
    "skills/understudy",
    ".claude-plugin",
    ".cursor-plugin",
    ".codex-plugin",
    ".agents/plugins",
    ".opencode",
    ".hermes",
    ".devin",
  ];
  for (const d of dirs) {
    mkdirSync(join(root, d), { recursive: true });
  }

  // Seed required files (non-versioned ones get dummy content).
  writeFileSync(join(root, "README.md"), "# Mock Repo");
  writeFileSync(join(root, "LICENSE"), "MIT");
  writeFileSync(join(root, "dist/index.js"), "console.log('mock');");
  writeFileSync(join(root, "skills/understudy/SKILL.md"), "# Skill");

  // Seed every versioned manifest at version 1.0.0.
  for (const m of versionManifests) {
    writeFileSync(join(root, m.path), JSON.stringify(m.shape("1.0.0")));
  }

  return { root, home };
}

function cleanup(root, home) {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("doctor (local)", () => {
  it("passes when all local checks are valid", () => {
    const { root, home } = createMockRepo();
    try {
      const { status, stdout, stderr } = runDoctor({
        UNDERSTUDY_PACKAGE_ROOT: root,
        HOME: home,
        USERPROFILE: home,
      });
      assert.equal(status, 0, `stderr: ${stderr}`);
      const data = JSON.parse(stdout);
      assert.equal(data.ok, true);
      assert.equal(data.missing.length, 0);
      assert.equal(data.versions_consistent, true);
      assert.equal(data.versions.cli, "1.0.0");
      assert.equal(typeof data.desktop_app_daemon, "string");
    } finally {
      cleanup(root, home);
    }
  });

  // ── Missing-file: one it() per required file ────────────────────────────

  for (const file of requiredFiles) {
    it(`fails when required file is missing: ${file}`, () => {
      const { root, home } = createMockRepo();
      try {
        rmSync(join(root, file));
        const { status, stdout, stderr } = runDoctor({
          UNDERSTUDY_PACKAGE_ROOT: root,
          HOME: home,
          USERPROFILE: home,
        });
        assert.equal(status, 1, `stderr: ${stderr}`);
        const data = JSON.parse(stdout);
        assert.equal(data.ok, false);
        assert.ok(data.missing.includes(file), `expected "${file}" in missing, got ${JSON.stringify(data.missing)}`);
      } finally {
        cleanup(root, home);
      }
    });
  }

  // ── Version mismatch: one it() per non-cli manifest ─────────────────────
  // Skips the cli entry (package.json) because bumping cli alone still makes
  // it inconsistent with all others — but the assertion target (which key is
  // wrong) is clearer when we bump one *adapter* away from the rest.

  for (const manifest of versionManifests.filter((m) => m.key !== "cli")) {
    it(`fails when version is inconsistent: ${manifest.key} (${manifest.path})`, () => {
      const { root, home } = createMockRepo();
      try {
        writeFileSync(join(root, manifest.path), JSON.stringify(manifest.shape("9.9.9")));
        const { status, stdout, stderr } = runDoctor({
          UNDERSTUDY_PACKAGE_ROOT: root,
          HOME: home,
          USERPROFILE: home,
        });
        assert.equal(status, 1, `stderr: ${stderr}`);
        const data = JSON.parse(stdout);
        assert.equal(data.ok, false);
        assert.equal(data.versions_consistent, false);
        assert.equal(data.versions.cli, "1.0.0");
        assert.equal(data.versions[manifest.key], "9.9.9");
      } finally {
        cleanup(root, home);
      }
    });
  }
});
