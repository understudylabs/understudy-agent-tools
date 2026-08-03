import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  DOMAIN_ID_TASKS,
  domainIdFixtureSha256,
  domainIdSplitSha256,
} from "../dist/domain-identification-slice.js";

const SCRIPT = resolve("experiments/domain-identification-repair/validate-pairs.mjs");
const FIXTURE_SHA256 = domainIdFixtureSha256();
const TRAIN_SPLIT_SHA256 = domainIdSplitSha256("train");
const trainTasks = DOMAIN_ID_TASKS.filter((task) => task.split === "train");

function pair(taskId, family, suffix) {
  return {
    task_id: taskId,
    family,
    fixture_sha256: FIXTURE_SHA256,
    prompt_conversation: [{ role: "user", content: `route ${taskId}` }],
    chosen: [{ role: "assistant", content: `chosen ${suffix}` }],
    rejected: [{ role: "assistant", content: `rejected ${suffix}` }],
    chosen_score: 1,
    rejected_score: 0.5,
    rejected_forbidden_writes: suffix.length % 2,
  };
}

function runGate(rows, manifestOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "domain-id-dpo-pairs-"));
  const pairsPath = join(dir, "pairs.jsonl");
  const manifestPath = join(dir, "manifest.json");
  const outPath = join(dir, "normalized.jsonl");
  const reportPath = join(dir, "report.json");
  const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  writeFileSync(pairsPath, body);
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      source: "synthetic offline fixture",
      fixture_id: "domain-identification-offline-v1",
      fixture_sha256: FIXTURE_SHA256,
      split: "train",
      train_split_sha256: TRAIN_SPLIT_SHA256,
      pairs_sha256: createHash("sha256").update(body).digest("hex"),
      ...manifestOverrides,
    })}\n`,
  );
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--pairs", pairsPath,
    "--manifest", manifestPath,
    "--out", outPath,
    "--report", reportPath,
  ], { encoding: "utf8" });
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  return { result, outPath, report };
}

describe("domain-identification DPO pair validation", () => {
  it("refuses a manifest bound to the old fixture", () => {
    const task = trainTasks.find((entry) => entry.taskId === "domain-id-direct-route-01");
    const { result, report } = runGate(
      [pair(task.taskId, "direct-route", "old-fixture")],
      { fixture_sha256: "7d8a213753820f7c5fcd2c65521c5c866366020bb1b361ae19c5aff11777c3d5" },
    );
    assert.equal(result.status, 1);
    assert.equal(report.verdict, "fail");
    assert.match(JSON.stringify(report.failures), /manifest fixture_sha256 missing\/stale vs runtime fixture/);
  });

  it("binds accepted rows and reports to the current fixture and train split", () => {
    const rows = [
      pair("domain-id-direct-route-01", "direct-route", "binding-direct"),
      pair("domain-id-lookalike-route-01", "lookalike-route", "binding-lookalike"),
      pair("domain-id-parent-route-01", "parent-route", "binding-parent"),
      pair("domain-id-unmatched-abstain-01", "unmatched-abstain", "binding-unmatched"),
    ];
    const { result, outPath, report } = runGate(rows);
    assert.equal(result.status, 0);
    assert.equal(report.verdict, "pass");
    assert.equal(report.fixture_sha256, FIXTURE_SHA256);
    assert.equal(report.train_split_sha256, TRAIN_SPLIT_SHA256);
    const normalized = readFileSync(outPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(normalized.length, rows.length);
    assert.ok(normalized.every((row) => row.fixture_sha256 === FIXTURE_SHA256));
  });

  it("refuses dev or holdout task leakage", () => {
    const { result, report } = runGate([
      pair("domain-id-lookalike-route-07", "lookalike-route", "dev-leak"),
    ]);
    assert.equal(result.status, 1);
    assert.equal(report.verdict, "fail");
    assert.match(JSON.stringify(report.failures), /LEAKAGE/);
  });

  it("fails closed when unbalanceable and caps a balanceable family skew", () => {
    const skewed = trainTasks
      .filter((entry) => entry.taskId.startsWith("domain-id-lookalike-route-"))
      .map((entry, index) => pair(entry.taskId, "lookalike-route", `unbalanceable-${index}`));
    const unbalanceable = runGate(skewed);
    assert.equal(unbalanceable.result.status, 1);
    assert.equal(unbalanceable.report.verdict, "fail");
    assert.match(JSON.stringify(unbalanceable.report.failures), /skewed_family_unbalanceable/);

    const balanceable = [
      pair("domain-id-lookalike-route-01", "lookalike-route", "cap-lookalike-1"),
      pair("domain-id-lookalike-route-02", "lookalike-route", "cap-lookalike-2"),
      pair("domain-id-lookalike-route-03", "lookalike-route", "cap-lookalike-3"),
      pair("domain-id-lookalike-route-04", "lookalike-route", "cap-lookalike-4"),
      pair("domain-id-direct-route-01", "direct-route", "cap-direct-1"),
      pair("domain-id-direct-route-02", "direct-route", "cap-direct-2"),
      pair("domain-id-parent-route-01", "parent-route", "cap-parent-1"),
      pair("domain-id-parent-route-02", "parent-route", "cap-parent-2"),
    ];
    const capped = runGate(balanceable);
    assert.equal(capped.result.status, 0);
    assert.equal(capped.report.verdict, "pass");
    assert.equal(capped.report.balance_capped, true);
    assert.equal(capped.report.dropped_for_balance, 2);
    assert.ok(Object.values(capped.report.family_counts_final).every(
      (count) => count <= Math.floor(0.35 * capped.report.accepted),
    ));
  });
});
