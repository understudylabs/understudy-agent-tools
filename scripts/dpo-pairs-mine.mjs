#!/usr/bin/env node
/**
 * Mine near-hit DPO preference pairs from base rollouts on the v2 fixture's
 * TRAIN split. Reads only a rollout artifact produced by
 * `automationbench-v2-zeroshot.mjs --split train --samples N --transcripts`;
 * it never samples a model itself and never touches dev or holdout.
 *
 * Two pair types, both anchored on a shared conversation prefix so a pair
 * isolates one decision rather than a whole trajectory:
 *
 *   outcome — two sibling episodes of the same task that ended with DIFFERENT
 *     terminal scores, cut at their first divergent emission. Same-score
 *     siblings are dropped: a cosmetic wording difference is not a preference,
 *     which is the outcome-first rule applied to the training data itself.
 *
 *   format — inside one episode, an emission the environment REJECTED as
 *     malformed, against the emission the model produced at the same prefix on
 *     its retry. A rejected emission never executes, so this is a burned turn
 *     out of a fixed budget, not a cosmetic difference.
 *
 * Usage:
 *   node scripts/dpo-pairs-mine.mjs \
 *     --rollouts outputs/dpo/base-train-rollouts.json \
 *     --pairs outputs/dpo/dpo_pairs.jsonl \
 *     --manifest outputs/dpo/dpo_pairs.manifest.json [--max-per-task 6]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { v2SplitSha256 } from "../dist/automationbench-v2.js";

const FIXTURE_ID = "automationbench-simple-api-offline-v2";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const rolloutsPath = argValue("--rollouts");
if (!rolloutsPath) throw new Error("--rollouts is required");
const pairsPath = argValue("--pairs");
const manifestPath = argValue("--manifest");
const maxPerTask = Number(argValue("--max-per-task", "6"));
const minScoreGap = Number(argValue("--min-score-gap", "0.0001"));

const run = JSON.parse(readFileSync(rolloutsPath, "utf8"));
if (run.split !== "train") throw new Error(`refusing to mine pairs from the ${run.split} split`);
if (run.fixture !== FIXTURE_ID) throw new Error(`rollouts are from fixture ${run.fixture}, not ${FIXTURE_ID}`);
if (run.split_sha256 !== v2SplitSha256("train")) throw new Error("rollouts were cut against a different train split");
const rows = run.rows.filter((row) => Array.isArray(row.transcript) && row.transcript.length > 0 && typeof row.score === "number");
if (rows.length === 0) throw new Error("no scored rollouts with transcripts; re-run with --transcripts");

const byTask = new Map();
for (const row of rows) {
  if (!byTask.has(row.task_id)) byTask.set(row.task_id, []);
  byTask.get(row.task_id).push(row);
}

const pairs = [];
const stats = { outcome: 0, format: 0, tasks_with_pairs: 0, tasks_without_signal: [] };

for (const [taskId, episodes] of [...byTask.entries()].sort()) {
  const taskPairs = [];

  // outcome pairs — sibling episodes that ended differently.
  const sorted = [...episodes].sort((a, b) => b.score - a.score);
  for (const winner of sorted) {
    for (const loser of sorted) {
      if (winner.score - loser.score < minScoreGap) continue;
      let divergence = 0;
      while (
        divergence < winner.transcript.length &&
        divergence < loser.transcript.length &&
        winner.transcript[divergence].emission === loser.transcript[divergence].emission
      ) divergence += 1;
      if (divergence >= winner.transcript.length || divergence >= loser.transcript.length) continue;
      taskPairs.push({
        task_id: taskId,
        pair_type: "outcome",
        chosen_score: winner.score,
        rejected_score: loser.score,
        turn: divergence,
        prompt_conversation: winner.transcript[divergence].prefix,
        chosen: [{ role: "assistant", content: winner.transcript[divergence].emission }],
        rejected: [{ role: "assistant", content: loser.transcript[divergence].emission }],
      });
    }
  }

  // format pairs — a rejected emission against the accepted retry at the same prefix.
  for (const episode of episodes) {
    episode.transcript.forEach((turn, index) => {
      if (!turn.rejected) return;
      const retry = episode.transcript[index + 1];
      if (!retry || retry.rejected) return;
      taskPairs.push({
        task_id: taskId,
        pair_type: "format",
        chosen_score: episode.score,
        rejected_score: episode.score,
        turn: index,
        prompt_conversation: turn.prefix,
        chosen: [{ role: "assistant", content: retry.emission }],
        rejected: [{ role: "assistant", content: turn.emission }],
      });
    });
  }

  // Keep the pair set balanced: no task may dominate the objective.
  const kept = [];
  const seen = new Set();
  for (const pair of [
    ...taskPairs.filter((entry) => entry.pair_type === "outcome"),
    ...taskPairs.filter((entry) => entry.pair_type === "format"),
  ]) {
    if (kept.length >= maxPerTask) break;
    const chosenText = pair.chosen[0].content;
    const rejectedText = pair.rejected[0].content;
    if (!chosenText || !rejectedText || chosenText === rejectedText) continue;
    const key = createHash("sha256").update(JSON.stringify([pair.prompt_conversation, chosenText, rejectedText])).digest("hex");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(pair);
    stats[pair.pair_type] += 1;
  }
  if (kept.length === 0) stats.tasks_without_signal.push(taskId);
  else stats.tasks_with_pairs += 1;
  pairs.push(...kept);
}

if (pairs.length === 0) throw new Error("no preference signal in these rollouts: every sibling pair was a tie");

const body = `${pairs.map((pair) => JSON.stringify(pair)).join("\n")}\n`;
const manifest = {
  schema_version: "understudy.dpo_pairs_manifest.v1",
  generated_at: new Date().toISOString(),
  source: `synthetic fixture ${FIXTURE_ID}; base rollouts only`,
  fixture_id: FIXTURE_ID,
  split: "train",
  train_split_sha256: v2SplitSha256("train"),
  rollouts_path: rolloutsPath,
  rollout_model: run.model,
  rollout_samples_per_task: run.samples_per_task ?? null,
  rollout_temperature: run.temperature ?? null,
  rollout_max_tokens: run.max_tokens ?? null,
  pairs: pairs.length,
  pairs_by_type: { outcome: stats.outcome, format: stats.format },
  tasks_with_pairs: stats.tasks_with_pairs,
  tasks_without_signal: stats.tasks_without_signal,
  pairs_sha256: createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"),
  rollouts_sha256: createHash("sha256").update(readFileSync(rolloutsPath)).digest("hex"),
};

if (pairsPath) {
  mkdirSync(dirname(pairsPath), { recursive: true });
  writeFileSync(pairsPath, body);
}
if (manifestPath) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
