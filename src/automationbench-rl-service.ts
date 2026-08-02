import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";

import {
  fixtureSha256,
  finish,
  getTask,
  oraclePolicy,
  partialCredit,
  reset,
  splitCounts,
  splitSha256,
  step,
  taskBands,
  taskPool,
  type Split,
  type StepResult,
  type Task,
  type ToolCall,
  type EnvHandle as AutomationEnvHandle,
  toolCatalog as automationToolCatalog,
} from "./automationbench-offline.js";
import {
  fixtureSha256 as syntheticFixtureSha256,
  finish as syntheticFinish,
  getTask as getSyntheticTask,
  partialCredit as syntheticPartialCredit,
  reset as syntheticReset,
  splitCounts as syntheticSplitCounts,
  splitSha256 as syntheticSplitSha256,
  step as syntheticStep,
  taskPool as syntheticTaskPool,
  toolCatalog as syntheticToolCatalog,
  endpointCatalog as syntheticEndpointCatalog,
  type SyntheticTask,
  type EnvHandle as SyntheticEnvHandle,
} from "./synthetic-workflow-offline.js";

export const ACTION_PROTOCOL_SYSTEM_PROMPT = `You operate business apps by calling tools. Reply with exactly ONE JSON object and nothing else.

Allowed replies:
{"tool":"api_search","arguments":{"query":"<text>"}}
{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
{"tool":"finish","arguments":{}}

api_search is read-only endpoint discovery. api_fetch applies one API call and is the only way to change state. Endpoints: /crm/contacts (GET), /crm/contacts/{id} (GET, PATCH), /mail/drafts (GET, POST), /mail/drafts/{id} (GET, PATCH), /mail/messages (GET, POST with {"draft_id":"..."}).

Each tool result is returned to you as JSON. Look up any id you need before writing. Make the smallest change that satisfies the request, touch nothing else, then reply with the finish action.`;

function syntheticWorkflowProtocolSystemPrompt(): string {
  const endpoints = syntheticEndpointCatalog()
    .map((endpoint) => `- ${endpoint.url} (${endpoint.methods.join(", ")}): ${endpoint.summary}`)
    .join("\n");
  return `You operate a synthetic workflow application by calling tools. Reply with exactly ONE JSON object and nothing else.

Allowed replies:
{"tool":"api_search","arguments":{"query":"<text>"}}
{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
{"tool":"finish","arguments":{}}

api_search is read-only endpoint discovery. api_fetch applies one API call and is the only way to change state. Use the endpoints and response data discovered in the workflow. Look up identifiers before writing, make the smallest change that satisfies the request, touch nothing else, then reply with the finish action.

Tool schemas:
- api_search: {query: string, top_k?: number}; read-only endpoint discovery.
- api_fetch: {method: string, url: string, body?: object}; applies one API call.
- finish: {}; scores the final state.

Synthetic workflow endpoints:
${endpoints}`;
}

export const MAX_MODEL_TURNS = 12;
export type FixtureName = "automationbench" | "synthetic-workflow";

export type ParsedAgentAction =
  | { name: string; arguments: Record<string, unknown> }
  | { finish: true }
  | { error: string };

type BackendHandle =
  | { fixture: "automationbench"; value: AutomationEnvHandle }
  | { fixture: "synthetic-workflow"; value: SyntheticEnvHandle };

type Backend = {
  fixture: FixtureName;
  systemPrompt: string;
  toolCatalog: ReturnType<typeof automationToolCatalog>;
  getTask: (taskId: string) => Task | SyntheticTask;
  taskPool: (options: { split: Split; frozenHoldoutSha256?: string }) => (Task | SyntheticTask)[];
  reset: (taskId: string) => { handle: BackendHandle; obs: StepResult["obs"] };
  step: (handle: BackendHandle, action: ToolCall) => StepResult;
  finish: (handle: BackendHandle) => StepResult;
  partialCredit: (handle: BackendHandle) => number;
  fixtureSha256: () => string;
  splitSha256: (split: Split) => string;
  splitCounts: () => Record<Split, number>;
};

export type Episode = {
  episodeId: string;
  taskId: string;
  prompt: string;
  systemPrompt: string;
  handle: BackendHandle;
  task: Task | SyntheticTask;
  finished: boolean;
};

