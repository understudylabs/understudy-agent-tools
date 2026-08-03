#!/usr/bin/env node
/**
 * Score one rung of the bake-off ladder through the shared serving contract.
 *
 * Any OpenAI-compatible endpoint works: Fireworks serverless directly, or a
 * Tinker base/checkpoint through `scripts/tinker-openai-shim.py`. The verifier,
 * protocol, decoding parameters, and parser all come from `contract.mjs`, so
 * two artifacts produced by this script are comparable by construction.
 *
 * The holdout split is refused unless the frozen hash is supplied, and this
 * script never selects anything — it only measures.
 *
 *   node experiments/multi-base-bakeoff/run-eval.mjs \
 *     --label nemotron3-nano/base --lane tinker --base-url http://127.0.0.1:8099/v1 \
 *     --model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 --split dev \
 *     --out outputs/bakeoff/nemotron-base-dev.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { v2SplitSha256, v2TaskBands, v2TaskPool, v2FixtureSha256 } from "../../dist/automationbench-v2.js";
import { CONTRACT_ID, PARAMS, contractSha256, runEpisode } from "./contract.mjs";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const model = argValue("--model");
if (!model) throw new Error("--model is required");
const label = argValue("--label", model);
const lane = argValue("--lane", "fireworks");
const rung = argValue("--rung", "base");
const renderer = argValue("--renderer", null);
const checkpoint = argValue("--checkpoint", null);
const split = argValue("--split", "dev");
const limit = Number(argValue("--limit", "0")) || 0;
const concurrency = Number(argValue("--concurrency", "6"));
const baseUrl = argValue("--base-url", "https://api.fireworks.ai/inference/v1");
const outPath = argValue("--out");
const frozenHoldout = argValue("--frozen-holdout");
const priceInput = Number(argValue("--price-input-usd-per-mtok", "0")) || 0;
const priceOutput = Number(argValue("--price-output-usd-per-mtok", "0")) || 0;
const priceSource = argValue("--price-source", null);

const isLocalShim = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(baseUrl);
const apiKey = process.env.FIREWORKS_API_KEY ?? (isLocalShim ? "local-shim" : undefined);
if (!apiKey) throw new Error("FIREWORKS_API_KEY is required (never hard-code it)");

const pool = v2TaskPool({ split, frozenHoldoutSha256: frozenHoldout ?? undefined });
const tasks = limit > 0 ? pool.slice(0, limit) : pool;
const BANDS = v2TaskBands();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chat(messages, attempt = 0) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: PARAMS.temperature, max_tokens: PARAMS.max_tokens }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    // Rate limits and transient upstream faults are throughput artefacts, not benchmark signal.
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      await sleep(2000 * 2 ** attempt + Math.floor(Math.random() * 500));
      return chat(messages, attempt + 1);
    }
    throw new Error(`chat failed ${response.status}: ${detail}`);
  }
  const payload = await response.json();
  return {
    text: payload.choices?.[0]?.message?.content ?? "",
    promptTokens: payload.usage?.prompt_tokens ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? 0,
  };
}

const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round(sorted[index] * 1000) / 1000;
}

async function main() {
  const started = Date.now();
  const rows = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      const { row } = await runEpisode(task, chat);
      rows.push({ ...row, band: BANDS[row.family] ?? "unknown" });
      process.stderr.write(`\r${rows.length}/${tasks.length} done`);
    }
  });
  await Promise.all(workers);
  process.stderr.write("\n");

  const scored = rows.filter((row) => typeof row.score === "number");
  const latencies = rows.flatMap((row) => row.request_latencies_s);
  const promptTokens = rows.reduce((sum, row) => sum + row.prompt_tokens, 0);
  const completionTokens = rows.reduce((sum, row) => sum + row.completion_tokens, 0);
  const byBand = {};
  const byTier = {};
  const byFamily = {};
  for (const row of scored) {
    (byBand[row.band] ??= []).push(row.score);
    (byTier[row.tier] ??= []).push(row.score);
    (byFamily[row.family] ??= []).push(row.score);
  }
  const costUsd = priceInput || priceOutput
    ? (promptTokens / 1e6) * priceInput + (completionTokens / 1e6) * priceOutput
    : null;

  const report = {
    schema_version: "understudy.bakeoff.evidence_row.v1",
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    label,
    rung,
    lane,
    model,
    renderer,
    checkpoint,
    contract_id: CONTRACT_ID,
    contract_sha256: contractSha256(),
    params: PARAMS,
    fixture: PARAMS.fixture,
    fixture_sha256: v2FixtureSha256(),
    split,
    split_sha256: v2SplitSha256(split),
    pool_size: pool.length,
    sampled: tasks.length,
    scored: scored.length,
    errors: rows.length - scored.length,
    mean_score: mean(scored.map((row) => row.score)),
    exact_1_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 1).length / scored.length,
    zero_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 0).length / scored.length,
    mean_by_tier: Object.fromEntries(Object.entries(byTier).map(([key, values]) => [key, mean(values)])),
    mean_by_band: Object.fromEntries(Object.entries(byBand).map(([key, values]) => [key, mean(values)])),
    mean_by_family: Object.fromEntries(Object.entries(byFamily).map(([key, values]) => [key, mean(values)])),
    // A policy that writes outside `allowedWrites` scores 0 for that episode, so
    // the raw counts stay in the row even when the rate rounds away.
    over_acting_episodes: rows.filter((row) => (row.forbidden_effects ?? 0) > 0).length,
    forbidden_writes: rows.reduce((sum, row) => sum + (row.forbidden_effects ?? 0), 0),
    malformed_rate: rows.length === 0 ? null : rows.filter((row) => row.malformed > 0).length / rows.length,
    serving: {
      requests: latencies.length,
      requests_per_task: rows.length === 0 ? null : latencies.length / rows.length,
      request_latency_s: {
        mean: latencies.length === 0 ? null : Math.round(mean(latencies) * 1000) / 1000,
        p50: percentile(latencies, 0.5),
        p90: percentile(latencies, 0.9),
        p99: percentile(latencies, 0.99),
      },
      task_latency_s: {
        mean: rows.length === 0 ? null : Math.round(mean(rows.map((row) => row.episode_latency_s)) * 1000) / 1000,
        p90: percentile(rows.map((row) => row.episode_latency_s), 0.9),
      },
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      tokens_per_task: rows.length === 0 ? null : (promptTokens + completionTokens) / rows.length,
      price_usd_per_mtok: priceInput || priceOutput ? { input: priceInput, output: priceOutput, source: priceSource } : null,
      cost_usd: costUsd,
      cost_usd_per_1k_tasks: costUsd === null || rows.length === 0 ? null : (costUsd / rows.length) * 1000,
      concurrency,
      wall_clock_s: Math.round((Date.now() - started) / 1000),
    },
    rows: rows.sort((a, b) => a.task_id.localeCompare(b.task_id)),
  };
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const { rows: _rows, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
}

await main();
