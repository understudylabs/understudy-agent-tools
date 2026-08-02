import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  FROZEN_TRAIN_SHA256,
  MEETING_ORCHESTRATOR_SUBSET,
  TASKS,
} from "../dist/workloads/on-event-meeting-orchestrator/offline.js";

const VALIDATOR = resolve("scripts/wl-on-event-meeting-orchestrator/dpo-pairs-validate.mjs");
const MINER = resolve("scripts/wl-on-event-meeting-orchestrator/mine-dpo-pairs.mjs");
const trainTask = TASKS.find((task) => task.split === "train");
const holdoutTask = TASKS.find((task) => task.split === "holdout");

function runGate(rows, manifestOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wl-meeting-dpo-"));
  const pairsPath = join(dir, "pairs.jsonl");
  const manifestPath = join(dir, "manifest.json");
  const outPath = join(dir, "normalized.jsonl");
  const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  writeFileSync(pairsPath, body);
  writeFileSync(manifestPath, JSON.stringify({
    source: "synthetic-offline-fixture",
    split: "train",
    fixture_id: MEETING_ORCHESTRATOR_SUBSET.fixture_id,
    train_split_sha256: FROZEN_TRAIN_SHA256,
    pairs_sha256: createHash("sha256").update(body).digest("hex"),
    ...manifestOverrides,
  }));
  const result = spawnSync(process.execPath, [VALIDATOR, "--pairs", pairsPath, "--manifest", manifestPath, "--out", outPath], { encoding: "utf8" });
  return { result, report: JSON.parse(result.stdout) };
}

function pair(taskId, chosen = "call A", rejected = "call B") {
  return { task_id: taskId, prompt: "Handle the meeting event.", chosen, rejected };
}

describe("workload DPO validation gate", () => {
  it("accepts a synthetic train pair and emits the trainer contract", () => {
    const { result, report } = runGate([pair(trainTask.taskId)]);
    assert.equal(result.status, 0);
    assert.equal(report.verdict, "pass");
    assert.equal(report.fixture_id, MEETING_ORCHESTRATOR_SUBSET.fixture_id);
  });

  it("rejects holdout and unknown task ids", () => {
    const holdout = runGate([pair(holdoutTask.taskId)]);
    assert.equal(holdout.result.status, 1);
    assert.match(JSON.stringify(holdout.report.failures), /LEAKAGE/);
    const unknown = runGate([pair("meeting-single-schedule-99")]);
    assert.equal(unknown.result.status, 1);
    assert.match(JSON.stringify(unknown.report.failures), /not in the meeting orchestrator fixture/);
  });

  it("rejects another fixture, hash mismatch, and private identifiers", () => {
    const wrongFixture = runGate([pair(trainTask.taskId)], { fixture_id: "other-workload-v1" });
    assert.equal(wrongFixture.result.status, 1);
    assert.match(JSON.stringify(wrongFixture.report.failures), /fixture_id/);
    const wrongHash = runGate([pair(trainTask.taskId)], { pairs_sha256: "0".repeat(64) });
    assert.equal(wrongHash.result.status, 1);
    assert.match(JSON.stringify(wrongHash.report.failures), /pairs_sha256/);
    const privateToken = ["org_", "0123456789ABCDEFGHIJKLMNOP"].join("");
    const privateRow = runGate([pair(trainTask.taskId, `chosen ${privateToken}`, "rejected")]);
    assert.equal(privateRow.result.status, 1);
    assert.match(JSON.stringify(privateRow.report.failures), /private-looking identifier/);
  });

  it("rejects no-signal pairs", () => {
    const { result, report } = runGate([pair(trainTask.taskId, "same", "same")]);
    assert.equal(result.status, 1);
    assert.match(JSON.stringify(report.failures), /no preference signal/);
  });
});

describe("outcome-changing DPO mining", () => {
  it("drops cosmetic-only siblings and keeps effective call differences", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-meeting-mine-"));
    const runPath = join(dir, "run.json");
    const outPath = join(dir, "pairs.jsonl");
    const manifestPath = join(dir, "manifest.json");
    const trajectory = (content) => [
      { role: "system", content: "system" },
      { role: "user", content: trainTask.prompt },
      { role: "assistant", content },
    ];
    writeFileSync(runPath, JSON.stringify({
      split: "train",
      fixture_id: MEETING_ORCHESTRATOR_SUBSET.fixture_id,
      split_sha256: FROZEN_TRAIN_SHA256,
      rows: [
        { task_id: trainTask.taskId, sample_index: 0, score: 1, forbidden_effects: 0, trajectory: trajectory('{"tool":"finish"}') },
        { task_id: trainTask.taskId, sample_index: 1, score: 0.5, forbidden_effects: 0, trajectory: trajectory('{"tool":"api_fetch","arguments":{"method":"GET","url":"/meetings"}}') },
        { task_id: trainTask.taskId, sample_index: 2, score: 0.5, forbidden_effects: 0, trajectory: trajectory('{"tool":"finish"}') },
      ],
    }));
    const result = spawnSync(process.execPath, [MINER, "--run", runPath, "--out", outPath, "--manifest", manifestPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.pair_count, 1);
    assert.equal(report.dropped_cosmetic_only, 1);
    const mined = readFileSync(outPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.notEqual(mined[0].chosen[0].content, mined[0].rejected[0].content);
  });
});
