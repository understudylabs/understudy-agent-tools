#!/usr/bin/env node
/**
 * Mine near-hit DPO preference pairs from sampled base rollouts on the
 * `domain-identification` slice TRAIN split.
 *
 * A pair is only emitted when two sibling episodes of the SAME task share an
 * identical prefix and then diverge on the one turn that decides the outcome:
 *
 *   chosen   — the episode that reached the required final state (score 1.0);
 *   rejected — a sibling that made the write and missed (a near hit).
 *
 * Guards, all fail-closed by skipping the candidate rather than repairing it:
 *   - both episodes must come from the same task id and the TRAIN split;
 *   - the difference must be OUTCOME-CHANGING, and that is verified by replay
 *     rather than assumed: the pair is conditioned on the winning episode's own
 *     prefix, and both decisions are re-applied to a fresh environment driven
 *     through that same prefix. The pair is kept only if the chosen decision
 *     still reaches 1.0 there and the rejected one does not. Prose-only
 *     differences therefore cannot survive — they replay identically;
 *   - a rejected episode that never attempted the write is dropped: a
 *     no-op/malformed failure teaches format, not identification.
 *
 * Output is the pair contract from `docs/synthetic-offline-dpo-nemotron.md`
 * (one JSON object per line) plus a manifest carrying `pairs_sha256`.
 *
 *   node experiments/domain-identification-repair/mine-pairs.mjs \
 *     --transcripts <rollouts.jsonl> \
 *     --out experiments/domain-identification-repair/outputs/dpo_pairs.jsonl \
 *     --manifest experiments/domain-identification-repair/outputs/dpo_pairs.manifest.json
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { finish, partialCredit, reset, step } from "../../dist/automationbench-offline.js";
import { DOMAIN_ID_TASKS, domainIdSplitSha256, domainIdTaskBands } from "../../dist/domain-identification-slice.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const transcriptPath = argValue("--transcripts");
if (!transcriptPath) throw new Error("--transcripts is required");
const outPath = argValue("--out");
if (!outPath) throw new Error("--out is required");
const manifestPath = argValue("--manifest");
const maxPairsPerTask = Number(argValue("--max-pairs-per-task", "3"));

const SPLIT_BY_TASK = new Map(DOMAIN_ID_TASKS.map((task) => [task.taskId, task.split]));
const BANDS = domainIdTaskBands();

/** The same strict parse the runner uses; a decision that would not have executed is not a decision. */
function parseAction(text) {
  const visible = String(text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "");
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
  if (name !== "api_fetch") return null;
  let args = decoded.arguments ?? decoded.args ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== "object") return null;
  return { method: String(args.method ?? "GET").toUpperCase(), url: String(args.url ?? ""), body: args.body ?? null };
}

const isWrite = (action) => Boolean(action) && action.method !== "GET";

/** Any tool call, mutating or not — used to compare what two siblings actually did. */
function parseAnyAction(text) {
  const visible = String(text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "");
  const trimmed = visible.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const decoded = JSON.parse(trimmed.slice(start, end + 1));
    const name = decoded.tool ?? decoded.name ?? decoded.function?.name;
    if (typeof name !== "string") return null;
    const args = decoded.arguments ?? decoded.args ?? {};
    return { name, args: typeof args === "object" && args ? args : {} };
  } catch {
    return null;
  }
}

/** The calls an episode actually executed before its decision turn. */
function prefixCalls(messages, upTo) {
  const calls = [];
  for (let index = 0; index < upTo; index += 1) {
    if (messages[index].role !== "assistant") continue;
    const action = parseAnyAction(messages[index].content);
    if (!action) continue;
    calls.push({ name: action.name, arguments: action.args });
  }
  return calls;
}

/**
 * Replay a prefix into a fresh environment, apply one decision, and take the
 * terminal score. This is what makes a mined pair a counterfactual rather than
 * a guess: both sides are judged at the SAME state by the fixture's own grader.
 */
function replayScore(taskId, calls, decision) {
  const { handle } = reset(taskId);
  for (const call of calls) {
    if (handle.done) break;
    step(handle, call);
  }
  if (handle.done) return null;
  step(handle, { name: "api_fetch", arguments: { method: decision.method, url: decision.url, body: decision.body ?? {} } });
  return { score: handle.done ? partialCredit(handle) : finish(handle).reward, forbidden: handle.forbiddenEffects.length };
}

/** Index of the assistant turn that carried the episode's last mutating call. */
function decisionIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (isWrite(parseAction(message.content))) return index;
  }
  return -1;
}

