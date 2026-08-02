// This GEPA runner intentionally coexists with scripts/automationbench-v2-episode.mjs:
// GEPA needs per-episode feedback, transcripts, and token accounting, while the
// zeroshot probe follows the upstream runner's fixture/report contract. Their v2
// scoring paths remain equivalent; only reporting and observability differ.
import { finish, partialCredit, reset, step } from "../../dist/automationbench-offline.js";

export const DEFAULT_SYSTEM = [
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
  // Reasoning bases emit a think block before the call; it is scratch, not a tool call.
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeChat({ baseUrl, apiKey, model, temperature, maxTokens }) {
  async function chat(messages, attempt = 0) {
    const headers = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      // Serverless rate limits are a throughput artefact, not a benchmark signal.
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
  return chat;
}

function familyForTask(task) {
  return task.taskId.replace(/^(?:simple|hard)-api-/, "").replace(/-\d{2}$/, "");
}

function tierForTask(task) {
  return task.taskId.startsWith("hard-") ? "hard" : "v1";
}

function transcriptEntry(role, content) {
  return { role, content: String(content ?? "").slice(0, 800) };
}

export async function runEpisode({ task, systemPrompt, chat, maxTurns, malformedTolerance, band }) {
  const { handle } = reset(task.taskId);
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task.prompt },
  ];
  const transcript = [
    transcriptEntry("system", systemPrompt),
    transcriptEntry("user", task.prompt),
  ];
  let promptTokens = 0;
  let completionTokens = 0;
  let malformed = 0;
  let consecutiveMalformed = 0;
  let ended = "budget";
  let error = null;
  const parserErrors = [];
  let apiFetchWrites = 0;
  let apiSearches = 0;
  let writeBeforeFirstRead = false;
  let sawRead = false;

  try {
    for (let turn = 0; turn < maxTurns && !handle.done; turn += 1) {
      const reply = await chat(messages);
      promptTokens += reply.promptTokens;
      completionTokens += reply.completionTokens;
      messages.push({ role: "assistant", content: reply.text || "(empty)" });
      transcript.push(transcriptEntry("assistant", reply.text || "(empty)"));
      const parsed = parseAction(reply.text);
      if (parsed.finish) {
        ended = "finish";
        break;
      }
      if (parsed.error) {
        malformed += 1;
        consecutiveMalformed += 1;
        parserErrors.push(parsed.error);
        if (consecutiveMalformed >= malformedTolerance) {
          ended = "malformed";
          break;
        }
        const rejection = `rejected: ${parsed.error}. Reply with exactly one JSON tool object.`;
        messages.push({ role: "user", content: rejection });
        transcript.push(transcriptEntry("user", rejection));
        continue;
      }
      consecutiveMalformed = 0;
      if (parsed.action.name === "api_search") {
        apiSearches += 1;
        sawRead = true;
      } else if (parsed.action.name === "api_fetch") {
        const method = String(parsed.action.arguments.method ?? "GET").toUpperCase();
        if (method !== "GET") {
          apiFetchWrites += 1;
          if (!sawRead) writeBeforeFirstRead = true;
        }
      }
      const result = step(handle, parsed.action);
      const observation = result.obs.messages.at(-1).content;
      messages.push({ role: "user", content: observation.slice(0, 4000) });
      transcript.push(transcriptEntry("user", observation));
      if (result.done) ended = "budget";
    }
  } catch (cause) {
    error = String(cause?.message ?? cause);
    ended = "error";
  }

  const score = handle.done ? partialCredit(handle) : finish(handle).reward;
  const feedbackParts = [`score ${error ? "unscored" : score}`];
  if (error) feedbackParts.push(`episode error: ${error}`);
  else feedbackParts.push(`episode ended by ${ended}`);
  if (ended === "malformed") feedbackParts.push("episode ended after malformed/rejected model output");
  if (parserErrors.length > 0) {
    feedbackParts.push(`malformed/rejection count ${malformed} (${[...new Set(parserErrors)].join("; ")})`);
  } else {
    feedbackParts.push(`malformed/rejection count ${malformed}`);
  }
  if (handle.forbiddenEffects.length > 0) {
    feedbackParts.push(`forbidden-effect count ${handle.forbiddenEffects.length}; any out-of-scope write zeroes the episode`);
  } else {
    feedbackParts.push("forbidden-effect count 0");
  }
  feedbackParts.push(`${apiFetchWrites} api_fetch writes vs ${apiSearches} api_search reads`);
  if (writeBeforeFirstRead) feedbackParts.push("a write happened before the first read");
  feedbackParts.push(`${handle.step} steps used of ${maxTurns}`);
  return {
    task_id: task.taskId,
    family: familyForTask(task),
    tier: tierForTask(task),
    band: band ?? null,
    split: task.split,
    score: error ? null : score,
    steps: handle.step,
    ended,
    malformed,
    forbidden_effects: handle.forbiddenEffects.length,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    error,
    feedback: feedbackParts.join(" — "),
    transcript,
  };
}

export function summarize(rows, { bands = {} } = {}) {
  const scored = rows.filter((row) => typeof row.score === "number");
  const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
  const byTier = {};
  const byFamily = {};
  const byBand = {};
  for (const row of scored) {
    (byTier[row.tier] ??= []).push(row.score);
    (byFamily[row.family] ??= []).push(row.score);
    const band = row.band ?? bands[row.family];
    if (band) (byBand[band] ??= []).push(row.score);
  }
  return {
    scored: scored.length,
    errors: rows.length - scored.length,
    mean_score: mean(scored.map((row) => row.score)),
    exact_1_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 1).length / scored.length,
    zero_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 0).length / scored.length,
    mean_by_tier: Object.fromEntries(Object.entries(byTier).map(([key, values]) => [key, mean(values)])),
    mean_by_family: Object.fromEntries(Object.entries(byFamily).map(([key, values]) => [key, mean(values)])),
    mean_by_band: Object.fromEntries(Object.entries(byBand).map(([key, values]) => [key, mean(values)])),
    forbidden_effect_rate: scored.length === 0 ? null : scored.filter((row) => row.forbidden_effects > 0).length / scored.length,
    malformed_rate: rows.length === 0 ? null : rows.filter((row) => row.malformed > 0).length / rows.length,
    prompt_tokens: rows.reduce((sum, row) => sum + row.prompt_tokens, 0),
    completion_tokens: rows.reduce((sum, row) => sum + row.completion_tokens, 0),
  };
}
