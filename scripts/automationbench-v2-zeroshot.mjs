#!/usr/bin/env node
/**
 * Zero-shot difficulty probe for the AutomationBench v2 offline fixture.
 *
 * Drives a base model through the in-process offline environment over an
 * OpenAI-compatible chat endpoint (Fireworks serverless by default — no
 * dedicated deployment, no GPU quota). Tool calls are driven through the
 * sampling path: the model emits ONE JSON object per turn and a malformed
 * emission is rejected rather than repaired, so the score reflects the model's
 * own tool-call discipline.
 *
 * This script only measures. It never trains, never selects on holdout, and
 * refuses the holdout split unless the frozen hash is supplied.
 *
 * Usage:
 *   FIREWORKS_API_KEY=... node scripts/automationbench-v2-zeroshot.mjs \
 *     --model accounts/fireworks/models/gpt-oss-20b --split dev --limit 20 \
 *     --system-file prompts/base.txt --api-key-env FIREWORKS_API_KEY \
 *     --out outputs/x.json
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_SYSTEM, makeChat, runEpisode, summarize } from "./lib/automationbench-episode.mjs";
import { V2_TASKS, v2SplitSha256, v2TaskBands, v2TaskPool } from "../dist/automationbench-v2.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const model = argValue("--model");
if (!model) throw new Error("--model is required");
const split = argValue("--split", "dev");
const limit = Number(argValue("--limit", "0")) || 0;
const stride = Number(argValue("--stride", "1")) || 1;
const concurrency = Number(argValue("--concurrency", "6"));
const maxTurns = Number(argValue("--max-turns", "14"));
const temperature = Number(argValue("--temperature", "0"));
// A malformed emission is always rejected (never executed); this only bounds
// how many consecutive rejections an episode survives before it is abandoned.
const malformedTolerance = Number(argValue("--malformed-tolerance", "3"));
const samples = Number(argValue("--samples", "1")) || 1;
const maxTokens = Number(argValue("--max-tokens", "512"));
const baseUrl = argValue("--base-url", "https://api.fireworks.ai/inference/v1");
const outPath = argValue("--out");
const frozenHoldout = argValue("--frozen-holdout");
const systemFile = argValue("--system-file");
const apiKeyEnv = argValue("--api-key-env", "FIREWORKS_API_KEY");
const includeTranscripts = process.argv.includes("--transcripts");
const systemPrompt = systemFile ? readFileSync(systemFile, "utf8") : DEFAULT_SYSTEM;
const systemPromptSha256 = createHash("sha256").update(systemPrompt).digest("hex");
// The Tinker lane is scored through the local shim (`scripts/tinker-openai-shim.py`),
// which authenticates to Tinker itself and ignores the bearer token.
const isLocalShim = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(baseUrl);
const apiKey = process.env[apiKeyEnv] ?? (isLocalShim ? "local-shim" : "");
if (!apiKey) throw new Error(`${apiKeyEnv} is required (never hard-code it)`);

const pool = v2TaskPool({ split, frozenHoldoutSha256: frozenHoldout ?? undefined });
const strided = pool.filter((_task, index) => index % stride === 0);
const tasks = limit > 0 ? strided.slice(0, limit) : strided;
// Reporting-only difficulty band per family; scoring never reads it.
const bands = v2TaskBands();
const chat = makeChat({ baseUrl, apiKey, model, temperature, maxTokens });

function taskFamily(task) {
  return task.taskId.replace(/^(?:simple|hard)-api-/, "").replace(/-\d{2}$/, "");
}

async function main() {
  const started = Date.now();
  const rows = [];
  let cursor = 0;
  const episodes = tasks.flatMap((task) =>
    Array.from({ length: samples }, (_unused, sample) => ({ task, sample })),
  );
  const workers = Array.from({ length: Math.min(concurrency, episodes.length) }, async () => {
    while (cursor < episodes.length) {
      const { task, sample } = episodes[cursor++];
      const row = await runEpisode({
        task,
        systemPrompt,
        chat,
        maxTurns,
        malformedTolerance,
        band: bands[taskFamily(task)],
      });
      rows.push({ ...row, sample });
      process.stderr.write(`\r${rows.length}/${episodes.length} done`);
    }
  });
  await Promise.all(workers);
  process.stderr.write("\n");

  const summary = summarize(rows, { bands });
  const report = {
    model,
    split,
    fixture: "automationbench-simple-api-offline-v2",
    split_sha256: v2SplitSha256(split),
    pool_size: V2_TASKS.filter((task) => task.split === split).length,
    sampled: tasks.length,
    samples_per_task: samples,
    ...summary,
    wall_clock_s: Math.round((Date.now() - started) / 1000),
    system_prompt_sha256: systemPromptSha256,
    rows: rows
      .map((row) => {
        if (includeTranscripts) return row;
        const { transcript: _transcript, ...withoutTranscript } = row;
        return withoutTranscript;
      })
      .sort((a, b) => a.task_id.localeCompare(b.task_id)),
  };
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const { rows: _rows, ...reportSummary } = report;
  console.log(JSON.stringify(reportSummary, null, 2));
}

await main();