const canonical = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());

/** Two decisions differ meaningfully only if the effect they would apply differs. */
function outcomeChanging(left, right) {
  if (left.method !== right.method || left.url !== right.url) return true;
  return canonical(left.body ?? {}) !== canonical(right.body ?? {});
}

const episodes = readFileSync(transcriptPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const byTask = new Map();
for (const episode of episodes) {
  if (SPLIT_BY_TASK.get(episode.task_id) !== "train") continue;
  if (!Array.isArray(episode.transcript)) continue;
  const index = decisionIndex(episode.transcript);
  if (index === -1) continue;
  const entry = {
    ...episode,
    decisionIndex: index,
    decision: parseAction(episode.transcript[index].content),
    prefix: episode.transcript.slice(0, index),
    prefixCalls: prefixCalls(episode.transcript, index),
  };
  if (!byTask.has(episode.task_id)) byTask.set(episode.task_id, []);
  byTask.get(episode.task_id).push(entry);
}

const pairs = [];
const emittedKeys = new Set();
const skipped = { no_winner: 0, no_candidate_decision: 0, replay_unusable: 0, not_outcome_changing: 0, duplicate: 0 };

for (const [taskId, entries] of [...byTask.entries()].sort()) {
  const winners = entries.filter((entry) => entry.score === 1 && entry.forbidden_effects === 0);
  const losers = entries.filter((entry) => typeof entry.score === "number" && entry.score < 1);
  if (winners.length === 0) {
    skipped.no_winner += 1;
    continue;
  }
  if (losers.length === 0) {
    skipped.no_candidate_decision += 1;
    continue;
  }
  let emitted = 0;
  for (const winner of winners) {
    const chosenReplay = replayScore(taskId, winner.prefixCalls, winner.decision);
    if (!chosenReplay || chosenReplay.score !== 1 || chosenReplay.forbidden > 0) {
      skipped.replay_unusable += 1;
      continue;
    }
    for (const loser of losers) {
      if (emitted >= maxPairsPerTask) break;
      if (!outcomeChanging(winner.decision, loser.decision)) continue;
      const rejectedReplay = replayScore(taskId, winner.prefixCalls, loser.decision);
      if (!rejectedReplay) {
        skipped.replay_unusable += 1;
        continue;
      }
      if (rejectedReplay.score >= 1) {
        skipped.not_outcome_changing += 1;
        continue;
      }
      // Sampled siblings often land on the same wording; the same triple twice
      // is one preference, not two.
      const key = createHash("sha256")
        .update(JSON.stringify([
          winner.prefix.map((message) => message.content),
          winner.transcript[winner.decisionIndex].content,
          loser.transcript[loser.decisionIndex].content,
        ]))
        .digest("hex");
      if (emittedKeys.has(key)) {
        skipped.duplicate += 1;
        continue;
      }
      emittedKeys.add(key);
      const family = taskId.replace(/^domain-id-/, "").replace(/-\d{2}$/, "");
      pairs.push({
        task_id: taskId,
        family,
        band: BANDS[family] ?? "unknown",
        prompt_conversation: winner.prefix.map((message) => ({ role: message.role, content: message.content })),
        chosen: [{ role: "assistant", content: winner.transcript[winner.decisionIndex].content }],
        rejected: [{ role: "assistant", content: loser.transcript[loser.decisionIndex].content }],
        chosen_score: chosenReplay.score,
        rejected_score: rejectedReplay.score,
        rejected_forbidden_writes: rejectedReplay.forbidden,
      });
      emitted += 1;
    }
    if (emitted >= maxPairsPerTask) break;
  }
}

const serialized = `${pairs.map((pair) => JSON.stringify(pair)).join("\n")}\n`;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, serialized);

const bandCounts = {};
for (const pair of pairs) bandCounts[pair.band] = (bandCounts[pair.band] ?? 0) + 1;

const manifest = {
  schema_version: "understudy.dpo_pairs_manifest.v1",
  source: "synthetic offline fixture rollouts (domain-identification-offline-v1); no customer data",
  fixture_id: "domain-identification-offline-v1",
  split: "train",
  train_split_sha256: domainIdSplitSha256("train"),
  holdout_split_sha256: domainIdSplitSha256("holdout"),
  pairs: pairs.length,
  tasks_covered: new Set(pairs.map((pair) => pair.task_id)).size,
  band_counts: bandCounts,
  skipped,
  pairs_sha256: createHash("sha256").update(serialized).digest("hex"),
};

if (manifestPath) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(JSON.stringify(manifest, null, 2));
