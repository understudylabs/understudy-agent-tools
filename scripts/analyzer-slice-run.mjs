#!/usr/bin/env node

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  analyzerSplitSha256,
  analyzerTaskPool,
  scoreVerdict,
} from "../dist/analyzer-slice.js";

const value = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const result = process.argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
  return result;
};
const model = value("--model");
if (!model) throw new Error("--model is required");
const baseUrl = value("--base-url", "http://localhost:8099/v1").replace(/\/$/, "");
const split = value("--split", "dev");
const frozenHoldoutSha256 = value("--frozen-holdout");
const samples = Number(value("--samples", "1"));
const temperature = Number(value("--temperature", "0"));
const maxTokens = Number(value("--max-tokens", "512"));
const concurrency = Math.max(1, Number(value("--concurrency", "6")));
const limit = Number(value("--limit", "0"));
const outPath = value("--out");
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
if (samples > 1 && temperature === 0) throw new Error("--samples > 1 requires non-zero --temperature");

const pool = analyzerTaskPool({ split, frozenHoldoutSha256 });
const tasks = limit > 0 ? pool.slice(0, limit) : pool;
const endpoint = `${baseUrl}/chat/completions`;
const evidenceText = (task) => task.evidence.map((item) => `[${item.id}] (${item.kind}) ${item.text}`).join("\n");
const promptConversation = (task) => [
  { role: "system", content: task.prompt },
  { role: "user", content: evidenceText(task) },
];
const headers = { "content-type": "application/json" };
if (process.env.TINKER_API_KEY && !/^https?:\/\/localhost|^http:\/\/127\.0\.0\.1/.test(baseUrl)) headers.authorization = `Bearer ${process.env.TINKER_API_KEY}`;

const RETRY_ATTEMPTS = 3;
const retryDelayMs = (attempt) => 250 * (2 ** attempt);

async function runOne(task, sampleIndex) {
  const started = Date.now();
  const messages = promptConversation(task);
  let lastError = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      });
      const body = await response.json();
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${body.error?.message ?? "request failed"}`);
        if (![429, 500, 501, 502, 503, 504].includes(response.status) || attempt === RETRY_ATTEMPTS) throw error;
        lastError = error;
      } else {
        const rawOutput = body.choices?.[0]?.message?.content;
        if (typeof rawOutput !== "string") throw new Error("response has no choices[0].message.content");
        const scored = scoreVerdict(task, rawOutput);
        return {
          task_id: task.taskId, family: task.family, band: task.band, split, sample_index: sampleIndex,
          score: scored.score, forbidden: scored.forbidden, flags: scored.flags, raw_output: rawOutput,
          prompt_tokens: Number(body.usage?.prompt_tokens ?? 0), completion_tokens: Number(body.usage?.completion_tokens ?? 0),
          prompt_conversation: messages, error: null, attempts: attempt, elapsed_ms: Date.now() - started,
        };
      }
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_ATTEMPTS) break;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt - 1)));
  }
  return {
    task_id: task.taskId, family: task.family, band: task.band, split, sample_index: sampleIndex,
    score: 0, forbidden: ["request_error"], flags: { request_error: true }, raw_output: "",
    prompt_tokens: 0, completion_tokens: 0, prompt_conversation: messages,
    error: lastError instanceof Error ? lastError.message : String(lastError), attempts: RETRY_ATTEMPTS,
    elapsed_ms: Date.now() - started,
  };
}

const jobs = tasks.flatMap((task) => Array.from({ length: samples }, (_, sampleIndex) => ({ task, sampleIndex })));
const rows = [];
let cursor = 0;
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    rows.push(await runOne(job.task, job.sampleIndex));
  }
}
const started = Date.now();
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, worker));
rows.sort((a, b) => a.task_id.localeCompare(b.task_id) || a.sample_index - b.sample_index);

const scoredRows = (items) => items.filter((row) => !row.forbidden.includes("request_error"));
const mean = (items) => items.length ? items.reduce((sum, row) => sum + row.score, 0) / items.length : 0;
const aggregate = (items) => ({
  scored_row_count: items.length,
  task_count: new Set(items.map((row) => row.task_id)).size,
  mean_score: mean(items),
  exact_1_count: items.filter((row) => row.score === 1).length,
  zero_count: items.filter((row) => row.score === 0).length,
});
const grouped = (field) => Object.fromEntries([...new Set(rows.map((row) => row[field]))].sort().map((key) => [key, aggregate(scoredRows(rows.filter((row) => row[field] === key)))]));
const countReason = (reason) => rows.filter((row) => row.forbidden.includes(reason)).length;
const report = {
  fixture_id: "analyzer-verdict-offline-v1", model, split, split_sha256: analyzerSplitSha256(split),
  rows, summary: {
    scored_row_count: scoredRows(rows).length, request_error_episodes: countReason("request_error"),
    mean_score: mean(scoredRows(rows)), exact_1_rate: scoredRows(rows).length ? scoredRows(rows).filter((row) => row.score === 1).length / scoredRows(rows).length : 0,
    zero_rate: scoredRows(rows).length ? scoredRows(rows).filter((row) => row.score === 0).length / scoredRows(rows).length : 0,
    per_band: grouped("band"), per_family: grouped("family"),
    over_claim_episodes: countReason("over_claim"), hallucinated_citation_episodes: countReason("hallucinated_citation"),
    invalid_output_episodes: countReason("invalid_output"), prompt_tokens: rows.reduce((sum, row) => sum + row.prompt_tokens, 0),
    completion_tokens: rows.reduce((sum, row) => sum + row.completion_tokens, 0), wall_clock_ms: Date.now() - started,
  },
};
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
