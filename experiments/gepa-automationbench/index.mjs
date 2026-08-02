#!/usr/bin/env node
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TASKS, taskPool, splitSha256 } from "../../dist/automationbench-offline.js";
import { ArtifactStore, GpuCostLedger } from "./artifacts.mjs";
import { CostLedger, FireworksClient } from "./client.mjs";
import { DEFAULT_PROMPT, optimize, selectDev } from "./gepa.mjs";
import { rolloutModel } from "./runner.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function numberArg(name, fallback) {
  return Number(arg(name, fallback));
}

function stubClient(kind) {
  return {
    async chat(messages) {
      const system = messages.find((message) => message.role === "system")?.content ?? "";
      const user = messages.find((message) => message.role === "user")?.content ?? "";
      if (kind === "marker" && !system.includes("GEPA_MARKER")) return { message: { content: "<finish/>" }, usage: { prompt: 1, completion: 1 } };
      if (kind === "oracle" || kind === "marker") {
        const task = TASKS.find((entry) => user.includes(entry.prompt));
        const action = task?.oracle?.[messages.filter((message) => message.role === "tool").length];
        return { message: { content: action ? `<tool_call>${JSON.stringify(action)}</tool_call>` : "<finish/>" }, usage: { prompt: 1, completion: 1 } };
      }
      return { message: { content: "<finish/>" }, usage: { prompt: 1, completion: 1 } };
    },
  };
}

function makeClients(stub, options) {
  if (stub) {
    const tokenLedger = new CostLedger({ budgetUsd: options.budgetUsd });
    const wrap = (client) => ({
      async chat(messages, callOptions) {
        const response = await client.chat(messages, callOptions);
        tokenLedger.add(response.usage);
        return response;
      },
    });
    const reflection = stub === "marker"
      ? { async chat() { return { message: { content: "GEPA_MARKER: use the tools carefully and emit <finish/> only when complete." }, usage: { prompt: 1, completion: 1 } }; } }
      : stubClient("null");
    return { modelClient: wrap(stubClient(stub)), reflectionClient: wrap(reflection), tokenLedger, requestTelemetry: { rate_limit_429s: 0 } };
  }
  const tokenLedger = new CostLedger({ budgetUsd: options.budgetUsd });
  const modelClient = new FireworksClient({ ...options, ledger: tokenLedger });
  return { modelClient, reflectionClient: modelClient, tokenLedger, requestTelemetry: modelClient.telemetry };
}

function mean(rows) {
  return rows.length ? rows.reduce((sum, row) => sum + Number(row.score ?? 0), 0) / rows.length : 0;
}

function tokenTotals(results) {
  return results.reduce((total, result) => ({ prompt: total.prompt + result.tokens.prompt, completion: total.completion + result.tokens.completion }), { prompt: 0, completion: 0 });
}

async function evaluateTasks({ tasks, prompt, modelClient, model, store, phase, concurrency, maxSteps, maxTokens, gpu }) {
  return Promise.all(tasks.map((task) => rolloutModel({ taskId: task.taskId, prompt, modelClient, model, store, phase, maxSteps, maxTokens, usdPerGpuHour: gpu.usdPerGpuHour, gpuCount: gpu.gpuCount })));
}

async function baseline({ split, prompt, clients, store, model, concurrency, maxSteps, maxTokens, limit = Infinity, gpu, ledger }) {
  return ledger.phase(`baseline-${split}`, async () => {
    const results = await evaluateTasks({ tasks: taskPool({ split }).slice(0, limit), prompt, modelClient: clients.modelClient, model, store, phase: `baseline-${split}`, concurrency, maxSteps, maxTokens, gpu });
    return { results, rows: store.evalRows({ runId: `baseline-${split}`, model, split, results }), tokens: tokenTotals(results), mean: results.reduce((sum, result) => sum + result.reward, 0) / results.length, gpu: ledger.snapshot() };
  });
}