export type OracleTrajectory = {
  task_id: string;
  split: Split;
  family: string;
  band: string;
  reward: number;
  forbidden_effects: string[];
  messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[];
};

type EnvServiceOptions = {
  port?: number;
  fixture?: FixtureName;
};

type EpisodeSummary = {
  task_id: string;
  split: Split;
  family: string;
  band: string;
  prompt: string;
};

function createBackend(fixture: FixtureName): Backend {
  if (fixture === "synthetic-workflow") {
    const systemPrompt = syntheticWorkflowProtocolSystemPrompt();
    return {
      fixture,
      systemPrompt,
      toolCatalog: syntheticToolCatalog(),
      getTask: getSyntheticTask,
      taskPool: syntheticTaskPool,
      reset: (taskId) => {
        const result = syntheticReset(taskId);
        return {
          ...result,
          handle: { fixture, value: result.handle },
        };
      },
      step: (handle, action) => {
        if (handle.fixture !== fixture) throw new Error("episode belongs to a different fixture");
        return syntheticStep(handle.value, action);
      },
      finish: (handle) => {
        if (handle.fixture !== fixture) throw new Error("episode belongs to a different fixture");
        return syntheticFinish(handle.value);
      },
      partialCredit: (handle) => {
        if (handle.fixture !== fixture) throw new Error("episode belongs to a different fixture");
        return syntheticPartialCredit(handle.value);
      },
      fixtureSha256: syntheticFixtureSha256,
      splitSha256: syntheticSplitSha256,
      splitCounts: syntheticSplitCounts,
    };
  }

  return {
    fixture,
    systemPrompt: ACTION_PROTOCOL_SYSTEM_PROMPT,
    toolCatalog: automationToolCatalog(),
    getTask,
    taskPool,
    reset: (taskId) => {
      const result = reset(taskId);
      return {
        ...result,
        handle: { fixture, value: result.handle },
      };
    },
    step: (handle, action) => {
      if (handle.fixture !== fixture) throw new Error("episode belongs to a different fixture");
      return step(handle.value, action);
    },
    finish: (handle) => {
      if (handle.fixture !== fixture) throw new Error("episode belongs to a different fixture");
      return finish(handle.value);
    },
    partialCredit: (handle) => {
      if (handle.fixture !== fixture) throw new Error("episode belongs to a different fixture");
      return partialCredit(handle.value);
    },
    fixtureSha256,
    splitSha256,
    splitCounts,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1_000_000) throw new Error("request body too large");
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeJsonParse(value: string): unknown {
  return JSON.parse(value);
}

function extractFirstBalancedJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (start === -1) {
      if (char === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
      continue;
    }
  }

  return null;
}

