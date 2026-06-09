#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { URL, fileURLToPath } from "node:url";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_AGENT_REPO = process.env.UNDERSTUDY_AGENT_REPO || "";
const DEFAULT_BASELINE_RUN = process.env.UNDERSTUDY_BASELINE_RUN || "";
const DEFAULT_REPAIRED_POLICY = process.env.UNDERSTUDY_REPAIRED_POLICY || "";
const DEFAULT_GENERAL_POLICY = join(
  SKILL_DIR,
  "policies",
  "automationbench-general-side-effect-policy.txt",
);
const DEFAULT_EXPLORE_POLICY = join(
  SKILL_DIR,
  "policies",
  "automationbench-environment-exploration-policy.txt",
);
const DEFAULT_PORT = 8787;

function parseArgs(argv) {
  const args = {
    agentRepo: DEFAULT_AGENT_REPO,
    baselineRun: DEFAULT_BASELINE_RUN,
    repairedPolicy: DEFAULT_REPAIRED_POLICY,
    generalPolicy: DEFAULT_GENERAL_POLICY,
    explorePolicy: DEFAULT_EXPLORE_POLICY,
    host: "127.0.0.1",
    port: DEFAULT_PORT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--agent-repo" && value) args.agentRepo = value;
    else if (key === "--baseline-run" && value) args.baselineRun = value;
    else if (key === "--repaired-policy" && value) args.repairedPolicy = value;
    else if (key === "--general-policy" && value) args.generalPolicy = value;
    else if (key === "--explore-policy" && value) args.explorePolicy = value;
    else if (key === "--host" && value) args.host = value;
    else if (key === "--port" && value) args.port = Number(value);
    else {
      console.error(`unknown or missing argument: ${key}`);
      process.exit(2);
    }
    index += 1;
  }
  const required = [
    ["agentRepo", "--agent-repo", "UNDERSTUDY_AGENT_REPO"],
    ["baselineRun", "--baseline-run", "UNDERSTUDY_BASELINE_RUN"],
    ["repairedPolicy", "--repaired-policy", "UNDERSTUDY_REPAIRED_POLICY"],
  ];
  const missing = required.filter(([name]) => !args[name]);
  if (missing.length > 0) {
    for (const [, flag, env] of missing) {
      console.error(`missing required path: pass ${flag} <path> or set ${env}`);
    }
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const clients = new Set();
const runState = {
  active: false,
  runId: null,
  startedAt: null,
  events: [],
  lanes: {},
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function archivedPrompt() {
  const trajectory = readJsonl(join(args.baselineRun, "trajectories.jsonl"))[0] || {};
  const messages = Array.isArray(trajectory.messages) ? trajectory.messages : [];
  return messages.find((message) => message.role === "user")?.content || "";
}

function archivedSystem() {
  const event = readJsonl(join(args.baselineRun, "model-call-events.jsonl"))[0] || {};
  return event.request?.prompt?.find?.((message) => message.role === "system")?.content || "";
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeToolCall(call) {
  let parsed = call;
  if (typeof call === "string") {
    try {
      parsed = JSON.parse(call);
    } catch {
      return { id: "", name: "tool_call", arguments: call };
    }
  }
  const fn = parsed?.function || parsed;
  let toolArgs = fn?.arguments ?? parsed?.arguments ?? {};
  if (typeof toolArgs === "string") {
    try {
      toolArgs = JSON.parse(toolArgs);
    } catch {
      // Keep provider-encoded non-JSON argument strings.
    }
  }
  return {
    id: parsed?.id || parsed?.tool_call_id || "",
    name: fn?.name || parsed?.name || "tool_call",
    arguments: toolArgs,
  };
}

function parseJsonLike(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function responseSummary(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Array.isArray(value.results)) {
      const labels = value.results
        .slice(0, 4)
        .map((row) => row?.id || row?.Name || row?.name || row?.title || row?.description)
        .filter(Boolean);
      return `${value.results.length} search result${value.results.length === 1 ? "" : "s"}${
        labels.length ? `: ${labels.join(", ")}` : ""
      }`;
    }
    if (value.ok === true && value.message) {
      return `ok: ${value.message.text || value.message.channel || value.message.ts || "message"}`;
    }
    if (value.error) return `error: ${value.error.message || value.error.code || JSON.stringify(value.error)}`;
    const keys = Object.keys(value);
    if (keys.length) return `object keys: ${keys.slice(0, 5).join(", ")}`;
  }
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value === null) return "null";
  return String(value ?? "").slice(0, 180);
}

function toolCallNameMap(messages) {
  const names = new Map();
  for (const message of messages) {
    if (!Array.isArray(message?.tool_calls)) continue;
    for (const rawCall of message.tool_calls) {
      const call = normalizeToolCall(rawCall);
      if (call.id) names.set(call.id, call.name);
    }
  }
  return names;
}

function collectAssistantTurns(messages) {
  const toolNames = toolCallNameMap(messages);
  const turns = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const toolCalls = message.tool_calls?.map(normalizeToolCall) || [];
    const environmentResponses = [];
    for (let responseIndex = index + 1; responseIndex < messages.length; responseIndex += 1) {
      const response = messages[responseIndex];
      if (!response || response.role !== "tool") break;
      const parsed = parseJsonLike(response.content);
      const toolCallId = response.tool_call_id || response.tool_call?.id || "";
      environmentResponses.push({
        index: responseIndex,
        toolCallId,
        name: response.name || response.tool_name || toolNames.get(toolCallId) || "tool response",
        summary: responseSummary(parsed),
        parsed,
      });
    }
    turns.push({
      index,
      content: message.content || "",
      toolCalls,
      environmentResponses,
    });
  }
  return turns;
}

function logprobStats(tokens) {
  const values = tokens.map((entry) => entry.logprob).filter(Number.isFinite);
  if (!values.length) return { count: 0, mean: null, min: null, low: 0 };
  return {
    count: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    low: values.filter((value) => value <= -2).length,
  };
}

function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

function usageFromEvent(event) {
  return (
    event.response?.usage ||
    event.observability?.value?.usage ||
    event.observability?.usage ||
    {}
  );
}

function scaledBuckets(buckets, targetTotal) {
  const rawTotal = buckets.reduce((sum, bucket) => sum + bucket.rawTokens, 0);
  if (!targetTotal || !rawTotal) {
    return buckets.map((bucket) => ({ ...bucket, tokens: bucket.rawTokens }));
  }
  const scaled = buckets.map((bucket) => ({
    ...bucket,
    tokens: Math.max(bucket.rawTokens > 0 ? 1 : 0, Math.round((bucket.rawTokens / rawTotal) * targetTotal)),
  }));
  let delta = targetTotal - scaled.reduce((sum, bucket) => sum + bucket.tokens, 0);
  while (delta !== 0) {
    const candidates = scaled
      .map((bucket, index) => ({ index, tokens: bucket.tokens }))
      .filter((entry) => delta > 0 || entry.tokens > 1)
      .sort((a, b) => b.tokens - a.tokens);
    if (!candidates.length) break;
    scaled[candidates[0].index].tokens += delta > 0 ? 1 : -1;
    delta += delta > 0 ? -1 : 1;
  }
  return scaled;
}

function requestMeter(event) {
  const prompt = Array.isArray(event.request?.prompt) ? event.request.prompt : [];
  const tools = Array.isArray(event.request?.tools) ? event.request.tools : [];
  const usage = usageFromEvent(event);
  const systemMessages = prompt.filter((message) => message.role === "system");
  const nonSystemMessages = prompt.filter((message) => message.role !== "system");
  const rawBuckets = [
    {
      id: "system",
      label: "System prompt",
      rawTokens: estimateTokens(systemMessages.map((message) => message.content || "").join("\n\n")),
    },
    {
      id: "tools",
      label: "System tools",
      rawTokens: estimateTokens(tools),
    },
    {
      id: "messages",
      label: "Messages",
      rawTokens: estimateTokens(nonSystemMessages.map((message) => message.content || "").join("\n\n")),
    },
  ];
  const promptTokens = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null;
  const completionTokens = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null;
  const totalTokens = Number.isFinite(usage.total_tokens) ? usage.total_tokens : (
    promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null
  );
  return {
    model: event.run?.model || "",
    provider: event.run?.provider || "",
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens: Number.isFinite(usage.prompt_tokens_details?.cached_tokens)
      ? usage.prompt_tokens_details.cached_tokens
      : null,
    buckets: scaledBuckets(rawBuckets, promptTokens),
    samplingArgs: event.request?.sampling_args || {},
    prompt: prompt.map((message) => ({
      role: message.role || "",
      content: message.content || "",
    })),
    tools: tools.map((tool) => ({
      name: tool.function?.name || tool.name || "tool",
      description: tool.function?.description || tool.description || "",
      parameters: tool.function?.parameters || tool.parameters || {},
    })),
  };
}

function firstExistingJson(paths) {
  for (const path of paths) {
    if (existsSync(path)) return readJson(path);
  }
  return {};
}

function latestTrainingEvent(evalDir) {
  const events = readJsonl(join(evalDir, "training-events.jsonl"));
  return events.length ? events[events.length - 1] : {};
}

function formatAssertion(assertion) {
  const params = assertion?.params && typeof assertion.params === "object" ? assertion.params : {};
  const targetParts = [];
  if (params.channel_name) targetParts.push(`#${params.channel_name}`);
  if (params.collection) targetParts.push(params.collection);
  if (params.record_id) targetParts.push(params.record_id);
  if (params.field) targetParts.push(params.field);
  const expectation = params.text_contains ?? params.value ?? params.text_not_contains ?? params.query ?? params;
  return {
    type: assertion?.type || "assertion",
    passed: Boolean(assertion?.passed),
    excluded: Boolean(assertion?.excluded),
    target: targetParts.join(" · "),
    expectation,
    params,
  };
}

function judgingSummary(evalDir, trajectory) {
  const official = firstExistingJson([
    join(evalDir, "official-results.json"),
    join(evalDir, "checkpoint-results.json"),
  ]);
  const task = official.tasks?.[0] || {};
  const summary = official.summary || {};
  const trainingEvent = latestTrainingEvent(evalDir);
  const metrics = trajectory.metrics || {};
  const assertions = Array.isArray(task.assertion_results)
    ? task.assertion_results.map(formatAssertion)
    : [];
  const countedAssertions = assertions.filter((assertion) => !assertion.excluded);
  const excludedAssertions = assertions.filter((assertion) => assertion.excluded);
  return {
    source: existsSync(join(evalDir, "official-results.json"))
      ? "official-results.json"
      : existsSync(join(evalDir, "checkpoint-results.json"))
        ? "checkpoint-results.json"
        : "trajectories.jsonl",
    reward: Number.isFinite(trajectory.reward) ? trajectory.reward : task.score ?? metrics.score ?? 0,
    score: task.score ?? metrics.score ?? trajectory.reward ?? 0,
    passed: Boolean(task.passed || metrics.task_completed_correctly),
    partialCredit: trajectory.partial_credit ?? metrics.partial_credit ?? null,
    assertionsPassed: task.assertions_passed ?? metrics.assertions_passed ?? countedAssertions.filter((a) => a.passed).length,
    assertionsTotal: task.assertions_total ?? metrics.assertions_total ?? countedAssertions.length,
    countedAssertions,
    excludedAssertions,
    summary: {
      avgScore: summary.avg_score,
      passRate: summary.pass_rate ?? summary.success_rate,
      totalInputTokens: summary.total_input_tokens,
      totalOutputTokens: summary.total_output_tokens,
      checkpointPartial: Boolean(summary.checkpoint_partial || official.meta?.checkpoint_partial),
    },
    advantage: trainingEvent.advantage || null,
    actionOutcome: trainingEvent.action_outcome || null,
    failureNormalization: trainingEvent.failure_normalization || null,
  };
}

function summarizeLane(evalDir) {
  const modelEvents = readJsonl(join(evalDir, "model-call-events.jsonl"));
  const trajectories = readJsonl(join(evalDir, "trajectories.jsonl"));
  const result = existsSync(join(evalDir, "result.json")) ? readJson(join(evalDir, "result.json")) : {};
  const event = modelEvents[0] || {};
  const trajectory = trajectories[0] || {};
  const messages = Array.isArray(trajectory.messages) ? trajectory.messages : [];
  const firstAssistantIndex = messages.findIndex((message) => message.role === "assistant");
  const assistantMessage = firstAssistantIndex >= 0 ? messages[firstAssistantIndex] : null;
  const toolCalls = assistantMessage?.tool_calls?.map(normalizeToolCall) || [];
  const toolNames = toolCallNameMap(messages);
  const environmentResponses = [];
  if (firstAssistantIndex >= 0) {
    for (let index = firstAssistantIndex + 1; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message || message.role !== "tool") break;
      const parsed = parseJsonLike(message.content);
      const toolCallId = message.tool_call_id || message.tool_call?.id || "";
      environmentResponses.push({
        index,
        toolCallId,
        name: message.name || message.tool_name || toolNames.get(toolCallId) || "tool response",
        summary: responseSummary(parsed),
        parsed,
      });
    }
  }
  const content = event.observability?.value?.choice_logprobs?.content || [];
  const tokens = content.map((entry) => ({
    token: String(entry.token ?? ""),
    logprob: Number.isFinite(entry.logprob) ? entry.logprob : null,
    topLogprobs: Array.isArray(entry.top_logprobs) ? entry.top_logprobs.slice(0, 5) : [],
  }));
  const parsedMessage = event.response?.parsed_message || {};
  return {
    evalDir,
    runId: basename(evalDir),
    result,
    prompt: event.request?.prompt || [],
    samplingArgs: event.request?.sampling_args || {},
    requestMeter: requestMeter(event),
    reasoningTrace: {
      visible: Boolean(
        parsedMessage.reasoning_content ||
        parsedMessage.thinking_blocks ||
        event.response?.native_response?.choices?.[0]?.message?.reasoning
      ),
      content: parsedMessage.reasoning_content ||
        event.response?.native_response?.choices?.[0]?.message?.reasoning ||
        "",
      thinkingBlocks: parsedMessage.thinking_blocks || [],
      finishReason: parsedMessage.finish_reason || event.observability?.value?.finish_reason || "",
    },
    stats: logprobStats(tokens),
    tokens,
    toolCalls,
    environmentResponses,
    turns: collectAssistantTurns(messages),
    judging: judgingSummary(evalDir, trajectory),
    estimatedSpendUsd: result.estimated_spend_usd,
  };
}