function receiptTelemetry(output, requestTelemetry = { rate_limit_429s: 0 }) {
  const counts = {};
  let parseFailures = 0;
  let multipleToolCallTurns = 0;
  let rollouts = 0;
  const failureModesByPhase = {};
  const path = join(output, "rollouts.jsonl");
  if (!existsSync(path)) return { encoding_distribution: counts, parse_failures: 0, multiple_tool_call_turns: 0, rollouts: 0, rate_limit_429s: requestTelemetry.rate_limit_429s ?? 0, failure_modes_by_phase: failureModesByPhase };
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const receipt = JSON.parse(line);
    rollouts += 1;
    parseFailures += receipt.parse_failures ?? 0;
    multipleToolCallTurns += receipt.multiple_tool_call_turns ?? 0;
    const phase = failureModesByPhase[receipt.phase] ??= { parse_failures: 0, no_call_turns: 0, step_cap_exhaustion: 0, premature_finish: 0, forbidden_effects: 0, multiple_tool_call_turns: 0 };
    phase.parse_failures += receipt.parse_failures ?? 0;
    phase.no_call_turns += receipt.no_call_turns ?? 0;
    phase.step_cap_exhaustion += Number(receipt.step_cap_exhausted);
    phase.premature_finish += Number(receipt.premature_finish);
    phase.forbidden_effects += receipt.forbidden_effects?.length ?? 0;
    phase.multiple_tool_call_turns += receipt.multiple_tool_call_turns ?? 0;
    for (const [encoding, count] of Object.entries(receipt.encoding_counts ?? {})) counts[encoding] = (counts[encoding] ?? 0) + count;
  }
  return { encoding_distribution: counts, parse_failures: parseFailures, multiple_tool_call_turns: multipleToolCallTurns, rollouts, rate_limit_429s: requestTelemetry.rate_limit_429s ?? 0, failure_modes_by_phase: failureModesByPhase };
}

async function runModel({ output, clients, store, model, concurrency, maxSteps, maxTokens, gpu, ledger }) {
  if (existsSync(join(output, "summary.json"))) return store.readJson("summary.json");
  const baselineDev = existsSync(join(output, "baseline-dev.json"))
    ? store.readJson("baseline-dev.json")
    : await baseline({ split: "dev", prompt: DEFAULT_PROMPT, clients, store, model, concurrency, maxSteps, maxTokens, gpu, ledger });
  if (!existsSync(join(output, "baseline-dev.json"))) store.writeJson("baseline-dev.json", baselineDev);
  const optimization = existsSync(join(output, "archive.json"))
    ? store.readJson("archive.json")
    : await ledger.phase("optimize", () => optimize({ modelClient: clients.modelClient, reflectionClient: clients.reflectionClient, model, reflectionModel: arg("reflection-model", "accounts/fireworks/models/kimi-k3"), generations: numberArg("generations", 1), minibatch: numberArg("minibatch", 16), candidatesPerGeneration: numberArg("candidates", 1), maxRollouts: numberArg("max-rollouts", Infinity), store, concurrency, maxSteps, maxTokens, usdPerGpuHour: gpu.usdPerGpuHour, gpuCount: gpu.gpuCount }));
  if (!existsSync(join(output, "archive.json"))) store.writeJson("archive.json", optimization);
  const topK = Math.max(1, numberArg("top-k", 3));
  const candidates = [ { prompt: DEFAULT_PROMPT, prompt_sha256: "bare-baseline" }, ...optimization.archive.sort((a, b) => b.mean - a.mean || a.prompt_sha256.localeCompare(b.prompt_sha256)).slice(0, topK) ];
  const uniqueCandidates = [...new Map(candidates.map((entry) => [entry.prompt, entry])).values()];
  const selection = existsSync(join(output, "dev-selection.json"))
    ? store.readJson("dev-selection.json")
    : await ledger.phase("dev-selection", () => selectDev({ archive: uniqueCandidates, modelClient: clients.modelClient, model, store, concurrency, maxSteps, maxTokens, usdPerGpuHour: gpu.usdPerGpuHour, gpuCount: gpu.gpuCount }));
  if (!existsSync(join(output, "dev-selection.json"))) store.writeJson("dev-selection.json", selection);
  const winner = selection[0];
  const summary = {
    baseline_dev: mean(selection.find((entry) => entry.prompt === DEFAULT_PROMPT)?.dev_scores ? Object.values(selection.find((entry) => entry.prompt === DEFAULT_PROMPT).dev_scores).map((score) => ({ score })) : []),
    optimized_dev: winner.dev_mean,
    winning_prompt: winner.prompt,
    winning_prompt_sha256: winner.prompt_sha256,
    rollout_counts: { baseline_dev: baselineDev.results?.length ?? 12, optimize: optimization.rollouts, dev_selection: uniqueCandidates.length * taskPool({ split: "dev" }).length },
    tokens: clients.tokenLedger?.snapshot() ?? null,
    gpu: ledger.snapshot(),
    telemetry: receiptTelemetry(output, clients.requestTelemetry),
  };
  store.writeJson("summary.json", summary);
  return summary;
}

