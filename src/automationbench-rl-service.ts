import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";

import {
  fixtureSha256 as automationFixtureSha256,
  finish as automationFinish,
  getTask as automationGetTask,
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

export const AUTOMATIONBENCH_NEMOTRON_V1_PROMPT = `You operate business apps by calling tools. Reply with exactly ONE JSON object and nothing else.

Allowed replies:
{"tool":"api_search","arguments":{"query":"<text>"}}
{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
{"tool":"finish","arguments":{}}

api_search is read-only endpoint discovery. api_fetch applies one API call and is the only way to change state. Endpoints: /crm/contacts (GET), /crm/contacts/{id} (GET, PATCH), /mail/drafts (GET, POST), /mail/drafts/{id} (GET, PATCH), /mail/messages (GET, POST with {"draft_id":"..."}).

Each tool result is returned to you as JSON. Look up any id you need before writing. Make the smallest change that satisfies the request, touch nothing else, then reply with the finish action.`;

export const CEDAR_V1_PROMPT = `You operate business apps by calling tools. Reply with exactly ONE JSON object and nothing else.

Allowed replies:
{"tool":"api_search","arguments":{"query":"<text>"}}
{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
{"tool":"finish","arguments":{}}

api_search is read-only endpoint discovery. api_fetch applies one API call and is the only way to change state. Endpoints: /conversations (GET), /conversations/{id} (GET), /documents (GET), /documents/{id} (GET, PATCH, POST with {"append":[...]}), /records (GET), /records/{id} (GET, PATCH with {"stage":"...","observations":[...]}), /drafts (GET, POST with {"to":"...","subject":"...","body":"..."}), /meetings (GET, POST with {"attendee":"...","slot":"...","durationMin":...}), /agent-state/{id} (GET, PATCH with {"awake":...,"reasoning":"..."}), /summaries (GET, POST with {"status":"...","summary":"...","toolsCalled":[...]}), /analysis (GET, POST with {"recordRef":"...","category":"...","priority":"...","finding":"..."}).

Each tool result is returned to you as JSON. Look up any id you need before writing. Make the smallest change that satisfies the request, touch nothing else, then reply with the finish action.`;

export const MAX_MODEL_TURNS = 12;
export type BenchmarkName = "automationbench" | "synthetic-workflow";
export type PromptVariant = "nemotron-v1" | "cedar-v1";
const PROMPTS: Record<PromptVariant, string> = {
  "nemotron-v1": AUTOMATIONBENCH_NEMOTRON_V1_PROMPT,
  "cedar-v1": CEDAR_V1_PROMPT,
};
export const PROMPT_IDENTITIES: Record<PromptVariant, string> = {
  "nemotron-v1": createHash("sha256").update(AUTOMATIONBENCH_NEMOTRON_V1_PROMPT).digest("hex"),
  "cedar-v1": createHash("sha256").update(CEDAR_V1_PROMPT).digest("hex"),
};
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

export function parseAgentAction(message: unknown): Record<string, unknown> {
  const source = String(message ?? "").trim();
  if (!source) return { error: "empty assistant message" };
  const start = source.indexOf("{");
  if (start < 0) return { error: "assistant message does not contain a balanced JSON object" };
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
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
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) return { error: "assistant message does not contain a balanced JSON object" };
  let parsed: any;
  try {
    parsed = JSON.parse(source.slice(start, end));
  } catch (error) {
    const detail = error instanceof SyntaxError ? error.message : String(error);
    return { error: `invalid JSON action: ${detail}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "assistant action must be a JSON object" };
  }
  if (parsed.finish === true || parsed.tool === "finish" || parsed.name === "finish") {
    return { finish: true };
  }
  const name = typeof parsed.tool === "string" ? parsed.tool : parsed.name;
  if (!name) return { error: "assistant action missing tool/name" };
  let args = parsed.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return { error: "assistant action arguments are not valid JSON" };
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { error: "assistant action arguments must be a JSON object" };
  }
  return { name, arguments: args };
}

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
  promptVariant: PromptVariant;
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

function promptForVariant(
  value: unknown,
  fallback: PromptVariant,
): { variant: PromptVariant; prompt: string; identity: string } {
  const variant = value === undefined ? fallback : String(value);
  if (!(variant in PROMPTS)) {
    throw new Error(`unknown prompt variant: ${variant}`);
  }
  const promptVariant = variant as PromptVariant;
  return { variant: promptVariant, prompt: PROMPTS[promptVariant], identity: PROMPT_IDENTITIES[promptVariant] };
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
  defaultPromptVariant: PromptVariant,
): Promise<Response> {
  const env = adapter(benchmark);
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") return jsonResponse({ ok: true, benchmark });
  if (request.method === "GET" && url.pathname === "/protocol") {
    try {
      const selected = promptForVariant(url.searchParams.get("prompt_variant") ?? undefined, defaultPromptVariant);
      return jsonResponse({
        prompt_variant: selected.variant,
        prompt_identity: selected.identity,
        system_prompt: selected.prompt,
        max_model_turns: MAX_MODEL_TURNS,
      });
    } catch (error) {
      return jsonResponse({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
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
      const selected = promptForVariant(body.prompt_variant, defaultPromptVariant);
      const task = env.getTask(taskId);
      env.taskPool({ split: task.split, frozenHoldoutSha256: typeof body.frozen_holdout_sha256 === "string" ? body.frozen_holdout_sha256 : undefined });
      const { handle } = env.reset(taskId);
      const episodeId = randomUUID();
      episodes.set(episodeId, {
        episodeId,
        taskId,
        handle,
        task,
        finished: false,
        benchmark,
        promptVariant: selected.variant,
      });
      return jsonResponse({
        episode_id: episodeId,
        task_id: taskId,
        prompt: task.prompt,
        prompt_variant: selected.variant,
        prompt_identity: selected.identity,
        system_prompt: selected.prompt,
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
  {
    port = 0,
    benchmark = "automationbench",
    promptVariant = benchmark === "automationbench" ? "nemotron-v1" : "cedar-v1",
  }: { port?: number; benchmark?: BenchmarkName; promptVariant?: PromptVariant } = {},
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
