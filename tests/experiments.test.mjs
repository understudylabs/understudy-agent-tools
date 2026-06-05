import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const cli = ["node", resolve("dist/bin.js")];

function run(repo, args) {
  return spawnSync(cli[0], [cli[1], ...args, "--repo", repo], { encoding: "utf8" });
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Write the five capture-evidence artifacts with a baseline that pins three of them. */
function seedEvidence(repo) {
  const ce = join(repo, ".understudy", "capture-evidence");
  mkdirSync(ce, { recursive: true });
  const harness = `${JSON.stringify({ command: "npm test" }, null, 2)}\n`;
  const metric = `${JSON.stringify({ approved: true }, null, 2)}\n`;
  const splits = `${JSON.stringify({ train: [], dev: [], holdout: [] }, null, 2)}\n`;
  writeFileSync(join(ce, "harness.json"), harness);
  writeFileSync(join(ce, "environment.json"), `${JSON.stringify({ runtime: "node" }, null, 2)}\n`);
  writeFileSync(join(ce, "metric.json"), metric);
  writeFileSync(join(ce, "splits.json"), splits);
  writeFileSync(
    join(ce, "baseline.json"),
    `${JSON.stringify(
      {
        harness_sha256: sha256(harness),
        metric_sha256: sha256(metric),
        splits_sha256: sha256(splits),
      },
      null,
      2,
    )}\n`,
  );
  return ce;
}

function withRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-experiments-"));
  try {
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function nextState(repo) {
  const result = run(repo, ["next", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("understudy experiments + next", () => {
  it("routes to capture-evidence when evidence is incomplete", () => {
    withRepo((repo) => {
      const state = nextState(repo);
      assert.equal(state.step, "capture-evidence");
      assert.equal(state.experiment_id, null);
      assert.ok(state.evidence.missing.includes("harness.json"));
      assert.equal(state.next_command, "understudy capture-evidence check --repo .");
    });
  });

  it("routes to open-experiment when evidence is present but no experiment is active", () => {
    withRepo((repo) => {
      seedEvidence(repo);
      const state = nextState(repo);
      assert.equal(state.step, "open-experiment");
      assert.equal(state.evidence.missing.length, 0);
      assert.equal(state.next_command, "understudy experiments new --repo .");
    });
  });

  it("walks the loop optimize -> claim -> decide -> route", () => {
    withRepo((repo) => {
      seedEvidence(repo);

      const created = run(repo, ["experiments", "new", "--json", "--workload", "workload-001", "--candidate", "gemma-4-31b"]);
      assert.equal(created.status, 0, created.stderr);
      const experiment = JSON.parse(created.stdout);
      assert.equal(experiment.experiment_id, "exp-001");
      assert.equal(experiment.schema_version, "understudy.experiment.v1");
      // pins are copied from baseline.json's hash-chain (exactly three).
      assert.deepEqual(Object.keys(experiment.pins).sort(), ["harness_sha256", "metric_sha256", "splits_sha256"]);
      assert.ok(experiment.pins.harness_sha256);

      assert.equal(nextState(repo).step, "optimize");

      const expDir = join(repo, ".understudy", "experiments", "exp-001");
      writeFileSync(join(expDir, "candidate.json"), "{}\n");
      assert.equal(nextState(repo).step, "claim");

      writeFileSync(join(expDir, "claim.json"), "{}\n");
      assert.equal(nextState(repo).step, "decide");

      const outcome = run(repo, ["experiments", "outcome", "success", "--route", "ship-local"]);
      assert.equal(outcome.status, 0, outcome.stderr);

      const routed = nextState(repo);
      assert.equal(routed.step, "route");
      const record = JSON.parse(readFileSync(join(expDir, "experiment.json"), "utf8"));
      assert.equal(record.outcome, "success");
      assert.equal(record.route_decision, "ship-local");
      assert.equal(record.result.claim_ref, "claim.json");
    });
  });

  it("detects stale pins and routes back to re-baseline", () => {
    withRepo((repo) => {
      const ce = seedEvidence(repo);
      run(repo, ["experiments", "new"]);
      assert.equal(nextState(repo).step, "optimize");

      // mutate a pinned artifact: the experiment's pins no longer match disk.
      writeFileSync(join(ce, "harness.json"), `${JSON.stringify({ command: "npm run eval" }, null, 2)}\n`);
      const state = nextState(repo);
      assert.equal(state.step, "re-baseline");
      assert.equal(state.pins_match, false);
      assert.equal(state.next_command, "understudy capture-evidence check --repo .");
    });
  });

  it("lists experiments, marks the active one, and switches active", () => {
    withRepo((repo) => {
      seedEvidence(repo);
      run(repo, ["experiments", "new"]); // exp-001
      run(repo, ["experiments", "new"]); // exp-002 (now active)

      const list = run(repo, ["experiments", "list", "--json"]);
      assert.equal(list.status, 0, list.stderr);
      const rows = JSON.parse(list.stdout).experiments;
      assert.deepEqual(
        rows.map((r) => r.experiment_id),
        ["exp-001", "exp-002"],
      );
      assert.equal(rows.find((r) => r.experiment_id === "exp-002").active, true);
      assert.equal(rows.find((r) => r.experiment_id === "exp-001").active, false);

      const used = run(repo, ["experiments", "use", "exp-001"]);
      assert.equal(used.status, 0, used.stderr);
      assert.equal(readFileSync(join(repo, ".understudy", "experiments", "active"), "utf8").trim(), "exp-001");
    });
  });

  it("rejects an invalid outcome", () => {
    withRepo((repo) => {
      seedEvidence(repo);
      run(repo, ["experiments", "new"]);
      const bad = run(repo, ["experiments", "outcome", "shipped"]);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /Invalid outcome/);
    });
  });

  it("creates experiment dirs without an active pointer collision", () => {
    withRepo((repo) => {
      seedEvidence(repo);
      run(repo, ["experiments", "new"]);
      assert.ok(existsSync(join(repo, ".understudy", "experiments", "exp-001", "experiment.json")));
      assert.ok(existsSync(join(repo, ".understudy", "experiments", "active")));
    });
  });
});
