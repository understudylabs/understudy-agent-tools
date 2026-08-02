import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { V2_TASKS, v2SplitSha256 } from "../dist/automationbench-v2.js";
import { TASKS as CHAT_TASKS, splitSha256 as chatSplitSha256 } from "../dist/grounded-chat-offline.js";

const SCRIPT = resolve("scripts/dpo-pairs-validate.mjs");
const trainTasks = V2_TASKS.filter((task) => task.split === "train");
const holdoutTask = V2_TASKS.find((task) => task.split === "holdout");

function pair(taskId, chosen, rejected) {
  return {
    task_id: taskId,
    prompt: "route the ticket to the requester's contact owner",
    chosen,
    rejected,
  };
}

/** Write a pairs file plus a manifest whose hash matches it, then run the gate. */
function runGate(rows, manifestOverrides = {}, fixture = "automationbench-v2") {
  const dir = mkdtempSync(join(tmpdir(), "dpo-pairs-"));
  const pairsPath = join(dir, "dpo_pairs.jsonl");
  const manifestPath = join(dir, "manifest.json");
  const outPath = join(dir, "normalized.jsonl");
  const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  writeFileSync(pairsPath, body);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      source: "synthetic-offline-fixture",
      split: "train",
      pairs_sha256: createHash("sha256").update(body).digest("hex"),
      train_split_sha256: fixture === "grounded-chat-offline-v1" ? chatSplitSha256("train") : v2SplitSha256("train"),
      ...manifestOverrides,
    }),
  );
  const result = spawnSync(process.execPath, [
    SCRIPT, "--pairs", pairsPath, "--manifest", manifestPath, "--out", outPath,
    ...(fixture === "automationbench-v2" ? [] : ["--fixture", fixture]),
  ], {
    encoding: "utf8",
  });
  return { result, outPath, report: JSON.parse(result.stdout) };
}

describe("dpo pairs validation gate", () => {
  it("accepts synthetic train-split pairs and normalizes them", () => {
    const rows = [
      pair(trainTasks[0].taskId, "chosen A", "rejected A"),
      pair(trainTasks[1].taskId, [{ role: "assistant", content: "chosen B" }], [{ role: "assistant", content: "rejected B" }]),
    ];
    const { result, outPath, report } = runGate(rows);
    assert.equal(result.status, 0);
    assert.equal(report.verdict, "pass");
    assert.equal(report.accepted, 2);
    const normalized = readFileSync(outPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(normalized.length, 2);
    for (const row of normalized) {
      assert.equal(row.split, "train");
      assert.ok(Array.isArray(row.prompt_conversation) && row.prompt_conversation.length > 0);
      assert.equal(row.chosen[0].role, "assistant");
    }
  });

  it("refuses a holdout task id as leakage", () => {
    const { result, report } = runGate([pair(holdoutTask.taskId, "chosen", "rejected")]);
    assert.equal(result.status, 1);
    assert.equal(report.verdict, "fail");
    assert.match(report.failures[0].reason, /LEAKAGE/);
  });

  it("refuses a manifest whose hash does not match the pairs file", () => {
    const { result, report } = runGate([pair(trainTasks[0].taskId, "chosen", "rejected")], { pairs_sha256: "0".repeat(64) });
    assert.equal(result.status, 1);
    assert.match(JSON.stringify(report.failures), /pairs_sha256/);
  });

  it("refuses pairs that do not declare a synthetic source", () => {
    const { result, report } = runGate([pair(trainTasks[0].taskId, "chosen", "rejected")], { source: "production-traces" });
    assert.equal(result.status, 1);
    assert.match(JSON.stringify(report.failures), /synthetic/);
  });

  it("refuses a row carrying a tenant identifier", () => {
    const row = pair(trainTasks[0].taskId, "chosen for org_0123456789ABCDEFGHIJKLMNOP", "rejected");
    const { result, report } = runGate([row]);
    assert.equal(result.status, 1);
    assert.match(JSON.stringify(report.failures), /private-looking identifier/);
  });

  it("refuses a pair whose chosen and rejected are identical", () => {
    const { result, report } = runGate([pair(trainTasks[0].taskId, "same", "same")]);
    assert.equal(result.status, 1);
    assert.match(JSON.stringify(report.failures), /no preference signal/);
  });

  it("refuses an unknown task id", () => {
    const { result, report } = runGate([pair("simple-api-not-a-real-task-99", "chosen", "rejected")]);
    assert.equal(result.status, 1);
    assert.match(JSON.stringify(report.failures), /not in the v2 fixture/);
  });

  it("accepts grounded-chat train-split pairs through the fixture flag", () => {
    const task = CHAT_TASKS.find((candidate) => candidate.split === "train");
    const { result, report } = runGate([
      {
        task_id: task.taskId,
        prompt: [{ role: "user", content: `${task.context}\n\n${task.question}` }],
        chosen: "role: navigator",
        rejected: "role: archivist",
      },
    ], { fixture_id: "grounded-chat-offline-v1" }, "grounded-chat-offline-v1");
    assert.equal(result.status, 0);
    assert.equal(report.verdict, "pass");
    assert.equal(report.fixture_id, "grounded-chat-offline-v1");
    assert.equal(report.accepted, 1);
  });
});
