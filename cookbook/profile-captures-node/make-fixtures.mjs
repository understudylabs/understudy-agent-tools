#!/usr/bin/env node
// Generates synthetic gateway-capture envelopes for the profile-captures example.
// Everything here is invented — no real models' outputs, no customer data.
// Run: node make-fixtures.mjs [outDir]   (default ./captures/*.jsonl)

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ? process.argv[2] : join(here, "captures");
mkdirSync(outDir, { recursive: true });

// Anthropic-style SSE response body with a usage block.
function anthropicSSE({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  const start = {
    type: "message_start",
    message: { type: "message", role: "assistant", usage: {
      input_tokens: input, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
    } },
  };
  const delta = { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } };
  return [
    `event: message_start`, `data: ${JSON.stringify(start)}`, ``,
    `event: message_delta`, `data: ${JSON.stringify(delta)}`, ``,
    `event: message_stop`, `data: ${JSON.stringify({ type: "message_stop" })}`, ``,
  ].join("\n");
}

// OpenAI-style parsed response object with a usage block.
function openaiObject({ prompt = 0, completion = 0, cached = 0 }) {
  return JSON.stringify({
    object: "chat.completion",
    usage: { prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: cached } },
  });
}

function envelope({ model, mode = "reseller", ts, latency = 1500, request, response }) {
  return JSON.stringify({
    requested_model: model, provider: "synthetic", mode, ts, latency_ms: latency,
    customer_request_body: JSON.stringify(request), response_body: response,
  });
}

const BILLING = "x-anthropic-billing-header: synthetic; version=demo;";
const SDK_PREAMBLE = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

const files = {};

// 1) Agent-SDK worker loop — opus, tools, multi-turn, heavy cache read. (Hard to move.)
files["agent-worker.jsonl"] = Array.from({ length: 40 }, (_, i) => envelope({
  model: "claude-opus-4-6", ts: `2026-05-30T0${1 + (i % 8)}:00:00Z`, latency: 2300,
  request: {
    model: "claude-opus-4-6", max_tokens: 64000,
    system: [
      { type: "text", text: BILLING },
      { type: "text", text: SDK_PREAMBLE },
      { type: "text", text: "# Worker\nGiven the user's message, use the tools to complete the task. agent for Claude Code." },
    ],
    tools: ["bash", "read", "write", "edit", "glob", "grep"].map((n) => ({ name: n, input_schema: { type: "object" } })),
    messages: [{ role: "user", content: "turn 1" }, { role: "assistant", content: "..." }, { role: "user", content: "turn 2" }],
  },
  response: anthropicSSE({ input: 1200, output: 300, cacheRead: 26000, cacheWrite: 4000 }),
})).join("\n");

// 2) Orchestrator — opus, more tools, deeper loop. (Hard to move.)
files["agent-orchestrator.jsonl"] = Array.from({ length: 60 }, (_, i) => envelope({
  model: "claude-opus-4-6", ts: `2026-06-01T0${1 + (i % 8)}:00:00Z`, latency: 2200,
  request: {
    model: "claude-opus-4-6", max_tokens: 128000,
    system: [
      { type: "text", text: BILLING },
      { type: "text", text: "# Account Intelligence Agent\nYou are a specialized assistant. agent for Claude Code." },
    ],
    tools: ["bash", "read", "write", "edit", "glob", "grep", "skill", "task"].map((n) => ({ name: n, input_schema: { type: "object" } })),
    messages: Array.from({ length: 9 }, (_, k) => ({ role: k % 2 ? "assistant" : "user", content: "x" })),
  },
  response: anthropicSSE({ input: 800, output: 250, cacheRead: 22000, cacheWrite: 1500 }),
})).join("\n");

// 3) Quality-reviewer judge — opus, TOOLLESS, single-turn, structured JSON. (Prime candidate.)
files["judge.jsonl"] = Array.from({ length: 30 }, (_, i) => envelope({
  model: "claude-opus-4-6", ts: `2026-06-02T0${1 + (i % 8)}:00:00Z`, latency: 1700,
  request: {
    model: "claude-opus-4-6", max_tokens: 1024,
    system: "You are a quality reviewer. Return ONLY a valid JSON array of verdict objects — no prose.",
    messages: [{ role: "user", content: "review these records" }],
  },
  response: anthropicSSE({ input: 6600, output: 200, cacheRead: 0, cacheWrite: 0 }),
})).join("\n");

// 4) Structured extractor via an OpenAI-shaped client — priced mini model, single-turn, response_format. (Candidate.)
files["extractor-openai.jsonl"] = Array.from({ length: 20 }, (_, i) => envelope({
  model: "gpt-4o-mini", mode: "byo", ts: `2026-06-02T1${i % 9}:00:00Z`, latency: 900,
  request: {
    model: "gpt-4o-mini",
    response_format: { type: "json_schema", json_schema: { name: "record", schema: { type: "object" } } },
    messages: [{ role: "system", content: "# Field Extractor\nExtract structured fields as JSON." }, { role: "user", content: "input row" }],
  },
  response: openaiObject({ prompt: 1800, completion: 120, cached: 0 }),
})).join("\n");

// 5) Session-title generator — haiku, toolless, single-turn, NOT structured. (Cheap; not a candidate.)
files["title.jsonl"] = Array.from({ length: 25 }, (_, i) => envelope({
  model: "claude-haiku-4-5", ts: `2026-06-04T0${1 + (i % 8)}:00:00Z`, latency: 800,
  request: {
    model: "claude-haiku-4-5", max_tokens: 32,
    system: "Generate a concise title (3-7 words) for this session.",
    messages: [{ role: "user", content: "session text" }],
  },
  response: anthropicSSE({ input: 300, output: 12, cacheRead: 0, cacheWrite: 0 }),
})).join("\n");

// 6) A local open-weight call — unknown model => priced at $0. (Already local.)
files["local-open-weight.jsonl"] = Array.from({ length: 10 }, (_, i) => envelope({
  model: "gemma-4-e2b-it", mode: "byo", ts: `2026-06-04T1${i % 9}:00:00Z`, latency: 600,
  request: {
    model: "gemma-4-e2b-it",
    system: "You are a helper. Return ONLY JSON.",
    messages: [{ role: "user", content: "do it" }],
  },
  response: anthropicSSE({ input: 500, output: 60, cacheRead: 0, cacheWrite: 0 }),
})).join("\n");

for (const [name, body] of Object.entries(files)) {
  writeFileSync(join(outDir, name), body + "\n");
}
console.log(`wrote ${Object.keys(files).length} synthetic capture files to ${outDir}`);
