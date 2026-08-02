import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const SCRIPT = resolve("scripts/oee-dpo-mine-pairs.mjs");
const baseReport = JSON.parse(readFileSync("outputs/oee/base-train-rollouts.json", "utf8"));
const transcriptLines = readFileSync("outputs/oee/base-train-rollouts.transcripts.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const rowsByTask = new Map();
for (const row of baseReport.rows) {
  const list = rowsByTask.get(row.task_id) ?? [];
  list.push(row);
  rowsByTask.set(row.task_id, list);
}
const transcriptByKey = new Map(transcriptLines.map((entry) => [`${entry.task_id}#${entry.rollout_index}`, entry]));

function assistantMessages(transcript) {
  return transcript.messages.filter((message) => message.role === "assistant");
}

function corpusDir(rows) {
  const dir = mkdtempSync(join(tmpdir(), "oee-dpo-mine-"));
  const rolloutsPath = join(dir, "rollouts.json");
  const transcriptsPath = join(dir, "transcripts.jsonl");
  writeFileSync(rolloutsPath, `${JSON.stringify({ rows }, null, 2)}\n`);
  writeFileSync(
    transcriptsPath,
    `${rows
      .map((row) => transcriptByKey.get(`${row.task_id}#${row.rollout_index}`))
      .filter(Boolean)
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  return { dir, rolloutsPath, transcriptsPath };
}

function runMiner(rows, options = {}) {
  const { dir, rolloutsPath, transcriptsPath } = corpusDir(rows);
  const outDir = join(dir, "out");
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--rollouts-json", rolloutsPath, "--transcripts", transcriptsPath, "--out-dir", outDir],
    { encoding: "utf8" },
  );
  const pairsPath = join(outDir, "dpo_pairs.jsonl");
  const manifestPath = join(outDir, "manifest.json");
  const pairs = result.status === 0 && !options.skipReadPairs
    ? readFileSync(pairsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { result, pairs, manifestPath };
}

describe("oee dpo pair miner", () => {
  it("rejects cosmetic-only diffs that replay to the same final state", () => {
    const task = "oee-oee-extended-chain-14";
    const base = rowsByTask.get(task).find((row) => row.score === 1);
    const transcript = transcriptByKey.get(`${base.task_id}#${base.rollout_index}`);
    const rows = [
      { ...base, rollout_index: 900, score: 1 },
      { ...base, rollout_index: 901, score: 0.5 },
    ];
    const dir = mkdtempSync(join(tmpdir(), "oee-dpo-cosmetic-"));
    const rolloutsPath = join(dir, "rollouts.json");
    const transcriptsPath = join(dir, "transcripts.jsonl");
    writeFileSync(rolloutsPath, `${JSON.stringify({ rows }, null, 2)}\n`);
    writeFileSync(
      transcriptsPath,
      `${[
        { ...transcript, rollout_index: 900 },
        { ...transcript, rollout_index: 901 },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    const outDir = join(dir, "out");
    const result = spawnSync(process.execPath, [SCRIPT, "--rollouts-json", rolloutsPath, "--transcripts", transcriptsPath, "--out-dir", outDir], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /no usable pairs/i);
  });

  it("rejects non-train rows closed", () => {
    const task = "oee-oee-bounded-ack-01";
    const base = rowsByTask.get(task).find((row) => row.score === 1);
    const transcript = transcriptByKey.get(`${base.task_id}#${base.rollout_index}`);
    const rows = [{ ...base, split: "dev", rollout_index: 902 }];
    const dir = mkdtempSync(join(tmpdir(), "oee-dpo-dev-"));
    const rolloutsPath = join(dir, "rollouts.json");
    const transcriptsPath = join(dir, "transcripts.jsonl");
    writeFileSync(rolloutsPath, `${JSON.stringify({ rows }, null, 2)}\n`);
    writeFileSync(transcriptsPath, `${JSON.stringify({ ...transcript, rollout_index: 902, split: "dev" })}\n`);
    const outDir = join(dir, "out");
    const result = spawnSync(process.execPath, [SCRIPT, "--rollouts-json", rolloutsPath, "--transcripts", transcriptsPath, "--out-dir", outDir], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /non-train rollout/i);
  });

  it("prefers the highest-scoring failing sibling", () => {
    const task = "oee-oee-variable-fanout-03";
    const rows = rowsByTask
      .get(task)
      .slice()
      .sort((a, b) => a.rollout_index - b.rollout_index)
      .map((row) => ({ ...row }));
    const { result, pairs } = runMiner(rows);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(pairs.length, 1);
    const chosen = assistantMessages(transcriptByKey.get(`${task}#3`));
    const rejected = assistantMessages(transcriptByKey.get(`${task}#2`));
    assert.deepEqual(pairs[0].chosen, chosen);
    assert.deepEqual(pairs[0].rejected, rejected);
    assert.equal(pairs[0].task_id, task);
  });
});
