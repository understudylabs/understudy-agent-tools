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

export const ACTION_PROTOCOL_SYSTEM_PROMPT = `You operate workflow apps by calling tools. Reply with exactly ONE JSON object and nothing else.

Allowed replies:
{"tool":"api_search","arguments":{"query":"<text>"}}
{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
{"tool":"finish","arguments":{}}

Look up any id you need before writing. Make the smallest change that satisfies the request, touch nothing else, then reply with the finish action.`;

export const MAX_MODEL_TURNS = 12;
export type BenchmarkName = "automationbench" | "synthetic-workflow";
type Split = "train" | "dev" | "holdout";
export type ParsedAgentAction =
  | { name: string; arguments: Record<string, unknown> }
  | { finish: true }
  | { error: string };
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
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function parseAgentAction(text: string): ParsedAgentAction {
  const candidate = extractFirstBalancedJsonObject(String(text ?? "").trim());
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
  if (record.finish === true || record.tool === "finish" || record.name === "finish") {
    return { finish: true };
  }
  const name = typeof record.tool === "string" ? record.tool : typeof record.name === "string" ? record.name : "";
  if (!name) return { error: "assistant action missing tool/name" };
  let args: unknown = record.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch (error) {
      return { error: `assistant action arguments are not valid JSON: ${(error as Error).message}` };
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { error: "assistant action arguments must be a JSON object" };
  }
  return { name, arguments: args as Record<string, unknown> };
}

export function replayOracleTrajectory(taskId: string) {
  const task = automationGetTask(taskId);
  const { handle, obs: initialObservation } = automationReset(taskId);
  const messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[] = [
    { role: "system", content: ACTION_PROTOCOL_SYSTEM_PROMPT },
    { role: "user", content: task.prompt },
  ];
  let obs = initialObservation;
  while (true) {
    const action = automationOraclePolicy(taskId)(obs);
    if (!action) break;
    messages.push({ role: "assistant", content: JSON.stringify({ tool: action.name, arguments: action.arguments }) });
    const result = automationStep(handle, action);
    obs = result.obs;
    const tool = obs.messages.at(-1);
    messages.push({ role: "tool", content: tool?.content ?? "" });
  }
  messages.push({ role: "assistant", content: JSON.stringify({ tool: "finish", arguments: {} }) });
  const terminal = handle.done ? { reward: automationPartialCredit(handle) } : automationFinish(handle);
  return {
    task_id: task.taskId,
    split: task.split,
    family: taskFamily(task),
    band: adapter("automationbench").taskBands()[taskFamily(task)] ?? "single-write",
    reward: terminal.reward,
    forbidden_effects: [...handle.forbiddenEffects],
    messages,
  };
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
    return jsonResponse({ system_prompt: ACTION_PROTOCOL_SYSTEM_PROMPT, max_model_turns: MAX_MODEL_TURNS });
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
      const episodeId = randomUUID();
      episodes.set(episodeId, { episodeId, taskId, handle, task, finished: false, benchmark });
      return jsonResponse({ episode_id: episodeId, task_id: taskId, prompt: task.prompt, system_prompt: ACTION_PROTOCOL_SYSTEM_PROMPT });
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
