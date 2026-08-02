import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";

import {
  fixtureSha256 as automationFixtureSha256,
  finish as automationFinish,
  getTask as automationGetTask,
  oraclePolicy as automationOraclePolicy,
  partialCredit as automationPartialCredit,
  reset as automationReset,
  splitCounts as automationSplitCounts,
  splitSha256 as automationSplitSha256,
  step as automationStep,
  taskBands as automationTaskBands,
  taskPool as automationTaskPool,
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

export const BASELINE_ACTION_PROTOCOL_SYSTEM_PROMPT = `You operate business apps by calling tools. Reply with exactly ONE JSON object and nothing else.

Allowed replies:
{"tool":"api_search","arguments":{"query":"<text>"}}
{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
{"tool":"finish","arguments":{}}

api_search is read-only endpoint discovery. api_fetch applies one API call and is the only way to change state. Endpoints: /crm/contacts (GET), /crm/contacts/{id} (GET, PATCH), /mail/drafts (GET, POST), /mail/drafts/{id} (GET, PATCH), /mail/messages (GET, POST with {"draft_id":"..."}).

Each tool result is returned to you as JSON. Look up any id you need before writing. Make the smallest change that satisfies the request, touch nothing else, then reply with the finish action.`;

export const ACTION_PROTOCOL_SYSTEM_PROMPT = BASELINE_ACTION_PROTOCOL_SYSTEM_PROMPT;

export const MAX_MODEL_TURNS = 12;
export type BenchmarkName = "automationbench" | "synthetic-workflow";
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
): Promise<Response> {
  const env = adapter(benchmark);
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") return jsonResponse({ ok: true, benchmark });
  if (request.method === "GET" && url.pathname === "/protocol") {
    return jsonResponse({
      system_prompt: ACTION_PROTOCOL_SYSTEM_PROMPT,
      tools: [
        { name: "api_search", description: "Read-only endpoint discovery. Args: {query: string}." },
        { name: "api_fetch", description: "Apply one API call. Args: {method: string, url: string, body?: object}." },
        { name: "finish", description: "End the episode and score the final state." },
      ],
      max_model_turns: MAX_MODEL_TURNS,
    });
  }
  if (request.method === "GET" && url.pathname === "/hashes") {
    return jsonResponse({
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
  if (request.method === "POST" && url.pathname === "/reset") {
    try {
      const body = parseBody(await readBody(request));
      const taskId = typeof body.task_id === "string" ? body.task_id : "";
      if (!taskId) return jsonResponse({ error: "task_id is required" }, 400);
      const task = env.getTask(taskId);
      env.taskPool({ split: task.split, frozenHoldoutSha256: typeof body.frozen_holdout_sha256 === "string" ? body.frozen_holdout_sha256 : undefined });
      const { handle } = env.reset(taskId);
      const suffix = typeof body.system_prompt_suffix === "string" ? body.system_prompt_suffix.trim() : "";
      const fullPrompt = typeof body.system_prompt === "string" ? body.system_prompt.trim() : "";
      const systemPrompt = fullPrompt || (suffix ? `${BASELINE_ACTION_PROTOCOL_SYSTEM_PROMPT}\n\n${suffix}` : BASELINE_ACTION_PROTOCOL_SYSTEM_PROMPT);
      if (Array.isArray(handle.messages)) handle.messages[0] = { role: "system", content: systemPrompt };
      const episodeId = randomUUID();
      episodes.set(episodeId, { episodeId, taskId, handle, task, finished: false, benchmark });
      return jsonResponse({ episode_id: episodeId, task_id: taskId, prompt: task.prompt, system_prompt: systemPrompt });
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
  { port = 0, benchmark = "automationbench" }: { port?: number; benchmark?: BenchmarkName } = {},
): Promise<{ server: Server; port: number }> {
  const episodes = new Map<string, Episode>();
  const server = createServer((request, response) => {
    void route(request, episodes, benchmark).then(async (result) => {
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

export type OracleTrajectory = {
  task_id: string;
  split: Split;
  family: string;
  band: string;
  reward: number;
  forbidden_effects: string[];
  messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[];
};

function serializeAgentAction(action: { name: string; arguments: Record<string, unknown> }): string {
  return JSON.stringify({ tool: action.name, arguments: action.arguments });
}

export function replayOracleTrajectory(taskId: string): OracleTrajectory {
  const task = automationGetTask(taskId);
  const { handle, obs: initialObservation } = automationReset(taskId);
  handle.messages[0] = { role: "system", content: ACTION_PROTOCOL_SYSTEM_PROMPT };
  const messages: OracleTrajectory["messages"] = [
    { role: "system", content: ACTION_PROTOCOL_SYSTEM_PROMPT },
    { role: "user", content: task.prompt },
  ];
  const policy = automationOraclePolicy(taskId);
  let observation = initialObservation;
  while (true) {
    const action = policy(observation);
    if (!action) break;
    messages.push({ role: "assistant", content: serializeAgentAction(action) });
    const result = automationStep(handle, action);
    observation = result.obs;
    const toolMessage = observation.messages.at(-1);
    if (toolMessage?.role === "tool") messages.push({ role: "tool", content: toolMessage.content });
  }
  messages.push({ role: "assistant", content: serializeAgentAction({ name: "finish", arguments: {} }) });
  const terminal = handle.done ? { reward: automationPartialCredit(handle) } : automationFinish(handle);
  const summary = taskSummary(task, automationTaskBands());
  return {
    task_id: task.taskId,
    split: task.split,
    family: summary.family,
    band: summary.band,
    reward: terminal.reward,
    forbidden_effects: [...handle.forbiddenEffects],
    messages,
  };
}
