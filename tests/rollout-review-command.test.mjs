import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cli = resolve("dist/bin.js");

test("rollout command is discoverable and requires full-payload opt-in before reading credentials or files", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-rollout-command-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("UNDERSTUDY_")));
  Object.assign(env, { HOME: root, UNDERSTUDY_TELEMETRY: "0" });
  const run = (...args) => spawnSync(process.execPath, [cli, "traces", "review-rollout", ...args], { cwd: root, env, encoding: "utf8" });
  try {
    const help = run("--help");
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--spec/);
    assert.match(help.stdout, /--download/);
    const args = ["--spec", "missing.json", "--out", "review"];
    const unsafe = run(...args, "--download", "--json");
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /requires --download --include-payload --yes/);
    const misplaced = run(...args, "--yes", "--json");
    assert.equal(misplaced.status, 1);
    assert.match(misplaced.stderr, /apply only with --download/);
    const local = run(...args, "--json");
    assert.equal(local.status, 1);
    assert.doesNotMatch(local.stderr, /API key|credentials|sign in/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
