#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  GROUNDED_CHAT_FIXTURE,
  evaluateTask,
  splitSha256,
  taskPool,
} from "../dist/grounded-chat-offline.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const model = argValue("--model");
const baseUrl = argValue("--base-url");
const split = argValue("--split", "dev");
const temperature = Number(argValue("--temperature", "0"));
const samplesPerTask = Number(argValue("--samples-per-task", "1"));
const concurrency = Number(argValue("--concurrency", "8"));
const outPath = argValue("--out");
const frozenHoldout = argValue("--frozen-holdout");
if (!model) throw new Error("--model is required");
if (!baseUrl) throw new Error("--base-url is required");
if (!outPath) throw new Error("--out is required");
if (!["train", "dev", "holdout"].includes(split)) throw new Error("--split must be train, dev, or holdout");
if (!Number.isFinite(temperature) || temperature < 0) throw new Error("--temperature must be non-negative");
if (!Number.isInteger(samplesPerTask) || samplesPerTask < 1) throw new Error("--samples-per-task must be a positive integer");
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
if (split === "holdout" && frozenHoldout !== splitSha256("holdout")) {
  throw new Error(`holdout requires --frozen-holdout ${splitSha256("holdout")}`);
}

const apiKey = process.env.FIREWORKS_API_KEY ?? "local-shim";
const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
const pool = taskPool({
  split,
  ...(split === "holdout" ? { frozenHoldoutSha256: frozenHoldout } : {}),
});

async function request(task) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        {
          role: "system",
          content: [
            "Answer the user's question using only the synthetic workspace context.",
            "Do not invent facts. If the requested information is absent, say so and name the asked-about entity.",
            "Return only the concise natural-language answer.",
          ].join(" "),
        },
        { role: "user", content: `Workspace context:\n${task.context}\n\nQuestion: ${task.question}` },
      ],
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`chat failed ${response.status}: ${detail}`);
  }
  const payload = await response.json();
  return {
    answer: payload.choices?.[0]?.message?.content ?? "",
    usage: payload.usage ?? {},
  };
}

const jobs = pool.flatMap((task) => Array.from({ length: samplesPerTask }, (_, sampleIndex) => ({ task, sampleIndex })));
const rows = Array.from({ length: jobs.length });
let nextJob = 0;
async function worker() {
  while (nextJob < jobs.length) {
    const jobIndex = nextJob;
    nextJob += 1;
    const { task, sampleIndex } = jobs[jobIndex];
    try {
      const response = await request(task);
      const result = evaluateTask(task.taskId, response.answer);
      rows[jobIndex] = {
        task_id: task.taskId,
        split,
        band: task.band,
        sample_index: sampleIndex,
        score: result.score,
        fabrication: result.fabrication,
        over_budget: result.overBudget,
        answer: response.answer,
        usage: response.usage,
      };
    } catch (error) {
      rows[jobIndex] = {
        task_id: task.taskId,
        split,
        band: task.band,
        sample_index: sampleIndex,
        score: 0,
        fabrication: false,
        over_budget: false,
        answer: "",
        usage: {},
        error: String(error?.message ?? error),
      };
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));

const artifact = {
  schema_version: "understudy.grounded_chat_eval.v1",
  fixture_id: GROUNDED_CHAT_FIXTURE.fixture_id,
  model,
  split,
  temperature,
  samples_per_task: samplesPerTask,
  split_sha256: splitSha256(split),
  rows,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
const mean = rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.score, 0) / rows.length;
console.log(`${split} tasks=${pool.length} episodes=${rows.length} mean_score=${mean.toFixed(4)} fabrications=${rows.filter((row) => row.fabrication).length}`);