async function main() {
  const command = process.argv[2];
  const output = arg("output", join(process.cwd(), "outputs/gepa-automationbench"));
  mkdirSync(output, { recursive: true });
  const store = new ArtifactStore(output);
  const options = { model: arg("model", "accounts/fireworks/models/unspecified"), baseUrl: arg("base-url", undefined), concurrency: numberArg("concurrency", 8), maxSteps: numberArg("max-steps", 12), maxTokens: numberArg("max-tokens", 2048), budgetUsd: numberArg("budget-usd", Infinity) };
  const gpu = { usdPerGpuHour: numberArg("usd-per-gpu-hour", 7), gpuCount: numberArg("gpu-count", 1) };
  const ledger = new GpuCostLedger({ ...gpu, budgetUsd: options.budgetUsd });
  const clients = makeClients(arg("stub", null), options);
  if (command === "run-model") {
    console.log(JSON.stringify(await runModel({ output, clients, store, model: options.model, concurrency: options.concurrency, maxSteps: options.maxSteps, maxTokens: options.maxTokens, gpu, ledger }), null, 2));
    return;
  }
  if (command === "baseline") {
    const split = arg("split", "train");
    if (split === "holdout") throw new Error("holdout baseline requires the holdout subcommand and --frozen-holdout-sha256");
    const result = await baseline({ split, prompt: DEFAULT_PROMPT, clients, store, model: options.model, concurrency: options.concurrency, maxSteps: options.maxSteps, maxTokens: options.maxTokens, limit: numberArg("limit", Infinity), gpu, ledger });
    result.gpu = ledger.snapshot();
    result.telemetry = receiptTelemetry(output, clients.requestTelemetry);
    store.writeJson(`${split}-summary.json`, result);
    return;
  }
  if (command === "optimize") {
    const result = await ledger.phase("optimize", () => optimize({ modelClient: clients.modelClient, reflectionClient: clients.reflectionClient, model: options.model, reflectionModel: arg("reflection-model", "accounts/fireworks/models/kimi-k3"), generations: numberArg("generations", 1), minibatch: numberArg("minibatch", 16), candidatesPerGeneration: numberArg("candidates", 1), maxRollouts: numberArg("max-rollouts", Infinity), store, concurrency: options.concurrency, maxSteps: options.maxSteps, maxTokens: options.maxTokens, usdPerGpuHour: gpu.usdPerGpuHour, gpuCount: gpu.gpuCount }));
    store.writeJson("archive.json", result);
    return;
  }
  if (command === "dev") {
    const archive = store.readJson("archive.json").archive;
    const result = await ledger.phase("dev-selection", () => selectDev({ archive, modelClient: clients.modelClient, model: options.model, store, concurrency: options.concurrency, maxSteps: options.maxSteps, maxTokens: options.maxTokens, usdPerGpuHour: gpu.usdPerGpuHour, gpuCount: gpu.gpuCount }));
    store.writeJson("dev-selection.json", result);
    return;
  }
  if (command === "holdout") {
    const provided = arg("frozen-holdout-sha256", null);
    if (provided !== splitSha256("holdout")) throw new Error("frozen-holdout refusal: matching --frozen-holdout-sha256 is required");
    if (existsSync(join(output, "holdout-summary.json"))) throw new Error("holdout refusal: holdout receipt already exists; holdout may run exactly once");
    const selected = store.readJson("dev-selection.json")[0];
    const result = await ledger.phase("holdout", async () => {
      const results = await evaluateTasks({ tasks: taskPool({ split: "holdout", frozenHoldoutSha256: provided }), prompt: selected.prompt, modelClient: clients.modelClient, model: options.model, store, phase: "holdout", concurrency: options.concurrency, maxSteps: options.maxSteps, maxTokens: options.maxTokens, gpu });
      return { results, rows: store.evalRows({ runId: "holdout-final", model: options.model, split: "holdout", results }), tokens: tokenTotals(results), mean: results.reduce((sum, entry) => sum + entry.reward, 0) / results.length, gpu: ledger.snapshot() };
    });
    result.gpu = ledger.snapshot();
    store.writeJson("holdout-summary.json", result);
    return;
  }
  throw new Error("usage: run-model|baseline|optimize|dev|holdout");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
