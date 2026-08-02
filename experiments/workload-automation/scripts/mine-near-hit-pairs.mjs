#!/usr/bin/env node
/**
 * Near-hit preference-pair miner for the WL-AU (synthetic "automation") arm.
 *
 * Samples K rollouts per TRAIN task of the offline AutomationBench v2 fixture
 * through the same OpenAI-compatible sampling path the scorer uses, then turns
 * sibling rollouts of the *same* task into DPO pairs at their first divergence:
 *
 *   prompt_conversation = the shared prefix (system + task + every observation
 *                         both rollouts saw before they disagreed)
 *   chosen              = the assistant turn taken by the rollout that reached
 *                         the required final state
 *   rejected            = the assistant turn taken by the sibling that missed it
 *
 * Two rules keep the pairs honest:
 *   - OUTCOME-FIRST. A pair is only emitted when the two turns parse to
 *     *different actions*. Same action, different prose is cosmetic and is
 *     dropped, so the tuned policy is never taught to prefer one wording.
 *   - NEAR-HIT ONLY. The rejected sibling must be a near miss (partial credit,
 *     or an over-action that wrote outside `allowedWrites`), not a collapse.
 *     Pairs against rollouts that never did anything teach formatting, not
 *     judgement.
 *
 * Emits `dpo_pairs.jsonl` + a manifest for `scripts/dpo-pairs-validate.mjs`,
 * which is the only gate that may authorize training spend. Train split only —
 * this script cannot read dev or holdout.
 *
 * Usage:
 *   node experiments/workload-automation/scripts/mine-near-hit-pairs.mjs \
 *     --base-url http://localhost:8099/v1 --model nemotron-3-nano \
 *     --samples 8 --temperature 0.9 --out-dir outputs/workload-automation/pairs
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { finish, partialCredit, reset, step } from "../../../dist/automationbench-offline.js";
import { v2SplitSha256, v2TaskBands, v2TaskPool } from "../../../dist/automationbench-v2.js";

/** Byte-identical to the scorer's system prompt; the tests pin them together. */
export const SYSTEM = [
  "You operate business apps through two tools.",
  'api_search — read-only endpoint discovery. arguments: {"query": string}',
  'api_fetch  — apply ONE API call. arguments: {"method": string, "url": string, "body": object}',
  "",
  "Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no second object:",
  '  {"tool": "api_search", "arguments": {"query": "..."}}',
  '  {"tool": "api_fetch", "arguments": {"method": "GET", "url": "/crm/contacts"}}',
  '  {"tool": "finish", "arguments": {}}   <- when the requested change is complete',
  "",
  "Read before you write: list the relevant collections first, then make the smallest set of writes that satisfies the request.",
  "Writing to a record the request did not ask you to change scores zero for the whole task.",
].join("\n");

/** Strict parse: one JSON object naming a known tool. No repair, no salvage of prose. */
export function parseAction(text) {
  const visible = String(text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "");
  const trimmed = visible.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return { error: "no JSON object in reply" };
  let decoded;
  try {
    decoded = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { error: "reply is not valid JSON" };
  }
  const name = decoded.tool ?? decoded.name ?? decoded.function?.name;
  if (typeof name !== "string") return { error: "reply has no tool name" };
  if (name === "finish") return { finish: true };
  if (name !== "api_search" && name !== "api_fetch") return { error: `unknown tool: ${name}` };
  let args = decoded.arguments ?? decoded.args ?? decoded.function?.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return { error: "arguments are not valid JSON" };
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return { error: "arguments must be an object" };
  return { action: { name, arguments: args } };
}

/** Order-insensitive canonical JSON, so `{a,b}` and `{b,a}` are one action. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * What a turn actually *did*, ignoring how it was worded. A malformed emission
 * is its own signature so "emitted nothing parseable" stays a real difference.
 */
export function actionSignature(text) {
  const parsed = parseAction(text);
  if (parsed.finish) return "finish";
  if (parsed.error) return "malformed";
  const { name, arguments: args } = parsed.action;
  if (name === "api_search") return `api_search:${String(args.query ?? "").trim().toLowerCase()}`;
  const method = String(args.method ?? "GET").toUpperCase();
  return `api_fetch:${method}:${String(args.url ?? "")}:${canonical(args.body ?? null)}`;
}

/**
 * First index where two rollouts took different actions, or -1 when one is a
 * strict prefix of the other (nothing to prefer — they never disagreed).
 */
export function divergenceIndex(chosenTurns, rejectedTurns) {
  const shared = Math.min(chosenTurns.length, rejectedTurns.length);
  for (let index = 0; index < shared; index += 1) {
    if (chosenTurns[index].signature !== rejectedTurns[index].signature) return index;
  }
  return -1;
}

