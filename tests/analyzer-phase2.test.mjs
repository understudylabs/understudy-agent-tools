import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const folder = () => mkdtempSync(join(tmpdir(), "analyzer-report-"));
const reportScript = resolve("scripts/analyzer-band-report.mjs");

function artifact(path, split, splitSha, rows) {
  writeFileSync(path, JSON.stringify({ fixture_id: "analyzer-verdict-offline-v1", split, split_sha256: splitSha, rows }));
}

describe("analyzer band report", () => {
  it("refuses mismatched split artifacts", () => {
    const dir = folder();
    const base = join(dir, "base.json");
    const candidate = join(dir, "candidate.json");
    artifact(base, "dev", "a", [{ task_id: "analyzer-owner-unresponsive-01", band: "single-signal", score: 1, forbidden: [] }]);
    artifact(candidate, "holdout", "b", [{ task_id: "analyzer-owner-unresponsive-01", band: "single-signal", score: 1, forbidden: [] }]);
    const result = spawnSync(process.execPath, [reportScript, "--base", base, "--candidate", candidate], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /different split/);
  });

  it("prints an explicit over-claim regression verdict", () => {
    const dir = folder();
    const base = join(dir, "base.json");
    const candidate = join(dir, "candidate.json");
    const rows = [{ task_id: "analyzer-owner-unresponsive-01", band: "single-signal", score: 1, forbidden: [] }];
    artifact(base, "dev", "same", rows);
    artifact(candidate, "dev", "same", [{ ...rows[0], score: 0, forbidden: ["over_claim"] }]);
    const result = spawnSync(process.execPath, [reportScript, "--base", base, "--candidate", candidate], { encoding: "utf8" });
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.match(report.verdict, /REGRESSION/);
    assert.equal(report.overall.candidate.over_claim_episodes, 1);
  });

  it("excludes request errors from scoring while surfacing their count", () => {
    const dir = folder();
    const base = join(dir, "base.json");
    const errorRow = { task_id: "analyzer-owner-unresponsive-02", band: "single-signal", score: 0, forbidden: ["request_error"] };
    artifact(base, "dev", "same", [
      { task_id: "analyzer-owner-unresponsive-01", band: "single-signal", score: 1, forbidden: [] },
      errorRow,
    ]);
    const result = spawnSync(process.execPath, [reportScript, "--base", base], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.overall.base.scored_row_count, 1);
    assert.equal(report.overall.base.request_error_episodes, 1);
    assert.equal(report.overall.base.mean_score, 1);
    assert.equal(report.overall.base.zero_count, 0);
    assert.equal(report.per_band["single-signal"].base.mean_score, 1);
  });
});
