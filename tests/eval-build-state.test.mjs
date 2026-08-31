import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

test("a recycled live pid is stale only when its process instance can be distinguished", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "understudy-eval-build-lease-"));
  const originalSpawnSync = childProcess.spawnSync;
  try {
    if (process.platform === "darwin") {
      childProcess.spawnSync = (command, args, options) => {
        if (command === "/bin/ps") {
          return { status: 0, stdout: "Sat Aug 29 20:30:00 2026\n", stderr: "" };
        }
        return originalSpawnSync(command, args, options);
      };
      syncBuiltinESMExports();
    }
    const { acquireEvalBuildLease } = await import(`../dist/evals/build-state.js?pid-reuse=${Date.now()}`);
    const probeOutput = join(root, "probe");
    const releaseProbe = acquireEvalBuildLease(probeOutput);
    const probeLease = join(dirname(probeOutput), `.${basename(probeOutput)}.eval-build.lock`);
    const probeOwner = JSON.parse(readFileSync(join(probeLease, "owner.json"), "utf8"));
    releaseProbe();

    if (typeof probeOwner.process_instance_id !== "string") {
      t.skip("process-instance identity is unavailable on this platform");
      return;
    }

    const output = join(root, "recycled-pid");
    const lease = join(dirname(output), `.${basename(output)}.eval-build.lock`);
    const owner = {
      token: "previous-builder",
      pid: process.pid,
      process_instance_id: `${probeOwner.process_instance_id}-different-start`,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    mkdirSync(lease, { mode: 0o700 });
    writeFileSync(join(lease, "owner.json"), JSON.stringify(owner), { mode: 0o600 });

    assert.throws(
      () => acquireEvalBuildLease(output),
      /stale eval build lock remains/,
    );
    assert.equal(existsSync(lease), true, "stale detection must not delete the lock automatically");
    assert.deepEqual(
      JSON.parse(readFileSync(join(lease, "owner.json"), "utf8")),
      owner,
      "a rejected builder must not replace another owner's lock metadata",
    );
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("private eval data is idempotently ignored by the local repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-eval-build-state-"));
  try {
    const { ensureUnderstudyGitExcluded } = await import(
      `../dist/evals/build-state.js?git-exclude=${Date.now()}`
    );
    const repo = join(root, "synthetic-repo");
    mkdirSync(repo, { mode: 0o700 });
    const initialized = childProcess.spawnSync("git", ["init", "-q", repo]);
    assert.equal(initialized.status, 0, initialized.stderr?.toString());
    const output = join(repo, ".understudy", "evals", "weekly");
    ensureUnderstudyGitExcluded(output);
    ensureUnderstudyGitExcluded(output);
    assert.equal(
      readFileSync(join(repo, ".git", "info", "exclude"), "utf8")
        .split(/\r?\n/).filter((line) => line === "/.understudy/").length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
