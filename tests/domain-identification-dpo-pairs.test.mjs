import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  domainIdFixtureSha256,
  domainIdSplitSha256,
} from "../dist/domain-identification-slice.js";

const VALIDATOR = resolve("experiments/domain-identification-repair/validate-pairs.mjs");
const MINER = resolve("experiments/domain-identification-repair/mine-pairs.mjs");

const TRAIN_IDS = {
  direct: "domain-id-direct-route-01",
  lookalike: "domain-id-lookalike-route-01",
  parent: "domain-id-parent-route-01",
  unmatched: "domain-id-unmatched-abstain-01",
};

function pair(taskId, suffix = "", rejectedForbidden = 0) {
  return {
    task_id: taskId,
    fixture_sha256: domainIdFixtureSha256(),
    train_split_sha256: domainIdSplitSha256("train"),
    prompt_conversation: [{ role: "user", content: `prompt ${suffix}` }],
    chosen: [{ role: "assistant", content: `chosen ${suffix}` }],
    rejected: [{ role: "assistant", content: `rejected ${suffix}` }],
    chosen_score: 1,
    chosen_forbidden_writes: 0,
    rejected_score: 0,
    rejected_forbidden_writes: rejectedForbidden,
  };
}

function runValidator(rows, manifestOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "domain-dpo-validate-"));
  const pairsPath = join(dir, "pairs.jsonl");
  const manifestPath = join(dir, "manifest.json");
  const outPath = join(dir, "train.jsonl");
  const reportPath = join(dir, "report.json");
  const bytes = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  writeFileSync(pairsPath, bytes);
  writeFileSync(manifestPath, `${JSON.stringify({
    source: "synthetic fixture",
    split: "train",
    fixture_sha256: domainIdFixtureSha256(),
    train_split_sha256: domainIdSplitSha256("train"),
    pairs_sha256: createHash("sha256").update(bytes).digest("hex"),
    ...manifestOverrides,
  })}\n`);
  const result = spawnSync(process.execPath, [
    VALIDATOR, "--pairs", pairsPath, "--manifest", manifestPath,
    "--out", outPath, "--report", reportPath,
  ], { encoding: "utf8" });
  return { result, report: JSON.parse(readFileSync(reportPath, "utf8")), outPath };
}

describe("domain identification Wave 8 DPO pre-spend gate", () => {
  it("accepts exact fixture/split provenance and summarizes rejected forbidden writes", () => {
    const rows = [
      pair(TRAIN_IDS.direct, "a", 2), pair(TRAIN_IDS.lookalike, "b"),
      pair(TRAIN_IDS.parent, "c"), pair(TRAIN_IDS.unmatched, "d"),
    ];
    const { result, report, outPath } = runValidator(rows);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.verdict, "pass");
    assert.equal(report.fixture_sha256, domainIdFixtureSha256());
    assert.deepEqual(report.rejected_forbidden_writes, { pairs: 1, total: 2, max: 2 });
    assert.equal(existsSync(outPath), true);
  });

  it("fails a stale fixture manifest without emitting trainable output", () => {
    const rows = Object.values(TRAIN_IDS).map((id, index) => pair(id, String(index)));
    const { result, report, outPath } = runValidator(rows, { fixture_sha256: "0".repeat(64) });
    assert.equal(result.status, 1);
    assert.match(JSON.stringify(report.failures), /fixture_sha256/);
    assert.equal(existsSync(outPath), false);
  });

  it("requires the exact train split hash", () => {
    const rows = Object.values(TRAIN_IDS).map((id, index) => pair(id, String(index)));
    const { result, report, outPath } = runValidator(rows, { train_split_sha256: undefined });
    assert.equal(result.status, 1);
    assert.match(JSON.stringify(report.failures), /train_split_sha256/);
    assert.equal(existsSync(outPath), false);
  });

  it("fails stale row-level fixture provenance", () => {
    const rows = Object.values(TRAIN_IDS).map((id, index) => pair(id, String(index)));
    rows[0].fixture_sha256 = "0".repeat(64);
    const { result, report, outPath } = runValidator(rows);
    assert.equal(result.status, 1);
    assert.match(JSON.stringify(report.failures), /row fixture_sha256/);
    assert.equal(existsSync(outPath), false);
  });

  it("fails dev or holdout provenance closed", () => {
    const rows = [
      pair(TRAIN_IDS.direct, "a"), pair(TRAIN_IDS.lookalike, "b"),
      pair(TRAIN_IDS.parent, "c"), pair("domain-id-direct-route-07", "dev"),
    ];
    const { result, report, outPath } = runValidator(rows);
    assert.equal(result.status, 1);
    assert.match(JSON.stringify(report.failures), /LEAKAGE.*dev/);
    assert.equal(existsSync(outPath), false);
  });

  it("fails deterministic admission when one family exceeds 35%", () => {
    const rows = [
      pair(TRAIN_IDS.direct, "a"), pair("domain-id-direct-route-02", "b"),
      pair(TRAIN_IDS.lookalike, "c"), pair(TRAIN_IDS.parent, "d"),
      pair(TRAIN_IDS.unmatched, "e"),
    ];
    const { result, report, outPath } = runValidator(rows);
    assert.equal(result.status, 1);
    assert.match(JSON.stringify(report.failures), /family balance exceeds 35%/);
    assert.equal(existsSync(outPath), false);
  });

  it("miner reports insufficient-balanced-pool and emits no pair artifact", () => {
    const source = JSON.parse(readFileSync(
      "experiments/domain-identification-repair/outputs/dpo_pairs.jsonl", "utf8",
    ).split("\n").find(Boolean));
    const winner = {
      task_id: source.task_id, score: 1, forbidden_effects: 0,
      transcript: [...source.prompt_conversation, ...source.chosen],
    };
    const loser = {
      task_id: source.task_id, score: source.rejected_score, forbidden_effects: source.rejected_forbidden_writes,
      transcript: [...source.prompt_conversation, ...source.rejected],
    };
    const dir = mkdtempSync(join(tmpdir(), "domain-dpo-mine-"));
    const transcripts = join(dir, "episodes.jsonl");
    const out = join(dir, "pairs.jsonl");
    const manifest = join(dir, "manifest.json");
    writeFileSync(transcripts, `${JSON.stringify(winner)}\n${JSON.stringify(loser)}\n`);
    const result = spawnSync(process.execPath, [
      MINER, "--transcripts", transcripts, "--out", out, "--manifest", manifest,
    ], { encoding: "utf8" });
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(readFileSync(manifest, "utf8"));
    assert.equal(receipt.family_balance.status, "insufficient_balanced_pool");
    assert.equal(receipt.fixture_sha256, domainIdFixtureSha256());
    assert.equal(existsSync(out), false);
  });
});
