import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";

import {
  fixtureSha256 as automationFixtureSha256,
  finish as automationFinish,
  getTask as automationGetTask,
  oraclePolicy,
  partialCredit as automationPartialCredit,
  reset as automationReset,
  splitCounts as automationSplitCounts,
  splitSha256 as automationSplitSha256,
  step as automationStep,
  taskBands as automationTaskBands,
  taskPool as automationTaskPool,
  type Split as AutomationSplit,
  type StepResult,
  type Task as AutomationTask,
  type ToolCall,
} from "./automationbench-offline.js";
import {
  fixtureSha256 as syntheticFixtureSha256,
  finish as syntheticFinish,
  getTask as syntheticGetTask,
  partialCredit as syntheticPartialCredit,
  reset as syntheticReset,
  splitCounts as syntheticSplitCounts,
  splitSha256 as syntheticSplitSha256,
  step as syntheticStep,
  taskBands as syntheticTaskBands,
  taskPool as syntheticTaskPool,
} from "./synthetic-workflow-offline.js";
import {
  v2FixtureSha256,
  v2SplitCounts,
  v2SplitSha256,
  v2TaskBands,
  v2TaskPool,
} from "./automationbench-v2.js";

export const ACTION_PROTOCOL_SYSTEM_PROMPT = `You operate workflow apps by calling tools. Reply with exactly ONE JSON object and nothing else.

Allowed replies:
{"tool":"api_search","arguments":{"query":"<text>"}}
{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
{"tool":"finish","arguments":{}}

Look up any id you need before writing. Make the smallest change that satisfies the request, touch nothing else, then reply with the finish action.`;

export const AUTOMATIONBENCH_ACTION_PROTOCOL_SYSTEM_PROMPT_NEMOTRON_V1 = `You operate business apps by calling tools. Reply with exactly ONE JSON object and nothing else.

Allowed replies:
{"tool":"api_search","arguments":{"query":"<text>"}}
{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
{"tool":"finish","arguments":{}}

api_search is read-only endpoint discovery. api_fetch applies one API call and is the only way to change state. Endpoints: /crm/contacts (GET), /crm/contacts/{id} (GET, PATCH), /mail/drafts (GET, POST), /mail/drafts/{id} (GET, PATCH), /mail/messages (GET, POST with {"draft_id":"..."}).

Each tool result is returned to you as JSON. Look up any id you need before writing. Make the smallest change that satisfies the request, touch nothing else, then reply with the finish action.`;

export const MAX_MODEL_TURNS = 12;
export type BenchmarkName = "automationbench" | "automationbench-v2" | "synthetic-workflow";
export type PromptVariant = "default" | "nemotron-v1";
type Split = "train" | "dev" | "holdout";
type Adapter = {
  fixtureSha256: () => string;
  splitSha256: (split: Split) => string;
  splitCounts: () => Record<Split, number>;
  taskBands: () => Record<string, string>;
  getTask: (taskId: string) => any;
  taskPool: (options: { split: Split; frozenHoldoutSha256?: string }) => any[];
  reset: (taskId: string) => any;
  step: (handle: any, action: any) => any;
  finish: (handle: any) => any;
  partialCredit: (handle: any) => number;
};

function adapter(benchmark: BenchmarkName): Adapter {
  if (benchmark === "automationbench-v2") {
    return {
      fixtureSha256: v2FixtureSha256,
      splitSha256: v2SplitSha256,
      splitCounts: v2SplitCounts,
      taskBands: v2TaskBands,
      getTask: automationGetTask,
      taskPool: v2TaskPool,
      reset: automationReset,
      step: automationStep,
      finish: automationFinish,
      partialCredit: automationPartialCredit,
    };
  }
  return benchmark === "synthetic-workflow"
    ? {
      fixtureSha256: syntheticFixtureSha256,
      splitSha256: syntheticSplitSha256,
      splitCounts: syntheticSplitCounts,
      taskBands: syntheticTaskBands,
      getTask: syntheticGetTask,
      taskPool: syntheticTaskPool,
      reset: syntheticReset,
      step: syntheticStep,
      finish: syntheticFinish,
      partialCredit: syntheticPartialCredit,
    }
    : {
      fixtureSha256: automationFixtureSha256,
      splitSha256: automationSplitSha256,
      splitCounts: automationSplitCounts,
      taskBands: automationTaskBands,
      getTask: automationGetTask,
      taskPool: automationTaskPool,
      reset: automationReset,
      step: automationStep,
      finish: automationFinish,
      partialCredit: automationPartialCredit,
    };
}

