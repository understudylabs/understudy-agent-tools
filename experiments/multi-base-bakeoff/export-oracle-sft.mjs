#!/usr/bin/env node
/**
 * Build the SFT rung's training set: the train split's scripted oracle
 * trajectories, replayed through the same environment and rendered into the
 * same conversation shape the serving contract uses at inference time.
 *
 * Each oracle assistant turn becomes its own example — the conversation prefix
 * up to that turn, with the turn itself as the final assistant message — and
 * training takes loss on that last message only. Several renderers in the
 * bake-off (the Qwen thinking-disabled ones) rewrite earlier assistant turns
 * when re-rendering a longer conversation, so training a whole trajectory in
 * one pass would optimise token prefixes that never occur at inference. One
 * example per turn is exact for every renderer.
 *
 * Every base in the bake-off trains on this one file, so the SFT rung differs
 * across bases only by the weights being tuned. Deterministic and offline: no
 * model is sampled here, nothing is exported for a task outside the train
 * split, and a trajectory whose replay does not score exactly 1.0 fails closed.
 *
 *   node experiments/multi-base-bakeoff/export-oracle-sft.mjs \
 *     --out outputs/bakeoff/sft/oracle-train.jsonl
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { finish, getTask, partialCredit, reset, step } from "../../dist/automationbench-offline.js";
import { v2SplitSha256, v2TaskPool, v2FixtureSha256 } from "../../dist/automationbench-v2.js";
import { CONTRACT_ID, PARAMS, SYSTEM, contractSha256, taskFamily } from "./contract.mjs";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const outPath = argValue("--out", "outputs/bakeoff/sft/oracle-train.jsonl");
const manifestPath = argValue("--manifest", `${outPath.replace(/\.jsonl$/, "")}.manifest.json`);

// Training data comes from the train split only. The dev split picks the
// configuration and the holdout is sealed; neither may be trained on.
const pool = v2TaskPool({ split: "train" });

const records = pool.flatMap((poolTask) => {
  const task = getTask(poolTask.taskId);
  const { handle } = reset(task.taskId);
  const prefix = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task.prompt },
  ];
  const examples = [];
  const emit = (assistant) => {
    examples.push({
      task_id: task.taskId,
      split: "train",
      family: taskFamily(task.taskId),
      tier: task.taskId.startsWith("hard-") ? "hard" : "v1",
      turn: examples.length,
      messages: [...prefix, assistant],
    });
    prefix.push(assistant);
  };
  for (const call of task.oracle) {
    emit({ role: "assistant", content: JSON.stringify({ tool: call.name, arguments: call.arguments }) });
    const result = step(handle, call);
    prefix.push({ role: "user", content: result.obs.messages.at(-1).content.slice(0, PARAMS.observation_char_budget) });
    if (result.done) break;
  }
  emit({ role: "assistant", content: JSON.stringify({ tool: "finish", arguments: {} }) });
  const reward = handle.done ? partialCredit(handle) : finish(handle).reward;
  if (reward !== 1) throw new Error(`oracle replay for ${task.taskId} scored ${reward}, expected 1`);
  if (handle.forbiddenEffects.length > 0) throw new Error(`oracle replay for ${task.taskId} wrote outside allowedWrites`);
  return examples;
});

const jsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, jsonl);

const manifest = {
  schema_version: "understudy.bakeoff.sft_manifest.v1",
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  source: "synthetic offline fixture (index-generated); no customer or tenant data",
  fixture: PARAMS.fixture,
  fixture_sha256: v2FixtureSha256(),
  split: "train",
  split_sha256: v2SplitSha256("train"),
  contract_id: CONTRACT_ID,
  contract_sha256: contractSha256(),
  trajectories: pool.length,
  examples: records.length,
  loss_on: "last_assistant_message",
  oracle_reward: 1,
  path: outPath,
  sha256: createHash("sha256").update(jsonl).digest("hex"),
};
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
