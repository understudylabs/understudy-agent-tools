import { createHash } from "node:crypto";
import {
  AUTOMATIONBENCH_SUBSET,
  TASKS as AUTOMATION_TASKS,
  reset as automationReset,
  step as automationStep,
  finish as automationFinish,
  partialCredit as automationCredit,
  splitSha256 as automationSplitSha,
  fixtureSha256 as automationFixtureSha,
  taskPool as automationPool,
  type Split as AutomationSplit,
} from "./automationbench-offline.js";
import {
  SYNTHETIC_WORKFLOW_SUBSET,
  TASKS as SYNTHETIC_TASKS,
  reset as syntheticReset,
  step as syntheticStep,
  finish as syntheticFinish,
  partialCredit as syntheticCredit,
  splitSha256 as syntheticSplitSha,
  fixtureSha256 as syntheticFixtureSha,
  taskPool as syntheticPool,
} from "./synthetic-workflow-offline.js";
import {
  EVENT_CATEGORIZER_SUBSET,
  TASKS as EVENT_TASKS,
  PLAYBOOK,
  getTask as getEventTask,
  parseFinalJson,
  scoreCompletion,
  splitSha256 as eventSplitSha,
  fixtureSha256 as eventFixtureSha,
  taskPool as eventPool,
  type Split as EventSplit,
} from "./event-categorizer-offline.js";
import type { ChatMessage, ModelEpisode, ModelTaskAdapter } from "./generalization-model-runner.js";

type SyntheticSplit = "train" | "dev" | "holdout";

function hash(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== "object") return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    return `{${Object.keys(input as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`).join(",")}}`;
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function messages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const record = message as Record<string, unknown>;
    const role = record.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") return [];
    return [{ role, content: typeof record.content === "string" ? record.content : JSON.stringify(record.content ?? "") }];
  });
}

function splitTasks<T extends { split: string; taskId?: string; task_id?: string }>(
  tasks: T[],
  split: string,
): string[] {
  return tasks.filter((task) => task.split === split).map((task) => task.taskId ?? task.task_id!);
}

function automationAdapter(): ModelTaskAdapter {
  return {
    taskIds: ({ split, frozenHoldoutSha256 }) => splitTasks(automationPool({ split: split as AutomationSplit, frozenHoldoutSha256 }), split),
    splitSha256: (split) => automationSplitSha(split as AutomationSplit),
    harnessSha256: automationFixtureSha(),
    start: (taskId): ModelEpisode => {
      const task = AUTOMATION_TASKS.find((candidate) => candidate.taskId === taskId)!;
      const reset = automationReset(taskId);
      const handle = reset.handle;
      return {
        taskId,
        split: task.split,
        benchmarkId: AUTOMATIONBENCH_SUBSET.benchmark_id,
        messages: messages(reset.obs.messages),
        applyToolCall: (tool, args) => {
          if (tool === "finish") return { result: {}, done: true };
          const result = automationStep(handle, { name: tool, arguments: args });
          return { result: result.obs.messages.at(-1)?.content ?? result.info, done: result.done };
        },
        score: (_finalContent, parseFailures) => ({
          score: automationCredit(handle),
          status: "ok",
          subscores: { parse_failures: parseFailures, forbidden_effects: handle.forbiddenEffects.length, steps: handle.step },
        }),
        contentHashes: {
          env_sha256: hash({ initial_state: task.initialState, prompt: task.prompt }),
          verifier_sha256: hash({ assertions: task.assertions, allowed_writes: task.allowedWrites }),
        },
      };
    },
  };
}

function syntheticAdapter(): ModelTaskAdapter {
  return {
    taskIds: ({ split, frozenHoldoutSha256 }) => splitTasks(syntheticPool({ split: split as SyntheticSplit, frozenHoldoutSha256 }), split),
    splitSha256: (split) => syntheticSplitSha(split as SyntheticSplit),
    harnessSha256: syntheticFixtureSha(),
    start: (taskId): ModelEpisode => {
      const task = SYNTHETIC_TASKS.find((candidate) => candidate.taskId === taskId)!;
      const reset = syntheticReset(taskId);
      const handle = reset.handle;
      return {
        taskId,
        split: task.split,
        benchmarkId: SYNTHETIC_WORKFLOW_SUBSET.benchmark_id,
        messages: messages(reset.obs.messages),
        applyToolCall: (tool, args) => {
          if (tool === "finish") return { result: {}, done: true };
          const result = syntheticStep(handle, { name: tool, arguments: args });
          return { result: result.obs.messages.at(-1)?.content ?? result.info, done: result.done };
        },
        score: (_finalContent, parseFailures) => ({
          score: syntheticCredit(handle),
          status: "ok",
          subscores: { parse_failures: parseFailures, forbidden_effects: handle.forbiddenEffects.length, steps: handle.step },
        }),
        contentHashes: {
          env_sha256: hash({ initial_state: task.initialState, prompt: task.prompt }),
          verifier_sha256: hash({ assertions: task.assertions, allowed_writes: task.allowedWrites }),
        },
      };
    },
  };
}

function eventAdapter(): ModelTaskAdapter {
  return {
    taskIds: ({ split, frozenHoldoutSha256 }) => splitTasks(eventPool({ split: split as EventSplit, frozenHoldoutSha256 }), split),
    splitSha256: (split) => eventSplitSha(split as EventSplit),
    harnessSha256: eventFixtureSha(),
    start: (taskId): ModelEpisode => {
      const task = getEventTask(taskId);
      let final = "";
      return {
        taskId,
        split: task.split,
        benchmarkId: EVENT_CATEGORIZER_SUBSET.benchmark_id,
        messages: [{ role: "system", content: PLAYBOOK }, { role: "user", content: task.question }],
        isFinalContent: (content) => {
          const parsed = parseFinalJson(content);
          if (parsed.value && "category" in parsed.value) {
            final = content;
            return true;
          }
          return false;
        },
        applyToolCall: (tool, args) => {
          if (tool === "finish") return { result: {}, done: true };
          if (tool !== "api_search" && tool !== "api_fetch") return { result: { error: "unknown tool" }, done: true };
          const accountId = typeof args.account_id === "string" ? args.account_id : "";
          return { result: { account: task.accounts[accountId] ?? { error: "not_found" } }, done: false };
        },
        score: (content, parseFailures) => {
          const result = scoreCompletion(taskId, final || content);
          return {
            score: result.score,
            status: "ok",
            subscores: { ...result.subscores, parse_failures: parseFailures },
          };
        },
        contentHashes: {
          env_sha256: hash({ prompt: task.question, playbook: PLAYBOOK, accounts: task.accounts }),
          verifier_sha256: hash({ gold: task.gold }),
        },
      };
    },
  };
}

export function groupAAdapter(): ModelTaskAdapter { return automationAdapter(); }
export function groupBAdapter(): ModelTaskAdapter { return eventAdapter(); }
export function groupCAdapter(): ModelTaskAdapter { return syntheticAdapter(); }