export function parseAgentAction(text: string): ParsedAgentAction {
  const source = String(text ?? "").trim();
  if (!source) return { error: "empty assistant message" };

  const candidate = extractFirstBalancedJsonObject(source);
  if (!candidate) return { error: "assistant message does not contain a balanced JSON object" };

  let parsed: unknown;
  try {
    parsed = safeJsonParse(candidate);
  } catch (error) {
    return { error: `invalid JSON action: ${(error as Error).message}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "assistant action must be a JSON object" };
  }

  const record = parsed as Record<string, unknown>;
  const finish = record.finish === true || record.tool === "finish" || record.name === "finish";
  if (finish) return { finish: true };

  const name = typeof record.tool === "string" ? record.tool : typeof record.name === "string" ? record.name : "";
  if (!name) return { error: "assistant action missing tool/name" };

  const rawArguments = record.arguments ?? {};
  let argumentsObject: unknown = rawArguments;
  if (typeof rawArguments === "string") {
    try {
      argumentsObject = safeJsonParse(rawArguments);
    } catch (error) {
      return { error: `assistant action arguments are not valid JSON: ${(error as Error).message}` };
    }
  }

  if (!argumentsObject || typeof argumentsObject !== "object" || Array.isArray(argumentsObject)) {
    return { error: "assistant action arguments must be a JSON object" };
  }

  return { name, arguments: argumentsObject as Record<string, unknown> };
}

export function renderToolObservation(stepResult: StepResult): string {
  const toolMessage = stepResult.obs.messages.at(-1);
  if (!toolMessage || toolMessage.role !== "tool") {
    throw new Error("step result does not contain a tool observation");
  }
  return toolMessage.content;
}

function serializeAgentAction(action: ToolCall | { name: "finish"; arguments: Record<string, never> }): string {
  return `{"tool":"${action.name}","arguments":${JSON.stringify(action.arguments)}}`;
}

function taskFamilyFromTaskId(taskId: string): string {
  const prefix = "simple-api-";
  if (!taskId.startsWith(prefix)) return taskId;
  return taskId.slice(prefix.length, -3);
}

function taskSummary(task: Task | SyntheticTask): EpisodeSummary {
  const family = "family" in task ? task.family : taskFamilyFromTaskId(task.taskId);
  const band = "band" in task ? task.band : taskBands()[family] ?? "single-write";
  return {
    task_id: task.taskId,
    split: task.split,
    family,
    band,
    prompt: task.prompt,
  };
}

function checkHoldoutAccess(
  taskId: string,
  backend: Backend,
  frozenHoldoutSha256?: string,
): void {
  const task = backend.getTask(taskId);
  const available = backend.taskPool({ split: task.split, frozenHoldoutSha256 });
  if (!available.some((candidate) => candidate.taskId === taskId)) throw new Error(`task is not available in ${task.split}`);
}

async function routeRequest(
  request: IncomingMessage,
  episodes: Map<string, Episode>,
  backend: Backend,
): Promise<Response> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/protocol") {
    return jsonResponse({
      system_prompt: backend.systemPrompt,
      tools: backend.toolCatalog,
      max_model_turns: MAX_MODEL_TURNS,
    });
  }

  if (request.method === "GET" && url.pathname === "/hashes") {
    return jsonResponse({
      fixture: backend.fixture,
      fixture_sha256: backend.fixtureSha256(),
      split_sha256: {
        train: backend.splitSha256("train"),
        dev: backend.splitSha256("dev"),
        holdout: backend.splitSha256("holdout"),
      },
      counts: backend.splitCounts(),
    });
  }

  if (request.method === "GET" && url.pathname === "/tasks") {
    const split = url.searchParams.get("split");
    if (split !== "train" && split !== "dev" && split !== "holdout") {
      return jsonResponse({ error: "split must be train, dev, or holdout" }, 400);
    }
    try {
      const frozenHoldoutSha256 = url.searchParams.get("frozen_holdout_sha256") ?? undefined;
      const tasks = backend.taskPool({ split: split as Split, frozenHoldoutSha256 }).map((task) => taskSummary(task));
      return jsonResponse(tasks);
    } catch (error) {
      return jsonResponse({ error: (error as Error).message }, 400);
    }
  }

  if (request.method === "POST" && url.pathname === "/reset") {
    const raw = await readBody(request);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (error) {
      return jsonResponse({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "reset body must be an object" }, 400);
    }
    const taskId = typeof (body as Record<string, unknown>).task_id === "string" ? String((body as Record<string, unknown>).task_id) : "";
    if (!taskId) return jsonResponse({ error: "task_id is required" }, 400);
    try {
      checkHoldoutAccess(taskId, backend, typeof (body as Record<string, unknown>).frozen_holdout_sha256 === "string" ? String((body as Record<string, unknown>).frozen_holdout_sha256) : undefined);
      for (const [episodeId, episode] of episodes) {
        if (episode.finished) episodes.delete(episodeId);
      }
      if (episodes.size >= 4096) return jsonResponse({ error: "too many active episodes" }, 503);
      const { handle } = backend.reset(taskId);
      const systemPrompt = backend.systemPrompt;
      handle.value.messages[0] = { role: "system", content: systemPrompt };
      const task = backend.getTask(taskId);
      const episodeId = randomUUID();
      episodes.set(episodeId, {
        episodeId,
        taskId,
        prompt: task.prompt,
        systemPrompt,
        handle,
        task,
        finished: false,
      });
      return jsonResponse({
        episode_id: episodeId,
        task_id: taskId,
        prompt: task.prompt,
        system_prompt: systemPrompt,
        tools: backend.toolCatalog,
      });
    } catch (error) {
      return jsonResponse({ error: (error as Error).message }, 400);
    }
  }

  if (request.method === "POST" && url.pathname === "/step") {
    const raw = await readBody(request);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (error) {
      return jsonResponse({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error: "step body must be an object" }, 400);
    const episodeId = typeof (body as Record<string, unknown>).episode_id === "string" ? String((body as Record<string, unknown>).episode_id) : "";
    const action = (body as Record<string, unknown>).action;
    if (!episodeId) return jsonResponse({ error: "episode_id is required" }, 400);
    if (!action || typeof action !== "object" || Array.isArray(action)) return jsonResponse({ error: "action must be an object" }, 400);
    const episode = episodes.get(episodeId);
    if (!episode) return jsonResponse({ error: "unknown episode" }, 404);
    if (episode.finished) return jsonResponse({ error: "episode already finished" }, 400);
    const name = typeof (action as Record<string, unknown>).name === "string" ? String((action as Record<string, unknown>).name) : "";
    const argumentsObject = (action as Record<string, unknown>).arguments;
    if (!name) return jsonResponse({ error: "action.name is required" }, 400);
    if (!argumentsObject || typeof argumentsObject !== "object" || Array.isArray(argumentsObject)) {
      return jsonResponse({ error: "action.arguments must be an object" }, 400);
    }
    try {
      const result = backend.step(episode.handle, { name, arguments: argumentsObject as Record<string, unknown> });
      episode.finished = result.done;
      return jsonResponse({
        observation: renderToolObservation(result),
        step: result.obs.step,
        done: result.done,
      });
    } catch (error) {
      return jsonResponse({ error: (error as Error).message }, 400);
    }
  }

  if (request.method === "POST" && url.pathname === "/finish") {
    const raw = await readBody(request);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (error) {
      return jsonResponse({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error: "finish body must be an object" }, 400);
    const episodeId = typeof (body as Record<string, unknown>).episode_id === "string" ? String((body as Record<string, unknown>).episode_id) : "";
    if (!episodeId) return jsonResponse({ error: "episode_id is required" }, 400);
    const episode = episodes.get(episodeId);
    if (!episode) return jsonResponse({ error: "unknown episode" }, 404);
    try {
      const result = episode.handle.value.done
        ? {
            reward: backend.partialCredit(episode.handle),
            info: { forbidden_effects: [...episode.handle.value.forbiddenEffects] },
          }
        : backend.finish(episode.handle);
      episode.finished = true;
      episodes.delete(episodeId);
      return jsonResponse({
        reward: result.reward,
        steps: episode.handle.value.step,
        forbidden_effects: (result.info as Record<string, unknown>).forbidden_effects ?? [],
      });
    } catch (error) {
      return jsonResponse({ error: (error as Error).message }, 400);
    }
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/episode/")) {
    const episodeId = url.pathname.slice("/episode/".length);
    episodes.delete(episodeId);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "not found" }, 404);
}

export async function startEnvService({
  port = 0,
  fixture = "automationbench",
}: EnvServiceOptions = {}): Promise<{ server: Server; port: number }> {
  const episodes = new Map<string, Episode>();
  const backend = createBackend(fixture);
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const result = await routeRequest(request, episodes, backend);
        response.statusCode = result.status;
        for (const [key, value] of result.headers.entries()) response.setHeader(key, value);
        const body = await result.text();
        response.end(body);
      } catch (error) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ error: (error as Error).message }));
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start env service");
  }
  return { server, port: address.port };
}

export function replayOracleTrajectory(taskId: string): OracleTrajectory {
  const task = getTask(taskId);
  const { handle, obs: initialObservation } = reset(taskId);
  handle.messages[0] = { role: "system", content: ACTION_PROTOCOL_SYSTEM_PROMPT };
  const messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[] = [
    { role: "system", content: ACTION_PROTOCOL_SYSTEM_PROMPT },
    { role: "user", content: task.prompt },
  ];
  const policy = oraclePolicy(taskId);
  let obs = initialObservation;
  obs.messages[0] = { role: "system", content: ACTION_PROTOCOL_SYSTEM_PROMPT };
  while (true) {
    const action = policy(obs);
    if (!action) break;
    const assistantContent = serializeAgentAction(action);
    messages.push({ role: "assistant", content: assistantContent });
    const result = step(handle, action);
    obs = result.obs;
    messages.push({ role: "tool", content: renderToolObservation(result) });
  }
  messages.push({ role: "assistant", content: serializeAgentAction({ name: "finish", arguments: {} }) });
  const terminal = handle.done ? { reward: partialCredit(handle) } : finish(handle);
  const summary = taskSummary(task);
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
