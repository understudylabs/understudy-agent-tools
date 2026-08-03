import { finish, partialCredit, reset, step } from "../dist/automationbench-offline.js";
import { v2TaskBands } from "../dist/automationbench-v2.js";

import {
  ACTION_PROTOCOL_SYSTEM_PROMPT as SYSTEM,
  parseAction,
} from "../dist/automationbench-action-protocol.js";

export { SYSTEM, parseAction };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createEpisodeRunner(config) {
  const captureMalformed = Number(config.captureMalformed ?? 0);
  const isLocalEndpoint = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(config.baseUrl);
  const apiKey = config.apiKey ?? process.env.FIREWORKS_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey && !isLocalEndpoint) throw new Error("FIREWORKS_API_KEY or OPENAI_API_KEY is required (never hard-code it)");

  async function chat(messages, attempt = 0) {
    const headers = { "content-type": "application/json" };
    if (!isLocalEndpoint) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      if ((response.status === 429 || response.status >= 500) && attempt < 6) {
        await sleep(2000 * 2 ** attempt + Math.floor(Math.random() * 500));
        return chat(messages, attempt + 1);
      }
      throw new Error(`chat failed ${response.status}: ${detail}`);
    }
    const payload = await response.json();
    return {
      text: payload.choices?.[0]?.message?.content ?? "",
      finishReason: payload.choices?.[0]?.finish_reason ?? null,
      promptTokens: payload.usage?.prompt_tokens ?? 0,
      completionTokens: payload.usage?.completion_tokens ?? 0,
    };
  }

  return async function runTask(task) {
    const { handle } = reset(task.taskId);
    const messages = [
      { role: "system", content: config.systemPrompt ?? SYSTEM },
      { role: "user", content: task.prompt },
    ];
    let promptTokens = 0;
    let completionTokens = 0;
    let malformed = 0;
    let consecutiveMalformed = 0;
    let ended = "budget";
    let error = null;
    const malformedDetails = [];

    try {
      for (let turn = 0; turn < config.maxTurns && !handle.done; turn += 1) {
        const reply = await chat(messages);
        promptTokens += reply.promptTokens;
        completionTokens += reply.completionTokens;
        messages.push({ role: "assistant", content: reply.text || "(empty)" });
        const parsed = parseAction(reply.text);
        if (parsed.finish) {
          ended = "finish";
          break;
        }
        if (parsed.error) {
          if (malformedDetails.length < captureMalformed) {
            malformedDetails.push({
              turn,
              text: reply.text,
              finish_reason: reply.finishReason,
              error: parsed.error,
            });
          }
          malformed += 1;
          consecutiveMalformed += 1;
          if (consecutiveMalformed >= config.malformedTolerance) {
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
    const family = task.taskId.replace(/^(?:simple|hard)-api-/, "").replace(/-\d{2}$/, "");
    return {
      task_id: task.taskId,
      family,
      band: v2TaskBands()[family] ?? null,
      tier: task.taskId.startsWith("hard-") ? "hard" : "v1",
      split: task.split,
      score: error ? null : score,
      steps: handle.step,
      ended,
      malformed,
      forbidden_effects: handle.forbiddenEffects.length,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      error,
      ...(captureMalformed > 0 ? { malformed_details: malformedDetails } : {}),
    };
  };
}

export function summarizeRows({ model, split, poolSize, rows, started, concurrency }) {
  const scored = rows.filter((row) => typeof row.score === "number");
  const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
  const byTier = {};
  const byFamily = {};
  const byBand = {};
  for (const row of scored) {
    (byTier[row.tier] ??= []).push(row.score);
    (byFamily[row.family] ??= []).push(row.score);
    (byBand[row.band] ??= []).push(row.score);
  }
  const stepsByBand = {};
  const forbiddenByBand = {};
  for (const row of scored) {
    (stepsByBand[row.band] ??= []).push(row.steps);
    (forbiddenByBand[row.band] ??= []).push(row.forbidden_effects);
  }
  const report = {
    model,
    split,
    ...(concurrency === undefined ? {} : { concurrency }),
    fixture: "automationbench-simple-api-offline-v2",
    pool_size: poolSize,
    sampled: rows.length,
    scored: scored.length,
    errors: rows.length - scored.length,
    mean_score: mean(scored.map((row) => row.score)),
    exact_1_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 1).length / scored.length,
    zero_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 0).length / scored.length,
    mean_by_tier: Object.fromEntries(Object.entries(byTier).map(([key, values]) => [key, mean(values)])),
    mean_by_family: Object.fromEntries(Object.entries(byFamily).map(([key, values]) => [key, mean(values)])),
    mean_by_band: Object.fromEntries(Object.entries(byBand).map(([key, values]) => [key, mean(values)])),
    mean_steps: mean(scored.map((row) => row.steps)),
    mean_steps_by_band: Object.fromEntries(Object.entries(stepsByBand).map(([key, values]) => [key, mean(values)])),
    total_forbidden_effects: scored.reduce((sum, row) => sum + row.forbidden_effects, 0),
    forbidden_effect_rate_by_band: Object.fromEntries(
      Object.entries(forbiddenByBand).map(([key, values]) => [
        key,
        values.length === 0 ? null : values.filter((value) => value > 0).length / values.length,
      ]),
    ),
    forbidden_effect_rate: scored.length === 0 ? null : scored.filter((row) => row.forbidden_effects > 0).length / scored.length,
    malformed_rate: rows.length === 0 ? null : rows.filter((row) => row.malformed > 0).length / rows.length,
    prompt_tokens: rows.reduce((sum, row) => sum + row.prompt_tokens, 0),
    completion_tokens: rows.reduce((sum, row) => sum + row.completion_tokens, 0),
    wall_clock_s: Math.round((Date.now() - started) / 1000),
    rows: rows.sort((a, b) => a.task_id.localeCompare(b.task_id)),
  };
  return report;
}