type Episode = {
  episodeId: string;
  taskId: string;
  handle: any;
  finished: boolean;
  task: any;
  benchmark: BenchmarkName;
  systemPrompt: string;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function taskFamily(task: any): string {
  if (typeof task.family === "string") return task.family;
  const id = String(task.taskId);
  return id.startsWith("simple-api-") ? id.slice("simple-api-".length, -3) : id;
}

function taskSummary(task: any, bands: Record<string, string>) {
  return {
    task_id: task.taskId,
    split: task.split,
    family: taskFamily(task),
    band: task.band ?? bands[taskFamily(task)] ?? "single-write",
    prompt: task.prompt,
  };
}

function promptForVariant(promptVariant: PromptVariant): string {
  return promptVariant === "nemotron-v1"
    ? AUTOMATIONBENCH_ACTION_PROTOCOL_SYSTEM_PROMPT_NEMOTRON_V1
    : ACTION_PROTOCOL_SYSTEM_PROMPT;
}

function parsePromptVariant(value: unknown): PromptVariant {
  if (value === undefined || value === null || value === "") return "default";
  if (value === "default" || value === "nemotron-v1") return value;
  throw new Error("prompt_variant must be default or nemotron-v1");
}

function checkHoldoutAccess(
  env: Adapter,
  taskId: string,
  frozenHoldoutSha256: string | undefined,
): Record<string, unknown> {
  const task = env.getTask(taskId) as Record<string, unknown>;
  const split = task.split as Split;
  const available = env.taskPool({ split, frozenHoldoutSha256 }) as Array<Record<string, unknown>>;
  if (!available.some((candidate) => candidate.taskId === taskId)) {
    throw new Error(`task is not available in ${split}; holdout access requires the frozen-holdout hash`);
  }
  return task;
}

export type ParsedAgentAction =
  | { name: string; arguments: Record<string, unknown>; encoding: "json-text" | "tool-call-wrapper" }
  | { finish: true; encoding: "finish-wrapper" | "json-text" }
  | { error: string };

export type OracleTrajectory = {
  task_id: string;
  split: AutomationSplit;
  family: string;
  band: string;
  reward: number;
  forbidden_effects: string[];
  messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[];
};

function extractFirstBalancedJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function parseAgentAction(text: string): ParsedAgentAction {
  const source = String(text ?? "").trim();
  if (!source) return { error: "empty assistant message" };
  if (/<finish\s*\/>/i.test(source)) return { finish: true, encoding: "finish-wrapper" };
  const wrapper = source.match(/<tool_call\b[^>]*>\s*([\s\S]*?)\s*<\/tool_call>/i);
  const candidate = extractFirstBalancedJsonObject(wrapper?.[1] ?? source);
  if (!candidate) return { error: "assistant message does not contain a balanced JSON object" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return { error: `invalid JSON action: ${(error as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "assistant action must be a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  const encoding = wrapper ? "tool-call-wrapper" : "json-text";
  if (record.finish === true || record.tool === "finish" || record.name === "finish") {
    return { finish: true, encoding: "json-text" };
  }
  const name = typeof record.tool === "string" ? record.tool : typeof record.name === "string" ? record.name : "";
  if (!name) return { error: "assistant action missing tool/name" };
  let argumentsObject: unknown = record.arguments ?? {};
  if (typeof argumentsObject === "string") {
    try {
      argumentsObject = JSON.parse(argumentsObject);
    } catch (error) {
      return { error: `assistant action arguments are not valid JSON: ${(error as Error).message}` };
    }
  }
  if (!argumentsObject || typeof argumentsObject !== "object" || Array.isArray(argumentsObject)) {
    return { error: "assistant action arguments must be a JSON object" };
  }
  return { name, arguments: argumentsObject as Record<string, unknown>, encoding };
}

export function renderToolObservation(stepResult: StepResult): string {
  const toolMessage = stepResult.obs.messages.at(-1);
  if (!toolMessage || toolMessage.role !== "tool") throw new Error("step result does not contain a tool observation");
  return toolMessage.content;
}

function serializeAgentAction(action: ToolCall | { name: "finish"; arguments: Record<string, never> }): string {
  return `{"tool":"${action.name}","arguments":${JSON.stringify(action.arguments)}}`;
}

export function replayOracleTrajectory(
  taskId: string,
  promptVariant: PromptVariant = "nemotron-v1",
  benchmark: BenchmarkName = "automationbench",
): OracleTrajectory {
  const systemPrompt = promptForVariant(promptVariant);
  const env = adapter(benchmark);
  const task = env.getTask(taskId) as AutomationTask;
  const { handle, obs: initialObservation } = env.reset(taskId);
  handle.messages[0] = { role: "system", content: systemPrompt };
  const messages: OracleTrajectory["messages"] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task.prompt },
  ];
  const policy = oraclePolicy(taskId);
  let obs = initialObservation;
  obs.messages[0] = { role: "system", content: systemPrompt };
  while (true) {
    const action = policy(obs);
    if (!action) break;
    messages.push({ role: "assistant", content: serializeAgentAction(action) });
    const result = env.step(handle, action);
    obs = result.obs;
    messages.push({ role: "tool", content: renderToolObservation(result) });
  }
  messages.push({ role: "assistant", content: serializeAgentAction({ name: "finish", arguments: {} }) });
  const terminal = handle.done ? { reward: env.partialCredit(handle) } : env.finish(handle);
  const family = taskFamily(task);
  return {
    task_id: task.taskId,
    split: task.split,
    family,
    band: env.taskBands()[family] ?? "single-write",
    reward: terminal.reward,
    forbidden_effects: [...handle.forbiddenEffects],
    messages,
  };
}

function parseBody(raw: string): Record<string, unknown> {
  const body = raw ? JSON.parse(raw) : {};
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be an object");
  }
  return body as Record<string, unknown>;
}

async function route(
  request: IncomingMessage,
  episodes: Map<string, Episode>,
  benchmark: BenchmarkName,
  configuredPromptVariant: PromptVariant,
): Promise<Response> {
  const env = adapter(benchmark);
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const requestedPromptVariant = url.searchParams.get("prompt_variant");
  if (request.method === "GET" && url.pathname === "/health") return jsonResponse({ ok: true, benchmark });
  if (request.method === "GET" && url.pathname === "/protocol") {
    try {
      const promptVariant = parsePromptVariant(requestedPromptVariant ?? configuredPromptVariant);
      return jsonResponse({ system_prompt: promptForVariant(promptVariant), prompt_variant: promptVariant, max_model_turns: MAX_MODEL_TURNS });
    } catch (error) {
      return jsonResponse({ error: (error as Error).message }, 400);
    }
  }
  if (request.method === "GET" && url.pathname === "/hashes") {
    return jsonResponse({
      ...(benchmark === "automationbench-v2"
        ? { benchmark_id: "automationbench-simple-api-offline-v2" }
        : {}),
      fixture_sha256: env.fixtureSha256(),
      split_sha256: {
        train: env.splitSha256("train"),
        dev: env.splitSha256("dev"),
        holdout: env.splitSha256("holdout"),
      },
      counts: env.splitCounts(),
    });
  }
  if (request.method === "GET" && url.pathname === "/tasks") {
    const split = url.searchParams.get("split");
    if (split !== "train" && split !== "dev" && split !== "holdout") return jsonResponse({ error: "invalid split" }, 400);
    try {
      const frozen = url.searchParams.get("frozen_holdout_sha256") ?? undefined;
      return jsonResponse(env.taskPool({ split, frozenHoldoutSha256: frozen }).map((task) => taskSummary(task, env.taskBands())));
    } catch (error) {
      return jsonResponse({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  }
  if (request.method === "GET" && (url.pathname.startsWith("/oracle/") || url.pathname.startsWith("/oracle-trajectory/"))) {
    if (benchmark !== "automationbench" && benchmark !== "automationbench-v2") {
      return jsonResponse({ error: "oracle trajectories are only available for automationbench" }, 404);
    }
    const prefix = url.pathname.startsWith("/oracle-trajectory/") ? "/oracle-trajectory/" : "/oracle/";
    const taskId = decodeURIComponent(url.pathname.slice(prefix.length));
    try {
      const frozen = url.searchParams.get("frozen_holdout_sha256") ?? undefined;
      checkHoldoutAccess(env, taskId, frozen);
      const promptVariant = parsePromptVariant(requestedPromptVariant ?? configuredPromptVariant);
      return jsonResponse(replayOracleTrajectory(taskId, promptVariant, benchmark));
    } catch (error) {
      return jsonResponse({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  }
  if (request.method === "POST" && url.pathname === "/reset") {
    try {
      const body = parseBody(await readBody(request));
      const taskId = typeof body.task_id === "string" ? body.task_id : "";
      if (!taskId) return jsonResponse({ error: "task_id is required" }, 400);
      const frozen = typeof body.frozen_holdout_sha256 === "string" ? body.frozen_holdout_sha256 : undefined;
      const task = checkHoldoutAccess(env, taskId, frozen);
      const promptVariant = parsePromptVariant(body.prompt_variant ?? configuredPromptVariant);
      const { handle, obs } = env.reset(taskId);
      const systemPrompt = promptForVariant(promptVariant);
      if (benchmark === "automationbench" || benchmark === "automationbench-v2") {
        handle.messages[0] = { role: "system", content: systemPrompt };
      }
      const episodeId = randomUUID();
      episodes.set(episodeId, { episodeId, taskId, handle, task, finished: false, benchmark, systemPrompt });
      return jsonResponse({
        episode_id: episodeId,
        task_id: taskId,
        prompt: task.prompt,
        system_prompt: systemPrompt,
        tools: obs.tools,
        prompt_variant: promptVariant,
      });
    } catch (error) {
      return jsonResponse({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  }
  if (request.method === "POST" && url.pathname === "/step") {
    try {
      const body = parseBody(await readBody(request));
      const episodeId = typeof body.episode_id === "string" ? body.episode_id : "";
      const action = body.action;
      const episode = episodes.get(episodeId);
      if (!episode) return jsonResponse({ error: "unknown episode" }, 404);
      if (!action || typeof action !== "object" || Array.isArray(action)) return jsonResponse({ error: "action must be an object" }, 400);
      const result = env.step(episode.handle, action);
      episode.finished = result.done;
      const toolMessage = result.obs.messages.at(-1);
      return jsonResponse({ observation: toolMessage?.content ?? "", step: result.obs.step, done: result.done });
    } catch (error) {
      return jsonResponse({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  }
  if (request.method === "POST" && url.pathname === "/finish") {
    try {
      const body = parseBody(await readBody(request));
      const episode = episodes.get(String(body.episode_id ?? ""));
      if (!episode) return jsonResponse({ error: "unknown episode" }, 404);
      const result = episode.handle.done ? { reward: env.partialCredit(episode.handle) } : env.finish(episode.handle);
      episode.finished = true;
      episodes.delete(episode.episodeId);
      return jsonResponse({ reward: result.reward, steps: episode.handle.step, forbidden_effects: [...episode.handle.forbiddenEffects] });
    } catch (error) {
      return jsonResponse({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/episode/")) {
    episodes.delete(url.pathname.slice("/episode/".length));
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "not found" }, 404);
}

export async function startEnvService(
  { port = 0, benchmark = "automationbench", promptVariant = "default" }: { port?: number; benchmark?: BenchmarkName; promptVariant?: PromptVariant } = {},
): Promise<{ server: Server; port: number }> {
  const episodes = new Map<string, Episode>();
  const server = createServer((request, response) => {
    void route(request, episodes, benchmark, promptVariant).then(async (result) => {
      response.statusCode = result.status;
      for (const [key, value] of result.headers.entries()) response.setHeader(key, value);
      response.end(await result.text());
    }).catch((error) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to start env service");
  return { server, port: address.port };
}
