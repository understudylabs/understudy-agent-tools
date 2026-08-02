import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { ANALYZER_TASKS, analyzerSplitSha256, oraclePolicy } from "../dist/analyzer-slice.js";

const dir = () => mkdtempSync(join(tmpdir(), "analyzer-dpo-"));
const runScript = resolve("scripts/analyzer-dpo-pairs-validate.mjs");
const minerScript = resolve("scripts/analyzer-dpo-mine-pairs.mjs");
const trainTask = ANALYZER_TASKS.find((task) => task.split === "train");
const holdoutTask = ANALYZER_TASKS.find((task) => task.split === "holdout");

function writeManifest(folder, body, overrides = {}) {
  const pairs = join(folder, "pairs.jsonl");
  const manifest = join(folder, "manifest.json");
  writeFileSync(pairs, body);
  writeFileSync(manifest, JSON.stringify({
    source: "synthetic analyzer offline fixture",
    split: "train",
    fixture_id: "analyzer-verdict-offline-v1",
    train_split_sha256: analyzerSplitSha256("train"),
    pairs_sha256: createHash("sha256").update(body).digest("hex"),
    ...overrides,
  }));
  return { pairs, manifest };
}

function pair(taskId, chosen = "chosen", rejected = "rejected") {
  return {
    task_id: taskId,
    prompt_conversation: [{ role: "system", content: "synthetic prompt" }],
    chosen: [{ role: "assistant", content: chosen }],
    rejected: [{ role: "assistant", content: rejected }],
  };
}

function validate(rows, overrides = {}) {
  const folder = dir();
  const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const { pairs, manifest } = writeManifest(folder, body, overrides);
  const out = join(folder, "normalized.jsonl");
  const report = join(folder, "report.json");
  const result = spawnSync(process.execPath, [runScript, "--pairs", pairs, "--manifest", manifest, "--out", out, "--report", report], { encoding: "utf8" });
  return { result, report: JSON.parse(readFileSync(report, "utf8")), out };
}

function fakeRun(folder, split = "train") {
  const task = trainTask;
  const gold = oraclePolicy(task.taskId)(task);
  const near = JSON.stringify({ ...task.gold, status: task.gold.status === "on_track" ? "at_risk" : "on_track" });
  const overClaim = JSON.stringify({ ...task.gold, citations: [...task.gold.citations, task.evidence.find((item) => !task.gold.citations.includes(item.id)).id] });
  const rows = [
    { task_id: task.taskId, family: task.family, band: task.band, split, sample_index: 0, score: 1, forbidden: [], flags: {}, raw_output: gold, prompt_conversation: [{ role: "system", content: task.prompt }] },
    { task_id: task.taskId, family: task.family, band: task.band, split, sample_index: 1, score: 0.75, forbidden: [], flags: {}, raw_output: near, prompt_conversation: [{ role: "system", content: task.prompt }] },
    { task_id: task.taskId, family: task.family, band: task.band, split, sample_index: 2, score: 0, forbidden: ["over_claim"], flags: { over_claim: true }, raw_output: overClaim, prompt_conversation: [{ role: "system", content: task.prompt }] },
  ];
  const path = join(folder, "run.json");
  writeFileSync(path, JSON.stringify({ fixture_id: "analyzer-verdict-offline-v1", split, split_sha256: analyzerSplitSha256(split), rows }));
  return path;
}

describe("analyzer DPO phase-two scripts", () => {
  it("mines, validates, and represents over-claim rejections", () => {
    const folder = dir();
    const run = fakeRun(folder);
    const pairs = join(folder, "mined.jsonl");
    const manifest = join(folder, "mined-manifest.json");
    const mined = spawnSync(process.execPath, [minerScript, "--run", run, "--out", pairs, "--manifest", manifest, "--max-per-task", "3", "--seed", "9"], { encoding: "utf8" });
    assert.equal(mined.status, 0, mined.stderr);
    const manifestData = JSON.parse(readFileSync(manifest, "utf8"));
    assert.ok(manifestData.rejection_reason_counts.over_claim >= 1);
    const normalized = join(folder, "normalized.jsonl");
    const report = join(folder, "validation.json");
    const validated = spawnSync(process.execPath, [runScript, "--pairs", pairs, "--manifest", manifest, "--out", normalized, "--report", report], { encoding: "utf8" });
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(JSON.parse(readFileSync(report, "utf8")).verdict, "pass");
    const row = JSON.parse(readFileSync(normalized, "utf8").trim().split("\n")[0]);
    assert.equal(row.split, "train");
    assert.ok(Array.isArray(row.prompt_conversation));
    assert.ok(Array.isArray(row.chosen) && Array.isArray(row.rejected));
  });

  it("refuses a dev or holdout run artifact for mining", () => {
    const folder = dir();
    const run = fakeRun(folder, "holdout");
    const result = spawnSync(process.execPath, [minerScript, "--run", run, "--out", join(folder, "pairs.jsonl"), "--manifest", join(folder, "manifest.json")], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /non-train/);
  });

  it("refuses holdout task IDs and train-hash mismatches", () => {
    const holdout = validate([pair(holdoutTask.taskId)]);
    assert.equal(holdout.result.status, 1);
    assert.match(JSON.stringify(holdout.report.failures), /LEAKAGE/);
    const mismatch = validate([pair(trainTask.taskId)], { train_split_sha256: "0".repeat(64) });
    assert.equal(mismatch.result.status, 1);
    assert.match(JSON.stringify(mismatch.report.failures), /hash mismatch/);
  });

  it("refuses source, identity, duplicate, and empty-pair violations", () => {
    assert.equal(validate([pair(trainTask.taskId)], { source: "production export" }).result.status, 1);
    assert.equal(validate([pair(trainTask.taskId, `x for ${"org_" + "x".repeat(24)}`, "y")]).result.status, 1);
    assert.equal(validate([pair(trainTask.taskId, "same", "same")]).result.status, 1);
    assert.equal(validate([pair(trainTask.taskId), pair(trainTask.taskId)]).result.status, 1);
    assert.equal(validate([]).result.status, 1);
  });
});