/**
 * Turn one task's sampled rollouts into at most `maxPairs` near-hit pairs.
 *
 * `chosen` is the shortest full-credit rollout with no forbidden write. A
 * sibling qualifies as `rejected` when it missed that outcome and is a genuine
 * near hit rather than a collapse:
 *
 *   - it emitted at least one parseable action (an episode that never produced
 *     a call teaches formatting, not judgement);
 *   - it diverged from the winner on an *action*, not on wording.
 *
 * Most bands score 0/1 rather than fractionally, so "near hit" cannot be a
 * score floor alone. Siblings are ranked by how much correct prefix they share
 * with the winner (later divergence = smaller, more learnable delta), with
 * over-actions pulled to the front because writing outside `allowedWrites` is
 * the specific regression this arm has to train against. Pairs whose rejected
 * turn is a malformed emission are capped at `maxMalformed`, so the dataset
 * cannot degenerate into a JSON-formatting lesson.
 */
export function minePairsForTask({ taskId, family, band, rollouts, maxPairs = 2, maxMalformed = 1 }) {
  const winners = rollouts
    .filter((rollout) => rollout.score === 1 && rollout.forbidden_effects === 0)
    .sort((left, right) => left.turns.length - right.turns.length);
  if (winners.length === 0) return [];
  const chosen = winners[0];

  const losers = rollouts
    .filter((rollout) => {
      if (typeof rollout.score !== "number") return false;
      if (rollout.score >= 1 && rollout.forbidden_effects === 0) return false;
      return rollout.turns.some((turn) => turn.signature !== "malformed");
    })
    .map((rollout) => ({ rollout, index: divergenceIndex(chosen.turns, rollout.turns) }))
    .filter((entry) => entry.index !== -1)
    .sort((left, right) => {
      const over = Number(right.rollout.forbidden_effects > 0) - Number(left.rollout.forbidden_effects > 0);
      if (over !== 0) return over;
      if (right.index !== left.index) return right.index - left.index;
      return right.rollout.score - left.rollout.score;
    });

  const pairs = [];
  const seenSignatures = new Set();
  let malformedPairs = 0;
  for (const { rollout: rejected, index } of losers) {
    if (pairs.length >= maxPairs) break;
    const chosenTurn = chosen.turns[index];
    const rejectedTurn = rejected.turns[index];
    const key = `${index}:${chosenTurn.signature}|${rejectedTurn.signature}`;
    if (seenSignatures.has(key)) continue;
    if (rejectedTurn.signature === "malformed" && malformedPairs >= maxMalformed) continue;
    if (rejectedTurn.signature === "malformed") malformedPairs += 1;
    seenSignatures.add(key);
    pairs.push({
      task_id: taskId,
      family,
      band,
      prompt_conversation: chosen.turns[index].prefix,
      chosen: [{ role: "assistant", content: chosenTurn.text }],
      rejected: [{ role: "assistant", content: rejectedTurn.text }],
      metadata: {
        divergence_turn: index,
        chosen_score: chosen.score,
        rejected_score: rejected.score,
        rejected_forbidden_effects: rejected.forbidden_effects,
        chosen_action: chosenTurn.signature,
        rejected_action: rejectedTurn.signature,
      },
    });
  }
  return pairs;
}

