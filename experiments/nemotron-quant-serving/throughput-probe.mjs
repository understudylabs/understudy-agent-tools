#!/usr/bin/env node
/**
 * Serving-throughput probe for one precision lane.
 *
 * Measures decode throughput and time-to-first-token against an
 * OpenAI-compatible endpoint under a fixed, identical protocol so the numbers
 * from two lanes are comparable: same prompt, same output length, same
 * concurrency ladder, `ignore_eos` so every request emits exactly `--out-tokens`
 * tokens and a lane cannot look fast by stopping early.
 *
 * It measures serving only. It never touches the fixture, so it cannot read a
 * split and cannot leak the sealed holdout.
 *
 * Usage:
 *   node experiments/nemotron-quant-serving/throughput-probe.mjs \
 *     --base-url https://<host>/v1 --model nemotron-3-nano-fp8 \
 *     --gpu B200 --gpu-usd-per-hour 6.25 --out outputs/throughput-fp8.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const baseUrl = argValue("--base-url");
const model = argValue("--model");
if (!baseUrl || !model) throw new Error("--base-url and --model are required");
const gpu = argValue("--gpu", "unknown");
const gpuUsdPerHour = Number(argValue("--gpu-usd-per-hour", "0"));
const outTokens = Number(argValue("--out-tokens", "256"));
const concurrencies = argValue("--concurrency", "1,8")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => value > 0);
const repeats = Number(argValue("--repeats", "8"));
const outPath = argValue("--out");
const apiKey = process.env.QUANT_SERVE_API_KEY ?? "";

// Public, synthetic prompt shaped like the fixture's traffic: a tool-use system
// preamble plus one business-app instruction. No customer text.
const PROMPT = [
  "You operate business apps through two tools: api_search and api_fetch.",
  "Reply with exactly one JSON object naming a tool and its arguments.",
  "Task: list the CRM contacts, find the one whose email is dana@example.test,",
  "and describe the single API call you would make to set that contact's owner to Rae.",
].join("\n");

const headers = {
  "content-type": "application/json",
  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
};

/** One streamed completion; returns TTFT and the decode window separately. */
async function streamOnce() {
  const started = performance.now();
  let firstTokenAt = null;
  let completionTokens = 0;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: PROMPT }],
      temperature: 0,
      max_tokens: outTokens,
      // Fixes the output length so every lane decodes the same token budget.
      ignore_eos: true,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!response.ok) throw new Error(`probe failed ${response.status}: ${(await response.text()).slice(0, 200)}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta ?? {};
      const text = delta.content ?? delta.reasoning_content ?? "";
      if (text && firstTokenAt === null) firstTokenAt = performance.now();
      if (chunk.usage?.completion_tokens) completionTokens = chunk.usage.completion_tokens;
    }
  }
  const finished = performance.now();
  return {
    ttft_ms: firstTokenAt === null ? null : firstTokenAt - started,
    total_ms: finished - started,
    decode_ms: firstTokenAt === null ? null : finished - firstTokenAt,
    completion_tokens: completionTokens || outTokens,
  };
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

async function measure(concurrency) {
  const started = performance.now();
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < repeats) {
        cursor += 1;
        results.push(await streamOnce());
      }
    }),
  );
  const wallSeconds = (performance.now() - started) / 1000;
  const completion = results.reduce((sum, row) => sum + row.completion_tokens, 0);
  const perRequestDecode = results
    .filter((row) => row.decode_ms)
    .map((row) => (row.completion_tokens / row.decode_ms) * 1000);
  return {
    concurrency,
    requests: results.length,
    completion_tokens: completion,
    wall_clock_s: Number(wallSeconds.toFixed(2)),
    // Aggregate: what the GPU-hour actually buys.
    output_tokens_per_s: Number((completion / wallSeconds).toFixed(1)),
    // Per-stream: what one user feels.
    median_per_request_decode_tokens_per_s: Number((median(perRequestDecode) ?? 0).toFixed(1)),
    median_ttft_ms: Number((median(results.map((row) => row.ttft_ms).filter((v) => v !== null)) ?? 0).toFixed(0)),
  };
}

async function main() {
  // Warm the engine so the first measured request is not a cold CUDA graph.
  await streamOnce();

  const ladder = [];
  for (const concurrency of concurrencies) ladder.push(await measure(concurrency));

  const peak = ladder.reduce((best, row) => (row.output_tokens_per_s > best.output_tokens_per_s ? row : best), ladder[0]);
  const report = {
    schema_version: "understudy.serving_throughput.v1",
    generated_at: new Date().toISOString(),
    model,
    gpu,
    gpu_usd_per_hour: gpuUsdPerHour || null,
    out_tokens_per_request: outTokens,
    ladder,
    peak_output_tokens_per_s: peak.output_tokens_per_s,
    // Only a price the caller supplied is used; never invent one.
    usd_per_million_output_tokens:
      gpuUsdPerHour > 0
        ? Number(((gpuUsdPerHour / (peak.output_tokens_per_s * 3600)) * 1_000_000).toFixed(2))
        : null,
  };

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}

await main();