function broadcast(type, payload) {
  const event = { type, payload, at: new Date().toISOString() };
  runState.events.push(event);
  if (runState.events.length > 250) runState.events.shift();
  const encoded = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(encoded);
}

function commandForLane(lane, opts) {
  const command = [
    "run",
    "understudy",
    "automationbench",
    "run-official",
    "--provider",
    opts.provider,
    "--model",
    opts.model,
    "--domains",
    "sales",
    "--toolset",
    "api",
    "--tasks",
    "sales.slack_deal_notification",
    "--num-examples",
    "1",
    "--rollouts-per-example",
    "1",
    "--max-steps",
    String(opts.maxSteps),
    "--max-tokens",
    String(opts.maxTokens),
    "--max-concurrent",
    "1",
    "--temperature",
    String(opts.temperature),
    "--capture-logprobs",
    "--top-logprobs",
    String(opts.topLogprobs),
    "--budget-usd",
    String(opts.budgetUsd),
    "--confirm-spend",
    "--timeout-seconds",
    String(opts.timeoutSeconds),
    "--agent-policy",
    "automationbench-v1",
  ];
  if (opts.mode === "gepa" && lane === "gepa") {
    command.push("--agent-policy-file", args.repairedPolicy);
  } else if (opts.mode === "general" && lane === "gepa") {
    command.push("--agent-policy-file", args.generalPolicy);
  } else if (opts.mode === "explore" && lane === "gepa") {
    command.push("--agent-policy-file", args.explorePolicy);
  }
  if (lane === "gepa") {
    command.push("--search-top-k", "10");
  }
  return command;
}

