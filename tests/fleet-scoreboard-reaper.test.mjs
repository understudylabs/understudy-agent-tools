import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { buildDeploymentTags, isReapable, parseDeploymentTags } from "../dist/fleet/tags.js";
import { normalizeDeployments } from "../dist/fleet/deployments.js";
import { buildScoreboard } from "../dist/fleet/scoreboard.js";
import { planReap } from "../dist/fleet/reaper.js";

const NOW = Date.parse("2026-01-02T00:00:00.000Z");
const HOUR = 3_600_000;

function iso(offsetHours) {
  return new Date(NOW + offsetHours * HOUR).toISOString();
}

/** Two tagged arms (one expired, one fresh) and one untagged orphan. */
function fixture() {
  return [
    {
      name: "accounts/demo/deployments/arm-a",
      baseModel: "accounts/demo/models/base-8b",
      createTime: iso(-6),
      acceleratorType: "NVIDIA_H100_80GB",
      acceleratorCount: 2,
      desiredReplicaCount: 1,
      annotations: buildDeploymentTags({ owner: "arm-a-runner", ttlHours: 4, arm: "arm-a", createdAt: iso(-6) }),
    },
    {
      name: "accounts/demo/deployments/arm-b",
      baseModel: "accounts/demo/models/base-8b",
      createTime: iso(-1),
      acceleratorType: "NVIDIA_H100_80GB",
      acceleratorCount: 1,
      desiredReplicaCount: 1,
      description: `understudy.owner=arm-b-runner;understudy.ttl-hours=8;understudy.arm=arm-b`,
    },
    {
      name: "accounts/demo/deployments/orphan",
      baseModel: "accounts/demo/models/base-70b",
      createTime: iso(-40),
      acceleratorType: "NVIDIA_B200_180GB",
      acceleratorCount: 4,
      desiredReplicaCount: 2,
    },
  ];
}

const scores = [
  { arm: "arm-a", score: 0.82, split: "dev" },
  { arm: "arm-b", score: 0.41, split: "dev" },
];

describe("fleet tags", () => {
  it("reads the owner/TTL convention from annotations and from a description fallback", () => {
    const [armA, armB, orphan] = normalizeDeployments(fixture(), NOW);
    assert.equal(armA.tags.owner, "arm-a-runner");
    assert.equal(armA.expiresAt, iso(-2));
    assert.equal(armB.tags.ttlHours, 8);
    assert.equal(armB.expiresAt, iso(7));
    assert.equal(orphan.tagged, false);
    assert.equal(isReapable(parseDeploymentTags({})), false);
  });

  it("rejects a tag set without an owner or a positive TTL", () => {
    assert.throws(() => buildDeploymentTags({ owner: "", ttlHours: 4 }), /owner is required/);
    assert.throws(() => buildDeploymentTags({ owner: "arm-a", ttlHours: 0 }), /ttlHours/);
  });
});

describe("fleet scoreboard", () => {
  it("ranks arms on verifier score and $/hr and isolates unscored burn", () => {
    const board = buildScoreboard({ deployments: normalizeDeployments(fixture(), NOW), scores, now: NOW });
    assert.deepEqual(
      board.rows.map((row) => row.arm),
      ["arm-a", "arm-b", "orphan"],
    );
    assert.equal(board.rows[0].usdPerHr, 11);
    assert.equal(board.rows[0].scorePerUsdHr, 0.82 / 11);
    assert.ok(board.rows[0].flags.includes("expired"));
    assert.deepEqual(board.rows[2].flags.sort(), ["burn-without-score", "untagged"]);
    assert.equal(board.totals.live, 3);
    assert.equal(board.totals.estBurnUsdPerHr, 11 + 5.5 + 120);
    assert.equal(board.totals.unscoredBurnUsdPerHr, 120);
    assert.equal(board.totals.untaggedBurnUsdPerHr, 120);
  });

  it("keeps an arm that has a score but no deployment", () => {
    const board = buildScoreboard({ deployments: [], scores: [{ arm: "arm-z", score: 0.5 }], now: NOW });
    assert.deepEqual(board.rows[0].flags, ["no-deployment"]);
    assert.equal(board.rows[0].scorePerUsdHr, null);
  });
});