// Imported by the tests for the pure mining helpers; only a direct invocation
// touches the network.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function main() {
  const model = argValue("--model", "nemotron-3-nano");
  const baseUrl = argValue("--base-url", "http://localhost:8099/v1");
  const samples = Number(argValue("--samples", "8"));
  const temperature = Number(argValue("--temperature", "0.9"));
  const maxTurns = Number(argValue("--max-turns", "14"));
  const maxTokens = Number(argValue("--max-tokens", "512"));
  const concurrency = Number(argValue("--concurrency", "12"));
  const limit = Number(argValue("--limit", "0")) || 0;
  const maxPairsPerTask = Number(argValue("--max-pairs-per-task", "2"));
  const outDir = argValue("--out-dir", "outputs/workload-automation/pairs");
  const malformedTolerance = Number(argValue("--malformed-tolerance", "3"));

  const isLocalShim = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(baseUrl);
  const apiKey = process.env.FIREWORKS_API_KEY ?? (isLocalShim ? "local-shim" : undefined);
  if (!apiKey) throw new Error("FIREWORKS_API_KEY is required (never hard-code it)");

  // Train split only. v2TaskPool refuses holdout without the frozen hash, and
  // this arm never asks for dev either — dev stays an honest selection surface.
  const pool = v2TaskPool({ split: "train" });
  const tasks = limit > 0 ? pool.slice(0, limit) : pool;
  const BANDS = v2TaskBands();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function chat(messages, attempt = 0) {
    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      });
    } catch (cause) {
      if (attempt < 5) {
        await sleep(2000 * 2 ** attempt);
        return chat(messages, attempt + 1);
      }
      throw cause;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      if ((response.status === 429 || response.status >= 500) && attempt < 5) {
        await sleep(2000 * 2 ** attempt + Math.floor(Math.random() * 500));
        return chat(messages, attempt + 1);
      }
      throw new Error(`chat failed ${response.status}: ${detail}`);
    }
    const payload = await response.json();
    return payload.choices?.[0]?.message?.content ?? "";
  }

  /** One sampled episode, recording the exact prefix each turn was taken from. */
  async function rollout(task) {
    const { handle } = reset(task.taskId);
    const messages = [
      { role: "system", content: SYSTEM },
      { role: "user", content: task.prompt },
    ];
    const turns = [];
    let consecutiveMalformed = 0;
    let ended = "budget";
    let error = null;

    try {
      for (let turn = 0; turn < maxTurns && !handle.done; turn += 1) {
        const prefix = messages.map((message) => ({ ...message }));
        const text = await chat(messages);
        messages.push({ role: "assistant", content: text || "(empty)" });
        const parsed = parseAction(text);
        turns.push({ prefix, text: text || "(empty)", signature: actionSignature(text) });
        if (parsed.finish) {
          ended = "finish";
          break;
        }
        if (parsed.error) {
          consecutiveMalformed += 1;
          if (consecutiveMalformed >= malformedTolerance) {
            ended = "malformed";
            break;
          }
          messages.push({ role: "user", content: `rejected: ${parsed.error}. Reply with exactly one JSON tool object.` });
          continue;
        }
        consecutiveMalformed = 0;
        const result = step(handle, parsed.action);
        messages.push({ role: "user", content: result.obs.messages.at(-1).content.slice(0, 4000) });
        if (result.done) ended = "budget";
      }
    } catch (cause) {
      error = String(cause?.message ?? cause);
      ended = "error";
    }

    const score = handle.done ? partialCredit(handle) : finish(handle).reward;
    return {
      score: error ? null : score,
      ended,
      error,
      forbidden_effects: handle.forbiddenEffects.length,
      turns,
    };
  }

  const jobs = [];
  for (const task of tasks) for (let sample = 0; sample < samples; sample += 1) jobs.push({ task, sample });
  const byTask = new Map();
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const result = await rollout(job.task);
      if (!byTask.has(job.task.taskId)) byTask.set(job.task.taskId, []);
      byTask.get(job.task.taskId).push(result);
      done += 1;
      if (done % 25 === 0) process.stderr.write(`\r${done}/${jobs.length} rollouts`);
    }
  });
  await Promise.all(workers);
  process.stderr.write(`\r${done}/${jobs.length} rollouts\n`);

  const pairs = [];
  const rolloutStats = [];
  for (const task of tasks) {
    const rollouts = byTask.get(task.taskId) ?? [];
    const family = task.taskId.replace(/^(?:simple|hard)-api-/, "").replace(/-\d{2}$/, "");
    const band = BANDS[family] ?? "unknown";
    const scored = rollouts.filter((entry) => typeof entry.score === "number");
    rolloutStats.push({
      task_id: task.taskId,
      family,
      band,
      rollouts: rollouts.length,
      solved: scored.filter((entry) => entry.score === 1 && entry.forbidden_effects === 0).length,
      mean_score: scored.length === 0 ? null : scored.reduce((sum, entry) => sum + entry.score, 0) / scored.length,
      over_acting: rollouts.filter((entry) => entry.forbidden_effects > 0).length,
    });
    pairs.push(...minePairsForTask({ taskId: task.taskId, family, band, rollouts, maxPairs: maxPairsPerTask }));
  }

  mkdirSync(outDir, { recursive: true });
  const jsonl = `${pairs.map((pair) => JSON.stringify(pair)).join("\n")}\n`;
  const pairsPath = `${outDir}/dpo_pairs.jsonl`;
  writeFileSync(pairsPath, jsonl);

  const bandCounts = {};
  for (const pair of pairs) bandCounts[pair.band] = (bandCounts[pair.band] ?? 0) + 1;
  const manifest = {
    schema_version: "understudy.dpo_pairs_manifest.v1",
    generated_at: new Date().toISOString(),
    source: "synthetic offline fixture automationbench-simple-api-offline-v2 (index-generated records; no customer data)",
    workload: "WL-AU",
    split: "train",
    train_split_sha256: v2SplitSha256("train"),
    sampler: { model, base_url_kind: isLocalShim ? "local-shim" : "remote", temperature, samples_per_task: samples, max_turns: maxTurns, max_tokens: maxTokens },
    tasks: tasks.length,
    rollouts: jobs.length,
    pairs: pairs.length,
    pairs_by_band: bandCounts,
    pairs_sha256: createHash("sha256").update(jsonl).digest("hex"),
  };
  writeFileSync(`${outDir}/dpo_pairs.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(`${outDir}/rollout-stats.json`, `${JSON.stringify({ manifest, tasks: rolloutStats }, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}
