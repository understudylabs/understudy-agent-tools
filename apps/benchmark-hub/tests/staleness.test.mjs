import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Compiled by `tsc -p tests/tsconfig.json` (see package.json "test" script).
// benchmark-core re-exports the staleness math from the repo's dist —
// this exercises the exact functions the Leaderboard client component uses.
import { isRowStale, latestBreakingBumps, staleRowSummary, tasksByIdForStaleness } from "./.build/lib/benchmark-core.js";
import { computeLeaderboard } from "./.build/lib/scores.js";

const manifest = {
  schema_version: "understudy.benchmark.v1",
  benchmark_id: "bench-stale",
  provenance: { origin: "authored" },
  taxonomy: [{ category_id: "cat-a" }],
  tasks: [
    { task_id: "t1", category_id: "cat-a", genesis: "authored", split: "holdout" },
    { task_id: "t2", category_id: "cat-a", genesis: "authored", split: "holdout" },
  ],
  environment: { format: "verifiers.v1", package_ref: "x" },
  verifier: { kind: "reward-fns", strict_metric: "strict" },
};

// t1's env changed on 2026-02-01 (major => rerun); t2 only had a meta patch.
const versions = [
  { created_at: "2026-01-01T00:00:00Z", splits_sha256: "aaa", contamination: "clean" }, // legacy split-freeze line
  {
    created_at: "2026-02-01T00:00:00Z",
    version: "2.0.0",
    task_bumps: [
      { task_id: "t1", bump: "major", from: "1.0.0", to: "2.0.0" },
      { task_id: "t2", bump: "patch", from: "1.0.0", to: "1.0.1" },
    ],
  },
];

const row = (over = {}) => ({
  schema_version: "understudy.eval_result.v1",
  run_id: "r1",
  task_id: "t1",
  status: "ok",
  score: 1,
  model: "m",
  split: "holdout",
  created_at: "2026-03-01T00:00:00Z",
  ...over,
});

describe("leaderboard stale-row exclusion math", () => {
  const rows = [
    // t1 pre-bump rows (STALE): old env scored 0.
    row({ score: 0, created_at: "2026-01-10T00:00:00Z" }),
    row({ score: 0, created_at: "2026-01-11T00:00:00Z" }),
    // t1 post-bump rerun (fresh): new env scores 1.
    row({ score: 1, created_at: "2026-02-02T00:00:00Z" }),
    // t1 row with no provenance (STALE conservatively).
    row({ score: 0, created_at: null }),
    // t2 rows predate only a PATCH bump — never stale.
    row({ task_id: "t2", score: 1, created_at: "2026-01-10T00:00:00Z" }),
  ];
  const bumps = latestBreakingBumps(versions);

  it("default view excludes stale rows from the aggregate", () => {
    const fresh = rows.filter((r) => !isRowStale(r, bumps));
    const summaries = computeLeaderboard(manifest, fresh, { split: "holdout" });
    assert.equal(summaries.length, 1);
    // Only the post-bump t1 row (1) and the t2 row (1) remain => mean 1.
    assert.equal(summaries[0].overall, 1);
    assert.equal(summaries[0].taskCount, 2);
  });

  it("include-stale toggle restores every row (never dropped, only gated)", () => {
    const summaries = computeLeaderboard(manifest, rows, { split: "holdout" });
    assert.equal(summaries[0].scoredCount, 5);
    assert.equal(summaries[0].overall, (0 + 0 + 1 + 0 + 1) / 5);
  });

  it("visible-count chips: staleRowSummary reports per-task counts + version", () => {
    const summary = staleRowSummary(rows, bumps);
    assert.equal(summary.staleCount, 3);
    assert.deepEqual(summary.byTask, [{ task_id: "t1", count: 3, version: "2.0.0" }]);
  });

  it("no versions.jsonl task bumps => nothing stale", () => {
    const legacyOnly = latestBreakingBumps([versions[0]]);
    assert.equal(staleRowSummary(rows, legacyOnly).staleCount, 0);
  });
});

describe("hash/version row stamps (preferred over created_at when both sides carry them)", () => {
  const hashes = { env_sha256: "a".repeat(64), verifier_sha256: "b".repeat(64), meta_sha256: "c".repeat(64) };
  // Current task definitions as the leaderboard sees them (manifest tasks
  // carrying version + content_hashes stamps).
  const currentTasks = tasksByIdForStaleness([
    { task_id: "t1", version: "2.0.0", content_hashes: hashes },
    { task_id: "t2", version: "1.0.1" },
  ]);
  const bumps = latestBreakingBumps(versions); // t1 has a major bump at 2026-02-01

  it("env/verifier hash mismatch is decisive stale even for post-bump rows", () => {
    const mismatch = row({
      created_at: "2026-03-01T00:00:00Z", // after the bump — timestamp gate would say fresh
      provenance: { task_content_hashes: { ...hashes, env_sha256: "d".repeat(64) } },
    });
    assert.equal(isRowStale(mismatch, bumps, currentTasks), true);
    const verifierMoved = row({
      created_at: "2026-03-01T00:00:00Z",
      provenance: { task_content_hashes: { ...hashes, verifier_sha256: "d".repeat(64) } },
    });
    assert.equal(isRowStale(verifierMoved, bumps, currentTasks), true);
  });

  it("meta-only hash drift never stales a row", () => {
    const metaOnly = row({
      created_at: "2026-03-01T00:00:00Z",
      provenance: { task_content_hashes: { ...hashes, meta_sha256: "d".repeat(64) } },
    });
    assert.equal(isRowStale(metaOnly, bumps, currentTasks), false);
  });

  it("a matching stamp rescues rows without created_at (conservatively stale before stamping)", () => {
    const undatedStamped = row({ created_at: null, provenance: { task_content_hashes: hashes } });
    assert.equal(isRowStale(undatedStamped, bumps, currentTasks), false);
    const undatedUnstamped = row({ created_at: null });
    assert.equal(isRowStale(undatedUnstamped, bumps, currentTasks), true);
  });

  it("a matching stamp does NOT rescue rows predating a breaking bump (regrade supersession)", () => {
    // A regrade appends a MINOR bump without changing task content: the
    // superseded rows stamp-match the current task but must stay stale.
    const preBumpMatch = row({ created_at: "2026-01-10T00:00:00Z", provenance: { task_content_hashes: hashes } });
    assert.equal(isRowStale(preBumpMatch, bumps, currentTasks), true);
  });

  it("version stamps fall back to major.minor comparison when hashes are absent", () => {
    const patchOnly = row({ task_id: "t2", created_at: null, provenance: { task_version: "1.0.0" } });
    assert.equal(isRowStale(patchOnly, bumps, currentTasks), false); // 1.0.x == 1.0.x
    const minorBehind = row({ task_id: "t2", created_at: "2026-03-01T00:00:00Z", provenance: { task_version: "0.9.0" } });
    assert.equal(isRowStale(minorBehind, bumps, currentTasks), true);
  });

  it("staleRowSummary threads currentTasks and reports the current version on chips", () => {
    const staleRows = [row({ created_at: "2026-03-01T00:00:00Z", provenance: { task_content_hashes: { ...hashes, env_sha256: "d".repeat(64) } } })];
    const summary = staleRowSummary(staleRows, bumps, currentTasks);
    assert.equal(summary.staleCount, 1);
    assert.deepEqual(summary.byTask, [{ task_id: "t1", count: 1, version: "2.0.0" }]);
  });
});
