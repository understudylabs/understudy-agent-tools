#!/usr/bin/env node
/**
 * Mine near-hit DPO preference pairs from WL-OR base rollouts on the slice's
 * TRAIN split. Reads only a rollout artifact produced with `--transcripts`;
 * it never samples a model and never touches dev or holdout.
 *
 * Two pair types, both anchored on a shared conversation prefix so the pair
 * isolates a single decision:
 *
 *   outcome — two sibling episodes of the same task that ended with DIFFERENT
 *     terminal scores. The pair is taken at their first divergent turn:
 *     chosen = the higher-scoring episode's emission, rejected = the lower one's.
 *     Same-score siblings are dropped: a cosmetic wording difference is not a
 *     preference.
 *
 *   format — inside one episode, an emission the environment REJECTED as
 *     malformed, against the emission the model produced at the same prefix on
 *     its retry. Rejected emissions never execute, so this is not a cosmetic
 *     difference either: it is a burned turn out of a fixed budget.
 *
 * Usage:
 *   node experiments/workload-orchestrator/mine-pairs.mjs \
 *     --rollouts <base-train-rollouts.json> \
 *     --pairs <pairs.jsonl> --manifest <manifest.json> [--max-per-task 6]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { SLICE, sliceSplitSha256 } from "./slice.mjs";

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
if (run.slice_id !== SLICE.slice_id) throw new Error(`rollouts are from slice ${run.slice_id}, not ${SLICE.slice_id}`);
const rows = run.rows.filter((row) => Array.isArray(row.turns) && typeof row.score === "number");
if (rows.length === 0) throw new Error("no scored rollouts with transcripts; re-run with --transcripts");

/** Messages seen by the model before turn `index` of an episode. */
function prefix(row, index) {
  const messages = [
    { role: "system", content: row.system },
    { role: "user", content: row.prompt },
  ];
  for (const turn of row.turns.slice(0, index)) {
    messages.push({ role: "assistant", content: turn.assistant || "(empty)" });
    if (typeof turn.observation === "string") messages.push({ role: "user", content: turn.observation });
  }
  return messages;
}

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
        divergence < winner.turns.length &&
        divergence < loser.turns.length &&
        winner.turns[divergence].assistant === loser.turns[divergence].assistant
      ) divergence += 1;
      if (divergence >= winner.turns.length || divergence >= loser.turns.length) continue;
      taskPairs.push({
        task_id: taskId,
        pair_type: "outcome",
        chosen_score: winner.score,
        rejected_score: loser.score,
        turn: divergence,
        prompt_conversation: prefix(winner, divergence),
        chosen: [{ role: "assistant", content: winner.turns[divergence].assistant }],
        rejected: [{ role: "assistant", content: loser.turns[divergence].assistant }],
      });
    }
  }

  // format pairs — a rejected emission against the accepted retry at the same prefix.
  for (const episode of episodes) {
    episode.turns.forEach((turn, index) => {
      if (!turn.rejected) return;
      const retry = episode.turns[index + 1];
      if (!retry || retry.rejected) return;
      taskPairs.push({
        task_id: taskId,
        pair_type: "format",
        chosen_score: episode.score,
        rejected_score: episode.score,
        turn: index,
        prompt_conversation: prefix(episode, index),
        chosen: [{ role: "assistant", content: retry.assistant }],
        rejected: [{ role: "assistant", content: turn.assistant }],
      });
    });
  }

  // Keep the pair set balanced: no task may dominate the objective.
  const outcomeFirst = [
    ...taskPairs.filter((pair) => pair.pair_type === "outcome"),
    ...taskPairs.filter((pair) => pair.pair_type === "format"),
  ];
  const kept = [];
  const seen = new Set();
  for (const pair of outcomeFirst) {
    if (kept.length >= maxPerTask) break;
    const chosenText = pair.chosen[0].content;
    const rejectedText = pair.rejected[0].content;
    if (chosenText === rejectedText) continue;
    const key = createHash("sha256")
      .update(JSON.stringify([pair.prompt_conversation, chosenText, rejectedText]))
      .digest("hex");
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
const pairsSha256 = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
const manifest = {
  schema_version: "understudy.dpo_pairs_manifest.v1",
  generated_at: new Date().toISOString(),
  source: `synthetic fixture ${SLICE.fixture_id} (${SLICE.slice_id}); base rollouts only`,
  slice_id: SLICE.slice_id,
  workload_code: SLICE.workload_code,
  split: "train",
  train_split_sha256: sliceSplitSha256("train"),
  rollouts_path: rolloutsPath,
  rollout_model: run.model,
  rollout_samples_per_task: run.samples_per_task,
  rollout_temperature: run.temperature,
  pairs: pairs.length,
  pairs_by_type: { outcome: stats.outcome, format: stats.format },
  tasks_with_pairs: stats.tasks_with_pairs,
  tasks_without_signal: stats.tasks_without_signal,
  pairs_sha256: pairsSha256,
};

if (pairsPath) {
  mkdirSync(dirname(pairsPath), { recursive: true });
  writeFileSync(pairsPath, body);
}
if (manifestPath) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(JSON.stringify(manifest, null, 2));
