/**
 * The single serving contract every arm of the multi-base bake-off runs under.
 *
 * One verifier (the AutomationBench v2 offline env, imported from `dist/` — no
 * second copy of the environment), one protocol (one JSON tool call per turn,
 * malformed emissions rejected and never repaired), one set of decoding and
 * budget parameters. A base, its SFT checkpoint, and its GRPO checkpoint are
 * all scored through this module, so the only thing that differs between two
 * rows of the ranked table is the weights and the lane they are served on.
 *
 * The system prompt and parser are byte-identical to
 * `scripts/automationbench-v2-zeroshot.mjs`, which is what makes the base rung
 * here comparable to the published zero-shot difficulty table.
 */
import { createHash } from "node:crypto";

import { finish, partialCredit, reset, step } from "../../dist/automationbench-offline.js";

export const CONTRACT_ID = "understudy.bakeoff.serving_contract.v1";

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

/** Decoding and budget parameters. Every rung of the ladder uses exactly these. */
export const PARAMS = {
  fixture: "automationbench-simple-api-offline-v2",
  protocol: "json-text-one-call-per-turn",
  temperature: 0,
  max_tokens: 2000,
  max_turns: 14,
  malformed_tolerance: 3,
  observation_char_budget: 4000,
};

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

/** Content hash over the contract text and parameters — printed into every artifact. */
export function contractSha256() {
  return createHash("sha256").update(JSON.stringify({ id: CONTRACT_ID, system: SYSTEM, params: PARAMS, parser: parseAction.toString() })).digest("hex");
}

export function taskFamily(taskId) {
  return taskId.replace(/^(?:simple|hard)-api-/, "").replace(/-\d{2}$/, "");
}

/**
 * Drive one task to termination.
 *
 * `chat(messages)` must resolve `{ text, promptTokens, completionTokens }`; the
 * episode records its own per-request wall clock, so latency is measured on the
 * same side of the wire for every lane.
 */
export async function runEpisode(task, chat) {
  const { handle } = reset(task.taskId);
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task.prompt },
  ];
  const latencies = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let malformed = 0;
  let consecutiveMalformed = 0;
  let ended = "budget";
  let error = null;
  const episodeStarted = Date.now();

  try {
    for (let turn = 0; turn < PARAMS.max_turns && !handle.done; turn += 1) {
      const requestStarted = Date.now();
      const reply = await chat(messages);
      latencies.push((Date.now() - requestStarted) / 1000);
      promptTokens += reply.promptTokens ?? 0;
      completionTokens += reply.completionTokens ?? 0;
      messages.push({ role: "assistant", content: reply.text || "(empty)" });
      const parsed = parseAction(reply.text);
      if (parsed.finish) {
        ended = "finish";
        break;
      }
      if (parsed.error) {
        malformed += 1;
        consecutiveMalformed += 1;
        if (consecutiveMalformed >= PARAMS.malformed_tolerance) {
          ended = "malformed";
          break;
        }
        messages.push({ role: "user", content: `rejected: ${parsed.error}. Reply with exactly one JSON tool object.` });
        continue;
      }
      consecutiveMalformed = 0;
      const result = step(handle, parsed.action);
      messages.push({ role: "user", content: result.obs.messages.at(-1).content.slice(0, PARAMS.observation_char_budget) });
      if (result.done) ended = "budget";
    }
  } catch (cause) {
    error = String(cause?.message ?? cause);
    ended = "error";
  }

  const score = handle.done ? partialCredit(handle) : finish(handle).reward;
  const family = taskFamily(task.taskId);
  return {
    row: {
      task_id: task.taskId,
      family,
      tier: task.taskId.startsWith("hard-") ? "hard" : "v1",
      split: task.split,
      score: error ? null : score,
      steps: handle.step,
      ended,
      malformed,
      forbidden_effects: handle.forbiddenEffects.length,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      requests: latencies.length,
      request_latencies_s: latencies.map((value) => Math.round(value * 1000) / 1000),
      episode_latency_s: Math.round((Date.now() - episodeStarted) / 10) / 100,
      error,
    },
    messages,
  };
}