function parseEvalDir(text) {
  const match = text.match(/^eval_dir:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

function latestCompletedEvalDirs(limit = 2) {
  const evalRoot = join(args.agentRepo, ".understudy", "evals");
  if (!existsSync(evalRoot)) return [];
  return readdirSync(evalRoot)
    .filter((name) => name.startsWith("official-automationbench-api-"))
    .map((name) => join(evalRoot, name))
    .filter((dir) => existsSync(join(dir, "model-call-events.jsonl")) && existsSync(join(dir, "trajectories.jsonl")))
    .map((dir) => ({ dir, mtimeMs: statSync(dir).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.dir);
}

function hydrateLatestCompletedRun() {
  const dirs = latestCompletedEvalDirs(2);
  if (!dirs.length) return;
  runState.runId = "latest-completed-artifacts";
  runState.startedAt = new Date().toISOString();
  const lanes = [
    ["baseline", "latest artifact A"],
    ["gepa", "latest artifact B"],
  ];
  for (const [index, dir] of dirs.entries()) {
    const [lane, label] = lanes[index];
    try {
      const summary = summarizeLane(dir);
      runState.lanes[lane] = {
        status: "complete",
        label,
        evalDir: dir,
        summary,
      };
      runState.events.push({
        type: "lane-complete",
        payload: { lane, label, evalDir: dir, summary },
        at: new Date().toISOString(),
      });
    } catch (error) {
      runState.lanes[lane] = { status: "parse-error", label, evalDir: dir };
      runState.events.push({
        type: "lane-error",
        payload: { lane, label, evalDir: dir, error: String(error) },
        at: new Date().toISOString(),
      });
    }
  }
  runState.events.push({
    type: "run-finished",
    payload: {
      runId: runState.runId,
      hydratedFrom: "latest completed local eval artifacts",
      lanes: Object.fromEntries(
        Object.entries(runState.lanes).map(([lane, value]) => [
          lane,
          { status: value.status, evalDir: value.evalDir },
        ]),
      ),
    },
    at: new Date().toISOString(),
  });
}

function runLane(lane, label, opts) {
  return new Promise((resolve) => {
    const command = commandForLane(lane, opts);
    const commandHash = createHash("sha256").update(command.join("\0")).digest("hex").slice(0, 12);
    runState.lanes[lane] = { status: "running", label, command, commandHash };
    broadcast("lane-started", { lane, label, command: ["uv", ...command], commandHash });

    const child = spawn("uv", command, {
      cwd: args.agentRepo,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      broadcast("lane-log", { lane, stream: "stdout", text: chunk });
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      broadcast("lane-log", { lane, stream: "stderr", text: chunk });
    });
    child.on("close", (code) => {
      const evalDir = parseEvalDir(stdout);
      if (code === 0 && evalDir) {
        try {
          const summary = summarizeLane(evalDir);
          runState.lanes[lane] = {
            ...runState.lanes[lane],
            status: "complete",
            evalDir,
            summary,
          };
          broadcast("lane-complete", { lane, label, evalDir, summary });
        } catch (error) {
          runState.lanes[lane] = { ...runState.lanes[lane], status: "parse-error", evalDir };
          broadcast("lane-error", { lane, label, evalDir, error: String(error) });
        }
      } else {
        runState.lanes[lane] = {
          ...runState.lanes[lane],
          status: "failed",
          stdout,
          stderr,
          exitCode: code,
        };
        broadcast("lane-error", { lane, label, exitCode: code, stdout, stderr });
      }
      resolve();
    });
  });
}

async function startLiveRun(options = {}) {
  if (runState.active) {
    broadcast("run-error", { error: "a live run is already active" });
    return;
  }
  const opts = {
    mode: String(options.mode || "gepa"),
    provider: String(options.provider || "lilac"),
    model: String(options.model || "google/gemma-4-31b-it"),
    temperature: Number(options.temperature ?? 0.7),
    budgetUsd: Number(options.budgetUsd ?? 1),
    maxSteps: Number(options.maxSteps ?? 50),
    maxTokens: Number(options.maxTokens ?? 4096),
    topLogprobs: Number(options.topLogprobs ?? 5),
    timeoutSeconds: Number(options.timeoutSeconds ?? 900),
  };
  runState.active = true;
  runState.runId = randomUUID();
  runState.startedAt = new Date().toISOString();
  runState.lanes = {};
  runState.events = [];
  broadcast("run-started", {
    runId: runState.runId,
    opts,
    task: "sales.slack_deal_notification",
    note: opts.mode === "same-prompt"
      ? "Both lanes use the exact same original user task and candidate policy; differences are sampling/runtime variation."
      : opts.mode === "general"
        ? "Both lanes use the same original user task; the right lane also receives a generic side-effect policy derived from observed failure modes."
        : opts.mode === "explore"
          ? "Both lanes use the same original user task; the right lane must explore policy sources, recent examples, and current environment state before side effects."
          : "Both lanes use the same original user task; the GEPA lane also receives the repaired candidate policy.",
  });
  const lanes = opts.mode === "same-prompt"
    ? [
        ["baseline", "31B sample A"],
        ["gepa", "31B sample B"],
      ]
    : opts.mode === "general"
      ? [
          ["baseline", "31B baseline"],
          ["gepa", "31B + general policy"],
        ]
      : opts.mode === "explore"
        ? [
            ["baseline", "31B baseline"],
            ["gepa", "31B + exploration policy"],
          ]
      : [
          ["baseline", "31B baseline"],
          ["gepa", "31B + GEPA policy"],
        ];
  await Promise.all(lanes.map(([lane, label]) => runLane(lane, label, opts)));
  runState.active = false;
  broadcast("run-finished", {
    runId: runState.runId,
    lanes: Object.fromEntries(
      Object.entries(runState.lanes).map(([lane, value]) => [
        lane,
        { status: value.status, evalDir: value.evalDir },
      ]),
    ),
  });
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Live AutomationBench First Round</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f6f2; color: #17191c; }
    main { max-width: 1360px; margin: 0 auto; padding: 22px; }
    header, .panel { background: #fff; border: 1px solid #d8d9d2; border-radius: 8px; padding: 14px; margin-bottom: 14px; }
    h1 { font-size: 23px; margin: 0 0 6px; letter-spacing: 0; }
    h2 { font-size: 17px; margin: 0; letter-spacing: 0; }
    h3 { font-size: 14px; margin: 0; letter-spacing: 0; }
    p { margin: 0; line-height: 1.45; }
    .subtle { color: #5d646b; font-size: 13px; }
    .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-top: 12px; }
    label { display: grid; gap: 4px; color: #5d646b; font-size: 12px; }
    input { width: 96px; border: 1px solid #cfd2ca; border-radius: 6px; padding: 7px 8px; font: inherit; }
    button { border: 1px solid #0969da; background: #0969da; color: #fff; border-radius: 6px; padding: 8px 12px; font-weight: 750; cursor: pointer; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; align-items: start; }
    .lane { background: #fff; border: 1px solid #d8d9d2; border-radius: 8px; padding: 13px; min-width: 0; }
    .lane-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; border-bottom: 1px solid #e4e5df; padding-bottom: 9px; margin-bottom: 10px; }
    .status { border-radius: 999px; background: #eceeeb; border: 1px solid #d2d5cf; padding: 3px 8px; font-size: 11px; font-weight: 750; }
    .status.running { background: #fff0bf; border-color: #dfbf56; }
    .status.complete { background: #e4f3df; border-color: #a8d89e; color: #1f5f32; }
    .status.failed, .status.parse-error { background: #ffd9d6; border-color: #e79b94; color: #8a1f16; }
    .calls, .responses, .logs { display: grid; gap: 8px; }
    .call, .response { border: 1px solid #e1e2dc; border-radius: 8px; overflow: hidden; background: #fbfbf8; }
    .call strong, .response strong { display: block; background: #eef1ec; border-bottom: 1px solid #e1e2dc; padding: 8px 10px; font-size: 12px; }
    dl { margin: 0; }
    .field { display: grid; grid-template-columns: 94px minmax(0, 1fr); gap: 7px; border-bottom: 1px solid #ecede8; padding: 7px 10px; font-size: 12px; }
    dt { color: #5d646b; font-weight: 750; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .stats { display: flex; flex-wrap: wrap; gap: 7px; margin: 8px 0 10px; }
    .stats span, .policy-hit { border: 1px solid #d2d5cf; background: #f7f8f4; border-radius: 999px; padding: 3px 8px; font-size: 11px; font-weight: 700; }
    .request-envelope { border: 1px solid #d8d9d2; border-radius: 8px; overflow: hidden; background: #fbfbf8; margin-bottom: 12px; }
    .request-title { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; background: #eef1ec; border-bottom: 1px solid #d8d9d2; padding: 8px 10px; }
    .meter { padding: 10px; border-bottom: 1px solid #e4e5df; }
    .meter-meta { display: grid; gap: 5px; font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
    .meter-meta strong { font-size: 13px; }
    .legend { display: flex; flex-wrap: wrap; gap: 6px; }
    .legend span { border: 1px solid #d2d5cf; border-radius: 999px; padding: 2px 7px; background: #fff; }
    .request-part { border-bottom: 1px solid #e4e5df; }
    .request-part:last-child { border-bottom: 0; }
    .request-part > strong { display: block; padding: 8px 10px; font-size: 12px; color: #2f363d; }
    .tool-list { display: grid; gap: 7px; padding: 0 10px 10px; }
    .tool-def { border: 1px solid #e1e2dc; border-radius: 7px; background: #fff; overflow: hidden; }
    .tool-def strong { display: block; padding: 7px 8px; border-bottom: 1px solid #ecede8; font-size: 12px; }
    .tool-def p { padding: 7px 8px; font-size: 12px; color: #4e565f; }
    .turn { border: 1px solid #d8d9d2; border-radius: 8px; background: #fbfbf8; overflow: hidden; margin-bottom: 9px; }
    .turn-head { display: flex; justify-content: space-between; gap: 8px; background: #eef1ec; border-bottom: 1px solid #d8d9d2; padding: 8px 10px; font-size: 12px; font-weight: 750; }
    .trace-note { margin: 0 0 8px; border: 1px dashed #cfd2ca; border-radius: 7px; padding: 8px 10px; color: #4e565f; font-size: 12px; background: #fff; }
    .judging { border: 1px solid #d8d9d2; border-radius: 8px; background: #fbfbf8; overflow: hidden; margin-top: 12px; }
    .judging-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; background: #eef1ec; border-bottom: 1px solid #d8d9d2; padding: 8px 10px; }
    .reward { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; padding: 10px; border-bottom: 1px solid #e4e5df; }
    .reward-card { border: 1px solid #d2d5cf; border-radius: 7px; background: #fff; padding: 8px; min-width: 0; }
    .reward-card strong { display: block; font-size: 18px; line-height: 1.1; margin-bottom: 3px; }
    .reward-card span { color: #5d646b; font-size: 11px; font-weight: 750; }
    .assertions { display: grid; gap: 7px; padding: 10px; }
    .assertion { border: 1px solid #e1e2dc; border-radius: 7px; background: #fff; overflow: hidden; }
    .assertion.pass { border-color: #a8d89e; }
    .assertion.fail { border-color: #e79b94; }
    .assertion.excluded { opacity: 0.74; }
    .assertion-head { display: flex; justify-content: space-between; gap: 8px; padding: 7px 8px; border-bottom: 1px solid #ecede8; font-size: 12px; font-weight: 750; }
    .pill { border: 1px solid #d2d5cf; border-radius: 999px; padding: 2px 7px; background: #f7f8f4; font-size: 11px; }
    .pill.pass { background: #e4f3df; border-color: #a8d89e; color: #1f5f32; }
    .pill.fail { background: #ffd9d6; border-color: #e79b94; color: #8a1f16; }
    .pill.excluded { background: #eceeeb; border-color: #d2d5cf; color: #4e565f; }
    .tokens { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 2; overflow-wrap: anywhere; margin-top: 8px; }
    .tok { display: inline-block; margin: 1px 2px; padding: 2px 4px; border-radius: 4px; border: 1px solid transparent; }
    .tok.good { background: #e4f3df; border-color: #a8d89e; }
    .tok.warn { background: #fff0bf; border-color: #dfbf56; }
    .tok.bad { background: #ffd9d6; border-color: #e79b94; }
    .tok.none { background: #eceeeb; border-color: #d2d5cf; }
    details { border-top: 1px solid #ecede8; }
    summary { cursor: pointer; padding: 8px 10px; color: #5d646b; font-size: 12px; font-weight: 750; }
    pre { margin: 0; padding: 9px 10px; white-space: pre-wrap; overflow-wrap: anywhere; background: #f7f8f4; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #2f363d; max-height: 260px; overflow: auto; }
    .logline { white-space: pre-wrap; overflow-wrap: anywhere; font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; border-top: 1px solid #ecede8; padding: 6px 0; color: #4e565f; }
    .empty { color: #5d646b; font-size: 13px; padding: 9px; border: 1px dashed #cfd2ca; border-radius: 8px; background: #fbfbf8; }
    @media (max-width: 980px) { main { padding: 14px; } .grid { grid-template-columns: 1fr; } .reward { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body>
<main>
  <header>
    <h1>Live AutomationBench First Round</h1>
    <p class="subtle">Runs two fresh focused official AutomationBench evals. Same original user task; left uses the fixed standard policy, right can add exploration, general, or GEPA policy. Default max steps is 50 with a one-dollar per-lane budget fuse.</p>
    <div class="controls">
      <label>temperature <input id="temperature" type="number" value="0.7" step="0.1" min="0" max="2"></label>
      <label>max steps <input id="maxSteps" type="number" value="50" step="1" min="1" max="100"></label>
      <label>budget fuse per lane <input id="budgetUsd" type="number" value="1.00" step="0.01" min="0.01"></label>
      <label>top logprobs <input id="topLogprobs" type="number" value="5" step="1" min="1" max="20"></label>
      <button id="runSame">Run same prompt twice</button>
      <button id="runExplore">Run exploration-policy comparison</button>
      <button id="runGeneral">Run general-policy comparison</button>
      <button id="runGepa">Run GEPA comparison</button>
      <span class="subtle" id="runStatus">idle</span>
    </div>
  </header>
  <section class="panel">
    <h2>Original User Prompt</h2>
    <p>${htmlEscape(archivedPrompt())}</p>
    <details>
      <summary>archived system prefix reference</summary>
      <pre>${htmlEscape(archivedSystem())}</pre>
    </details>
  </section>
  <section class="grid">
    <article class="lane" id="baseline">
      <div class="lane-head"><h2>31B sample A</h2><span class="status">idle</span></div>
      <div class="body"><div class="empty">Click Run to start the live first-round eval.</div></div>
    </article>
    <article class="lane" id="gepa">
      <div class="lane-head"><h2>31B sample B</h2><span class="status">idle</span></div>
      <div class="body"><div class="empty">Click Run to start the live first-round eval.</div></div>
    </article>
  </section>
</main>
<script>
const runSameButton = document.getElementById('runSame');
const runExploreButton = document.getElementById('runExplore');
const runGeneralButton = document.getElementById('runGeneral');
const runGepaButton = document.getElementById('runGepa');
const runStatus = document.getElementById('runStatus');
const laneLogs = { baseline: [], gepa: [] };

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
function lpClass(lp) {
  if (lp === null || lp === undefined || Number.isNaN(lp)) return 'none';
  if (lp <= -2) return 'bad';
  if (lp <= -0.75) return 'warn';
  return 'good';
}
function setLaneStatus(lane, status) {
  const node = document.querySelector('#' + lane + ' .status');
  node.textContent = status;
  node.className = 'status ' + status;
}
function setModeLabels(mode) {
  document.querySelector('#baseline h2').textContent = mode === 'same-prompt' ? '31B sample A' : '31B baseline';
  document.querySelector('#gepa h2').textContent = mode === 'same-prompt'
    ? '31B sample B'
    : mode === 'explore'
      ? '31B + exploration policy'
    : mode === 'general'
      ? '31B + general policy'
      : '31B + GEPA policy';
}
function renderArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return '<pre>' + esc(JSON.stringify(args, null, 2)) + '</pre>';
  }
  const rows = Object.entries(args).map(([key, value]) => (
    '<div class="field"><dt>' + esc(key) + '</dt><dd>' + esc(typeof value === 'string' ? value : JSON.stringify(value)) + '</dd></div>'
  )).join('');
  return '<dl>' + rows + '</dl>';
}
function fmtTokens(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(value >= 10000 ? 1 : 2) + 'k';
  return String(value);
}
function roleContent(summary, role) {
  return (summary.requestMeter?.prompt || []).filter((message) => message.role === role).map((message) => message.content).join('\\n\\n');
}
function renderRequestMeter(summary) {
  const meter = summary.requestMeter || {};
  const bucketHtml = (meter.buckets || []).map((bucket) => (
    '<span>' + esc(bucket.label) + ': ' + esc(fmtTokens(bucket.tokens)) + '</span>'
  )).join('');
  const cached = meter.cachedPromptTokens == null ? '' : '<span>cache reported: ' + esc(fmtTokens(meter.cachedPromptTokens)) + ' prompt tokens</span>';
  return '<div class="meter">' +
    '<div class="meter-meta">' +
      '<strong>' + esc(meter.model || 'model') + '</strong>' +
      '<span>' + esc(meter.provider || 'provider') + ' · prompt ' + esc(fmtTokens(meter.promptTokens)) + ' · completion ' + esc(fmtTokens(meter.completionTokens)) + ' · total ' + esc(fmtTokens(meter.totalTokens)) + '</span>' +
      '<div class="legend">' + bucketHtml + '<span>Completion: ' + esc(fmtTokens(meter.completionTokens)) + '</span>' + cached + '</div>' +
      '<span class="subtle">Category split is estimated from serialized request text; totals use provider-reported usage when available.</span>' +
    '</div>' +
  '</div>';
}
function renderRegisteredTools(summary) {
  const tools = summary.requestMeter?.tools || [];
  if (!tools.length) return '<div class="empty">No registered tools in this request.</div>';
  return '<div class="tool-list">' + tools.map((tool) => {
    const params = tool.parameters?.properties || {};
    const args = Object.keys(params);
    return '<article class="tool-def"><strong>' + esc(tool.name) + '</strong>' +
      '<p>' + esc(tool.description || 'No description captured.') + '</p>' +
      '<details><summary>schema' + (args.length ? ': ' + esc(args.join(', ')) : '') + '</summary><pre>' + esc(JSON.stringify(tool.parameters, null, 2)) + '</pre></details>' +
    '</article>';
  }).join('') + '</div>';
}
function renderRequestEnvelope(summary) {
  const systemText = roleContent(summary, 'system');
  const userText = roleContent(summary, 'user');
  return '<section class="request-envelope">' +
    '<div class="request-title"><h3>Request sent to model</h3><span class="subtle">prompt + registered tools</span></div>' +
    renderRequestMeter(summary) +
    '<div class="request-part"><strong>System prompt prefix</strong><pre>' + esc(systemText || '(none)') + '</pre></div>' +
    '<div class="request-part"><strong>Registered tool set under this prefix</strong>' + renderRegisteredTools(summary) + '</div>' +
    '<div class="request-part"><strong>User message</strong><pre>' + esc(userText || '(none)') + '</pre></div>' +
    '<div class="request-part"><strong>Sampling/request args</strong><pre>' + esc(JSON.stringify(summary.samplingArgs || {}, null, 2)) + '</pre></div>' +
  '</section>';
}
function renderReasoningTrace(summary) {
  const trace = summary.reasoningTrace || {};
  if (trace.visible) {
    const content = trace.content || JSON.stringify(trace.thinkingBlocks || [], null, 2);
    return '<div class="trace-note"><strong>Visible reasoning trace captured.</strong><pre>' + esc(content) + '</pre></div>';
  }
  return '<div class="trace-note"><strong>No visible reasoning trace captured before tool calls.</strong> First response finished as ' + esc(trace.finishReason || 'tool_calls') + '; captured reasoning fields were empty/null.</div>';
}
function renderToolCalls(calls) {
  return (calls || []).map((call, index) => (
    '<article class="call"><strong>' + String(index + 1).padStart(2, '0') + ' · ' + esc(call.name) + '</strong>' +
    renderArgs(call.arguments) + '</article>'
  )).join('') || '<div class="empty">No tool calls parsed.</div>';
}
function renderResponses(responses) {
  return (responses || []).map((response, index) => (
    '<article class="response"><strong>' + String(index + 1).padStart(2, '0') + ' · ' + esc(response.name) + '</strong>' +
    '<div class="field"><dt>summary</dt><dd>' + esc(response.summary) + '</dd></div>' +
    '<details><summary>actual environment response JSON</summary><pre>' + esc(JSON.stringify(response.parsed, null, 2)) + '</pre></details></article>'
  )).join('') || '<div class="empty">No tool responses recorded.</div>';
}
function renderActionTurns(summary) {
  const turns = summary.turns || [];
  if (!turns.length) return '<div class="empty">No assistant turns parsed.</div>';
  return turns.map((turn, index) => (
    '<article class="turn">' +
      '<div class="turn-head"><span>Assistant turn ' + (index + 1) + '</span><span>' + esc((turn.toolCalls || []).length) + ' tool request' + ((turn.toolCalls || []).length === 1 ? '' : 's') + ' · ' + esc((turn.environmentResponses || []).length) + ' response' + ((turn.environmentResponses || []).length === 1 ? '' : 's') + '</span></div>' +
      (index === 0 ? renderReasoningTrace(summary) : '') +
      (turn.content ? '<div class="request-part"><strong>Assistant text</strong><pre>' + esc(turn.content) + '</pre></div>' : '<div class="trace-note">Assistant text was empty; the visible action was tool requests.</div>') +
      '<div class="request-part"><strong>Tool requests emitted by model</strong><div class="calls">' + renderToolCalls(turn.toolCalls) + '</div></div>' +
      '<div class="request-part"><strong>Environment responses fed back to model</strong><div class="responses">' + renderResponses(turn.environmentResponses) + '</div></div>' +
    '</article>'
  )).join('');
}
function fmtNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  const number = Number(value);
  return Math.abs(number) >= 1 ? String(number) : number.toFixed(3).replace(/0+$/, '').replace(/\\.$/, '');
}
function renderExpectation(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}
function renderAssertion(assertion, index) {
  const state = assertion.excluded ? 'excluded' : assertion.passed ? 'pass' : 'fail';
  const label = assertion.excluded ? (assertion.passed ? 'excluded pass' : 'excluded fail') : assertion.passed ? 'pass' : 'fail';
  return '<article class="assertion ' + state + '">' +
    '<div class="assertion-head"><span>' + String(index + 1).padStart(2, '0') + ' · ' + esc(assertion.type) + '</span><span class="pill ' + state + '">' + esc(label) + '</span></div>' +
    '<div class="field"><dt>target</dt><dd>' + esc(assertion.target || 'state') + '</dd></div>' +
    '<div class="field"><dt>expects</dt><dd>' + esc(renderExpectation(assertion.expectation)) + '</dd></div>' +
    '<details><summary>raw assertion params</summary><pre>' + esc(JSON.stringify(assertion.params || {}, null, 2)) + '</pre></details>' +
  '</article>';
}
function renderJudging(summary) {
  const judging = summary.judging || {};
  const counted = judging.countedAssertions || [];
  const excluded = judging.excludedAssertions || [];
  const failuresFirst = counted.slice().sort((left, right) => Number(left.passed) - Number(right.passed));
  const outcome = judging.passed ? 'passed' : 'failed';
  const failure = judging.failureNormalization;
  const advantage = judging.advantage;
  return '<section class="judging">' +
    '<div class="judging-head"><h3>Environment reward / judging</h3><span class="subtle">' + esc(judging.source || 'evaluation artifacts') + '</span></div>' +
    '<div class="reward">' +
      '<div class="reward-card"><strong>' + esc(fmtNumber(judging.reward)) + '</strong><span>terminal reward</span></div>' +
      '<div class="reward-card"><strong>' + esc(fmtNumber(judging.score)) + '</strong><span>task score</span></div>' +
      '<div class="reward-card"><strong>' + esc(judging.assertionsPassed ?? 0) + '/' + esc(judging.assertionsTotal ?? counted.length) + '</strong><span>counted assertions</span></div>' +
      '<div class="reward-card"><strong>' + esc(outcome) + '</strong><span>task outcome</span></div>' +
    '</div>' +
    (failure ? '<div class="trace-note"><strong>Failure normalization:</strong> ' + esc(failure.class || 'unknown') + ' · confidence ' + esc(failure.confidence || 'n/a') + '</div>' : '') +
    (advantage ? '<div class="trace-note"><strong>Training signal:</strong> ' + esc(advantage.step_advantage_label || 'n/a') + ' · terminal reward ' + esc(fmtNumber(advantage.terminal_reward)) + ' · assertion success rate ' + esc(fmtNumber(advantage.assertion_success_rate)) + '</div>' : '') +
    '<div class="request-part"><strong>Counted rubric assertions</strong><div class="assertions">' +
      (failuresFirst.length ? failuresFirst.map(renderAssertion).join('') : '<div class="empty">No counted assertion details found.</div>') +
    '</div></div>' +
    '<details><summary>excluded / guardrail checks (' + esc(excluded.length) + ')</summary><div class="assertions">' +
      (excluded.length ? excluded.map(renderAssertion).join('') : '<div class="empty">No excluded checks found.</div>') +
    '</div></details>' +
    '<details><summary>raw judging summary</summary><pre>' + esc(JSON.stringify(judging, null, 2)) + '</pre></details>' +
  '</section>';
}
function renderLaneSummary(lane, summary) {
  const stats = summary.stats || {};
  const statHtml = '<div class="stats">' +
    '<span>' + esc(stats.count ?? 0) + ' tokens</span>' +
    '<span>mean ' + esc(stats.mean == null ? 'n/a' : stats.mean.toFixed(3)) + '</span>' +
    '<span>min ' + esc(stats.min == null ? 'n/a' : stats.min.toFixed(3)) + '</span>' +
    '<span>low ' + esc(stats.low ?? 0) + '</span>' +
    '<span>spend ' + esc(summary.estimatedSpendUsd ?? 'n/a') + '</span>' +
    '</div>';
  const tokens = (summary.tokens || []).map((token, index) => (
    '<span class="tok ' + lpClass(token.logprob) + '" title="token ' + index + ' logprob ' + esc(token.logprob ?? 'n/a') + '">' + esc(token.token) + '</span>'
  )).join('');
  const logs = laneLogs[lane].slice(-20).map((line) => '<div class="logline">' + esc(line) + '</div>').join('');
  document.querySelector('#' + lane + ' .body').innerHTML =
    renderRequestEnvelope(summary) +
    '<h3>Action loop</h3>' + renderActionTurns(summary) +
    '<h3 style="margin-top:12px">First response tokens/logprobs</h3>' + statHtml + '<div class="tokens">' + tokens + '</div>' +
    renderJudging(summary) +
    '<details open><summary>runner log</summary>' + logs + '</details>' +
    '<details><summary>eval dir</summary><pre>' + esc(summary.evalDir) + '</pre></details>';
}
function appendLog(lane, text) {
  laneLogs[lane].push(text);
  const body = document.querySelector('#' + lane + ' .body');
  if (body && !body.querySelector('.calls')) {
    body.innerHTML = '<details open><summary>runner log</summary>' +
      laneLogs[lane].slice(-30).map((line) => '<div class="logline">' + esc(line) + '</div>').join('') +
      '</details>';
  }
}
const events = new EventSource('/events');
events.onmessage = (message) => {
  const event = JSON.parse(message.data);
  const p = event.payload || {};
  if (event.type === 'run-started') {
    runStatus.textContent = 'running live evals';
    setModeLabels(p.opts?.mode || 'gepa');
    runSameButton.disabled = true;
    runExploreButton.disabled = true;
    runGeneralButton.disabled = true;
    runGepaButton.disabled = true;
    for (const lane of ['baseline', 'gepa']) {
      laneLogs[lane] = [];
      setLaneStatus(lane, 'running');
      document.querySelector('#' + lane + ' .body').innerHTML = '<div class="empty">Starting live official run...</div>';
    }
  } else if (event.type === 'lane-started') {
    setLaneStatus(p.lane, 'running');
    appendLog(p.lane, '$ ' + (p.command || []).join(' '));
  } else if (event.type === 'lane-log') {
    appendLog(p.lane, p.text);
  } else if (event.type === 'lane-complete') {
    setLaneStatus(p.lane, 'complete');
    if (p.label) document.querySelector('#' + p.lane + ' h2').textContent = p.label;
    renderLaneSummary(p.lane, p.summary);
  } else if (event.type === 'lane-error') {
    setLaneStatus(p.lane, 'failed');
    appendLog(p.lane, p.error || p.stderr || p.stdout || 'lane failed');
  } else if (event.type === 'run-finished') {
    runStatus.textContent = 'finished';
    runSameButton.disabled = false;
    runExploreButton.disabled = false;
    runGeneralButton.disabled = false;
    runGepaButton.disabled = false;
  } else if (event.type === 'run-error') {
    runStatus.textContent = p.error || 'run error';
    runSameButton.disabled = false;
    runExploreButton.disabled = false;
    runGeneralButton.disabled = false;
    runGepaButton.disabled = false;
  }
};
async function startRun(mode) {
  runSameButton.disabled = true;
  runExploreButton.disabled = true;
  runGeneralButton.disabled = true;
  runGepaButton.disabled = true;
  runStatus.textContent = 'starting';
  const payload = {
    mode,
    temperature: Number(document.getElementById('temperature').value),
    budgetUsd: Number(document.getElementById('budgetUsd').value),
    maxSteps: Number(document.getElementById('maxSteps').value),
    topLogprobs: Number(document.getElementById('topLogprobs').value),
  };
  const response = await fetch('/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    runStatus.textContent = await response.text();
    runSameButton.disabled = false;
    runExploreButton.disabled = false;
    runGeneralButton.disabled = false;
    runGepaButton.disabled = false;
  }
}
runSameButton.addEventListener('click', () => startRun('same-prompt'));
runExploreButton.addEventListener('click', () => startRun('explore'));
runGeneralButton.addEventListener('click', () => startRun('general'));
runGepaButton.addEventListener('click', () => startRun('gepa'));
</script>
</body>
</html>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${args.host}:${args.port}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pageHtml());
    return;
  }
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    clients.add(res);
    for (const event of runState.events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "GET" && url.pathname === "/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(runState, null, 2));
    return;
  }
  if (req.method === "POST" && url.pathname === "/run") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("invalid JSON");
        return;
      }
      if (runState.active) {
        res.writeHead(409, { "content-type": "text/plain" });
        res.end("run already active");
        return;
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      void startLiveRun(payload);
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

hydrateLatestCompletedRun();

server.listen(args.port, args.host, () => {
  console.log(`Live first-round harness: http://${args.host}:${args.port}/`);
});
