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

test("a full-corpus checkpoint freezes the absolute window and locally ignores private eval data", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-eval-build-state-"));
  try {
    const {
      creatingWorkloadBuildState,
      ensureUnderstudyGitExcluded,
      initializeBuildCheckpoint,
      readEvalBuildState,
    } = await import(`../dist/evals/build-state.js?full-corpus=${Date.now()}`);
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

    const staging = join(repo, ".understudy", "evals", ".weekly.eval-build");
    const state = creatingWorkloadBuildState({
      name: "weekly",
      identity: {
        org_id: "org_synthetic",
        project_id: "proj_synthetic",
        workload_id: "workload_synthetic",
        workload_name: "synthetic",
      },
      source: {
        from: "2026-08-23T12:00:00.000Z",
        to: "2026-08-30T12:00:00.000Z",
        ingestion_cutoff: "2026-08-30T12:00:00.000Z",
      },
      maxAgeDays: 7,
      batchSize: 10,
      now: new Date("2026-08-30T12:00:00.000Z"),
    });
    initializeBuildCheckpoint(staging, state);
    const stored = readEvalBuildState(staging);
    assert.equal(stored.schema_version, "understudy.eval-build-state.v2");
    assert.equal(stored.status, "downloading");
    assert.deepEqual(stored.source, state.source);
    assert.deepEqual(stored.transport, {
      resume_cursor: null,
      chain_id: null,
      next_segment_index: 0,
      previous_manifest_sha256: null,
      segment_manifest_sha256: [],
      cumulative_exported: 0,
      cumulative_total_bytes: 0,
      terminal_receipt: null,
      verified_files: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
