#!/usr/bin/env node
/**
 * Mine near-hit DPO preference pairs from base rollouts on the aop-selection
 * synthetic TRAIN split.
 *
 * A pair is only useful if the two completions are the same decision made two
 * ways. So a pair is cut at the DIVERGENCE POINT of two episodes of the same
 * task: the longest common message prefix becomes the prompt, and the first
 * assistant emission that differs becomes chosen (from an episode that reached
 * the required final state) and rejected (from one that did not).
 *
 * Cosmetic differences are dropped. If both emissions parse to the same tool
 * call, the diff is wording, not outcome, and the pair carries no signal worth
 * training on — the run that scored differently did so later, and that later
 * turn is where the real pair is.
 *
 * Input is the `--transcripts` JSONL from `scripts/aop-selection-rollout.mjs`.
 * Dev and holdout episodes are refused outright: only the train split may
 * produce training data.
 *
 * Usage:
 *   node scripts/aop-selection-dpo-mine.mjs \
 *     --episodes outputs/aop/base-train-episodes.jsonl,outputs/aop/base-train-episodes-b.jsonl \
 *     --out outputs/aop/dpo_pairs.jsonl \
 *     --manifest outputs/aop/dpo_pairs.manifest.json
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { aopGetTask, aopSplitSha256 } from "../dist/aop-selection-offline.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const episodesPath = argValue("--episodes");
if (!episodesPath) throw new Error("--episodes is required");
const outPath = argValue("--out", "outputs/aop/dpo_pairs.jsonl");
const manifestPath = argValue("--manifest", "outputs/aop/dpo_pairs.manifest.json");
const maxPairsPerTask = Number(argValue("--max-pairs-per-task", "3"));

const episodes = episodesPath
  .split(",")
  .flatMap((path) =>
    readFileSync(path.trim(), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line)),
  );

for (const episode of episodes) {
  const split = aopGetTask(episode.task_id).split;
  if (split !== "train") {
    throw new Error(`refusing to mine ${episode.task_id}: it belongs to the ${split} split`);
  }
}

/** Same strict parse the runner uses, so "the same tool call" means the same executed action. */
function parseAction(text) {
  const visible = String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[\s\S]*<\/think>/, "");
  const trimmed = visible.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let decoded;
  try {
    decoded = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  const name = decoded.tool ?? decoded.name ?? decoded.function?.name;
  if (typeof name !== "string") return null;
  let args = decoded.arguments ?? decoded.args ?? decoded.function?.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return { name, arguments: args };
}

const canonical = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());

function actionKey(text) {
  const action = parseAction(text);
  if (!action) return null;
  const args = action.arguments ?? {};
  return JSON.stringify([
    action.name,
    String(args.method ?? "").toUpperCase(),
    String(args.url ?? ""),
    canonical(args.body ?? {}),
    String(args.query ?? ""),
  ]);
}

const sameMessage = (left, right) =>
  left && right && left.role === right.role && left.content === right.content;

function divergence(chosenEpisode, rejectedEpisode) {
  const left = chosenEpisode.messages;
  const right = rejectedEpisode.messages;
  let index = 0;
  while (index < left.length && index < right.length && sameMessage(left[index], right[index])) {
    index += 1;
  }
  if (index >= left.length || index >= right.length) return null;
  if (left[index].role !== "assistant" || right[index].role !== "assistant") return null;
  return { prefix: left.slice(0, index), chosen: left[index], rejected: right[index] };
}

const byTask = new Map();
for (const episode of episodes) {
  const bucket = byTask.get(episode.task_id) ?? [];
  bucket.push(episode);
  byTask.set(episode.task_id, bucket);
}

const pairs = [];
const stats = {
  tasks_seen: byTask.size,
  tasks_with_pass: 0,
  tasks_with_near_miss: 0,
  tasks_yielding_pairs: 0,
  dropped_no_divergence: 0,
  dropped_cosmetic: 0,
  diff_kinds: {},
  by_band: {},
};

for (const [taskId, bucket] of [...byTask.entries()].sort()) {
  const task = aopGetTask(taskId);
  const passing = bucket.filter((episode) => episode.score === 1);
  const missing = bucket.filter((episode) => typeof episode.score === "number" && episode.score < 1);
  if (passing.length > 0) stats.tasks_with_pass += 1;
  if (missing.length > 0) stats.tasks_with_near_miss += 1;
  if (passing.length === 0 || missing.length === 0) continue;

  const candidates = [];
  for (const chosenEpisode of passing) {
    for (const rejectedEpisode of missing) {
      const point = divergence(chosenEpisode, rejectedEpisode);
      if (!point) {
        stats.dropped_no_divergence += 1;
        continue;
      }
      const chosenKey = actionKey(point.chosen.content);
      const rejectedKey = actionKey(point.rejected.content);
      if (chosenKey !== null && chosenKey === rejectedKey) {
        // Same executed action, different wording: nothing about the outcome changed here.
        stats.dropped_cosmetic += 1;
        continue;
      }
      candidates.push({
        point,
        diffKind: rejectedKey === null ? "malformed-emission" : "different-action",
        rejectedScore: rejectedEpisode.score,
      });
    }
  }

  // A wrong tool call teaches option selection; a malformed emission only
  // teaches format. Both change the outcome, but when the per-task budget
  // forces a choice, take the selection signal first.
  candidates.sort((left, right) => {
    if (left.diffKind === right.diffKind) return 0;
    return left.diffKind === "different-action" ? -1 : 1;
  });

  let minted = 0;
  const seen = new Set();
  for (const candidate of candidates) {
    if (minted >= maxPairsPerTask) break;
    const key = JSON.stringify([
      candidate.point.prefix.length,
      candidate.point.chosen.content,
      candidate.point.rejected.content,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    stats.diff_kinds[candidate.diffKind] = (stats.diff_kinds[candidate.diffKind] ?? 0) + 1;
    stats.by_band[task.band] = (stats.by_band[task.band] ?? 0) + 1;
    pairs.push({
      task_id: taskId,
      family: task.family,
      band: task.band,
      diff_kind: candidate.diffKind,
      rejected_score: candidate.rejectedScore,
      prompt_conversation: candidate.point.prefix,
      chosen: [{ role: "assistant", content: candidate.point.chosen.content }],
      rejected: [{ role: "assistant", content: candidate.point.rejected.content }],
    });
    minted += 1;
  }
  if (minted > 0) stats.tasks_yielding_pairs += 1;
}

if (pairs.length === 0) throw new Error("no preference pairs mined; nothing to train on");

const serialized = `${pairs.map((pair) => JSON.stringify(pair)).join("\n")}\n`;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, serialized);

const manifest = {
  schema_version: "understudy.dpo_pairs_manifest.v1",
  source: "synthetic fixture aop-selection-offline-v1 (authored; no captured traffic)",
  fixture_id: "aop-selection-offline-v1",
  split: "train",
  train_split_sha256: aopSplitSha256("train"),
  episodes_paths: episodesPath.split(",").map((path) => path.trim()),
  episodes: episodes.length,
  pairs: pairs.length,
  pairs_sha256: createHash("sha256").update(serialized).digest("hex"),
  mining: {
    rule: "longest-common-prefix divergence; chosen reached the required final state, rejected did not",
    cosmetic_filter: "pairs whose two emissions parse to the same tool call are dropped",
    max_pairs_per_task: maxPairsPerTask,
  },
  stats,
};
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({ pairs: pairs.length, ...stats }, null, 2));