describe("fleet reaper plan", () => {
  it("scales expired live deployments to zero and never touches untagged ones", () => {
    const plan = planReap({ deployments: normalizeDeployments(fixture(), NOW), now: NOW });
    const byName = new Map(plan.decisions.map((decision) => [decision.name, decision]));
    assert.equal(byName.get("arm-a").action, "scale-to-zero");
    assert.equal(byName.get("arm-b").action, "keep");
    assert.equal(byName.get("orphan").action, "review");
    assert.match(byName.get("orphan").reason, /missing owner\+ttl tag/);
    assert.equal(plan.savingsUsdPerHr, 11);
  });

  it("deletes only tagged deployments already at zero replicas past the delete window", () => {
    const raw = fixture().map((entry) =>
      entry.name.endsWith("arm-a")
        ? {
            ...entry,
            desiredReplicaCount: 0,
            createTime: iso(-30),
            annotations: buildDeploymentTags({ owner: "arm-a-runner", ttlHours: 4, arm: "arm-a", createdAt: iso(-30) }),
          }
        : entry,
    );
    const plan = planReap({ deployments: normalizeDeployments(raw, NOW), now: NOW });
    const armA = plan.decisions.find((decision) => decision.name === "arm-a");
    assert.equal(armA.action, "delete");
    assert.equal(plan.savingsUsdPerHr, 0);
  });

  it("honors protect entries by owner, arm, or name", () => {
    const plan = planReap({
      deployments: normalizeDeployments(fixture(), NOW),
      now: NOW,
      policy: { protect: ["arm-a-runner"] },
    });
    const armA = plan.decisions.find((decision) => decision.name === "arm-a");
    assert.equal(armA.action, "keep");
    assert.match(armA.reason, /protected/);
  });
});

describe("fleet scripts smoke", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-"));
  const deploymentsPath = join(dir, "deployments.json");
  const scoresPath = join(dir, "scores.json");
  writeFileSync(deploymentsPath, JSON.stringify({ deployments: fixture() }));
  writeFileSync(scoresPath, JSON.stringify(scores));

  function run(script, extra) {
    const result = spawnSync(process.execPath, [resolve("scripts", script), "--deployments", deploymentsPath, ...extra], {
      encoding: "utf8",
    });
    return result;
  }

  it("renders a scoreboard from a fixture without provider credentials", () => {
    const result = run("fleet-scoreboard.mjs", ["--scores", scoresPath, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const board = JSON.parse(result.stdout);
    assert.equal(board.rows.length, 3);
    assert.ok(board.totals.unscoredBurnUsdPerHr > 0);
  });

  it("plans a reap in dry-run mode and refuses --apply without --yes", () => {
    const dry = run("fleet-reaper.mjs", ["--json"]);
    assert.equal(dry.status, 0, dry.stderr);
    const result = JSON.parse(dry.stdout);
    assert.equal(result.mode, "dry-run");
    assert.deepEqual(result.plan.applied, []);
    assert.equal(result.plan.counts.review, 1);
    assert.equal(result.plan.idempotency_key, "fleet-reap:local:all:0");

    const unsafe = run("fleet-reaper.mjs", ["--apply"]);
    assert.equal(unsafe.status, 2);
    assert.match(unsafe.stderr, /--apply also requires --yes/);
  });

  it("writes content-addressed artifacts whose hash matches the file body", () => {
    const artifactDir = join(dir, "artifacts");
    const result = run("fleet-reaper.mjs", ["--experiment-id", "exp-1", "--artifact-dir", artifactDir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const { refs } = JSON.parse(result.stdout);
    assert.deepEqual(
      refs.map((ref) => ref.schema_version),
      ["understudy.fleet_scoreboard.v1", "understudy.fleet_reap_plan.v1"],
    );
    for (const ref of refs) {
      const body = readFileSync(fileURLToPath(ref.uri), "utf8").trimEnd();
      assert.equal(createHash("sha256").update(body).digest("hex"), ref.sha256);
      assert.equal(Buffer.byteLength(body), ref.bytes);
    }
  });
});
