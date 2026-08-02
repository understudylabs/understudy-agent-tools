import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";

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
  assertionSatisfied as automationAssertionSatisfied,
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
  assertionSatisfied as syntheticAssertionSatisfied,
} from "./synthetic-workflow-offline.js";
import {
  v2FixtureSha256,
  v2SplitCounts,
  v2SplitSha256,
  v2TaskBands,
  v2TaskPool,
} from "./automationbench-v2.js";
import {
  createProcessRewardEpisode,
  DEFAULT_PROCESS_REWARD_CONFIG,
  processRewardConfigSha256,
  type ProcessRewardConfig,
  type RewardMode,
} from "./process-reward.js";

export const ACTION_PROTOCOL_SYSTEM_PROMPT = `You operate workflow apps by calling tools. Reply with exactly ONE JSON object and nothing else.

Allowed replies:
{"tool":"api_search","arguments":{"query":"<text>"}}
{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
{"tool":"finish","arguments":{}}

Look up any id you need before writing. Make the smallest change that satisfies the request, touch nothing else, then reply with the finish action.`;

export const MAX_MODEL_TURNS = 12;
export type BenchmarkName = "automationbench" | "automationbench-v2" | "synthetic-workflow";
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
  assertionSatisfied: (state: any, assertion: any) => boolean;
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
      assertionSatisfied: automationAssertionSatisfied,
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
      assertionSatisfied: syntheticAssertionSatisfied,
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
      assertionSatisfied: automationAssertionSatisfied,
    };
}

type Episode = {
  episodeId: string;
  taskId: string;
  handle: any;
  finished: boolean;
  task: any;
  benchmark: BenchmarkName;
  rewardMode: RewardMode;
  processReward?: ReturnType<typeof createProcessRewardEpisode>;
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
  return id.replace(/^(?:simple|hard)-api-/, "").replace(/-\d+$/, "");
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
      max_model_turns: MAX_MODEL_TURNS,
      process_reward: {
        default_mode: "terminal",
        config: DEFAULT_PROCESS_REWARD_CONFIG,
        config_sha256: processRewardConfigSha256(),
      },
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
      const rewardMode = body.reward_mode === undefined ? "terminal" : body.reward_mode;
      if (rewardMode !== "terminal" && rewardMode !== "terminal+process") {
        return jsonResponse({ error: "reward_mode must be terminal or terminal+process" }, 400);
      }
      const processConfig = body.process_config && typeof body.process_config === "object" &&
        !Array.isArray(body.process_config)
        ? body.process_config as Partial<ProcessRewardConfig>
        : undefined;
      const sourceTask = env.getTask(taskId);
      const task = {
        ...sourceTask,
        band: sourceTask.band ?? env.taskBands()[taskFamily(sourceTask)],
      };
      env.taskPool({ split: task.split, frozenHoldoutSha256: typeof body.frozen_holdout_sha256 === "string" ? body.frozen_holdout_sha256 : undefined });
      const { handle } = env.reset(taskId);
      const episodeId = randomUUID();
      const processReward = rewardMode === "terminal+process"
        ? createProcessRewardEpisode({
          task,
          assertionChecker: env.assertionSatisfied,
          config: processConfig,
        })
        : undefined;
      episodes.set(episodeId, {
        episodeId,
        taskId,
        handle,
        task,
        finished: false,
        benchmark,
        rewardMode: rewardMode as RewardMode,
        processReward,
      });
      const response: Record<string, unknown> = {
        episode_id: episodeId,
        task_id: taskId,
        prompt: task.prompt,
        system_prompt: ACTION_PROTOCOL_SYSTEM_PROMPT,
      };
      if (processReward) {
        response.reward_mode = rewardMode;
        response.process_config = processReward.config;
        response.process_config_sha256 = processRewardConfigSha256(processReward.config);
      }
      return jsonResponse(response);
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
      const beforeState = episode.processReward
        ? JSON.parse(JSON.stringify(episode.handle.state))
        : null;
      const beforeEnvironment = episode.processReward
        ? { forbiddenEffects: [...episode.handle.forbiddenEffects] }
        : null;
      const result = env.step(episode.handle, action);
      episode.finished = result.done;
      const toolMessage = result.obs.messages.at(-1);
      if (!episode.processReward) {
        return jsonResponse({ observation: toolMessage?.content ?? "", step: result.obs.step, done: result.done });
      }
      const process = episode.processReward.step(
        beforeState,
        action as { name: string; arguments: Record<string, unknown> },
        episode.handle.state,
        beforeEnvironment!,
        { forbiddenEffects: [...episode.handle.forbiddenEffects] },
        toolMessage?.content ?? "",
      );
      return jsonResponse({
        observation: toolMessage?.content ?? "",
        step: result.obs.step,
        done: result.done,
        reward: process.onlineReward,
        process_reward: process,
      });
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
      if (!episode.processReward) {
        return jsonResponse({ reward: result.reward, steps: episode.handle.step, forbidden_effects: [...episode.handle.forbiddenEffects] });
      }
      const process = episode.processReward.finish({
        finalState: episode.handle.state,
        terminal: result.reward,
        explicitlyFinished: body.explicit_finished === true,
        truncated: body.truncated === true ||
          (episode.handle.step >= (episode.task.maxSteps ?? 12) && body.explicit_finished !== true),
      });
      return jsonResponse({
        reward: process.streamReward,
        terminal_reward: result.reward,
        process_total: process.processTotal,
        combined: process.combined,
        steps: episode.handle.step,
        forbidden_effects: [...episode.handle.forbiddenEffects],
        process_breakdown: process.breakdown,
      });
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
