#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

function usage() {
  return `Usage:
  node scripts/automationbench-handoff-runner.mjs --handoff <path> [--print-commands]
  node scripts/automationbench-handoff-runner.mjs --handoff <path> --print-fusion-commands [--base-url <url>]
  node scripts/automationbench-handoff-runner.mjs --handoff <path> --results <path> [--candidate <id>] [--cohort-run-id <id>] [--mode <mode>] [--mode-prefix <prefix>] [--sidekick-runs <n>] [--sidekick-tool-calls <n>] [--gateway-used true|false] [--fusion-event-log <path>] [--post] [--token <token>]

Reads an Understudy AutomationBench handoff packet and either prints the intended
candidate runs or normalizes runner results for the desktop callback endpoint.

Result input may be a native AutomationBench export, a JSON array, or JSONL. Each row should include:
  candidate, task_id, status, score, elapsed_ms, model

Optional row fields:
  prompt_tokens, completion_tokens, local_mem_gb, notes, run_id

Fusion proxy event logs may be passed with --fusion-event-log to enrich routed
rows with observed route, gateway usage, tokens, latency, and sidekick state.
`;
}

const FUSION_MODEL_DEFAULTS = new Map([
  ["understudy-fusion-main", { candidate: "local-main", mode: "main-only", sidekickRuns: 0, gatewayUsed: false }],
  ["understudy-fusion-fast", { candidate: "local-fast", mode: "candidate-local-fast", sidekickRuns: 0, gatewayUsed: false }],
  ["understudy-fusion-sidekick-main", { candidate: "local-main", mode: "sidekick-parallel", sidekickRuns: 1, gatewayUsed: false }],
  [
    "understudy-fusion-sidekick-advisory-main",
    { candidate: "local-main", mode: "sidekick-advisory", sidekickRuns: 1, gatewayUsed: false },
  ],
  ["understudy-fusion-sidekick-gateway", { candidate: "gateway-glm", mode: "sidekick-parallel", sidekickRuns: 1, gatewayUsed: true }],
  [
    "understudy-fusion-sidekick-advisory-gateway",
    { candidate: "gateway-glm", mode: "sidekick-advisory", sidekickRuns: 1, gatewayUsed: true },
  ],
  ["understudy-fusion-routing", { candidate: "local-main", mode: "sidekick-routing", sidekickRuns: 1, gatewayUsed: null }],
]);

function fusionDefaultsForModel(model) {
  return FUSION_MODEL_DEFAULTS.get(String(model ?? ""));
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readResultRows(path, candidateId) {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  if (raw.startsWith("["))
    return JSON.parse(raw).map((row) => ({ candidate: candidateId ?? row.candidate, ...row }));
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.tasks) && parsed.meta) {
      const modelDefaults = fusionDefaultsForModel(parsed.meta.model);
      const inferredCandidate = candidateId ?? modelDefaults?.candidate;
      if (!inferredCandidate) throw new Error("native AutomationBench exports require --candidate");
      const durationMs =
        typeof parsed.meta.duration_seconds === "number"
          ? Math.round((parsed.meta.duration_seconds * 1000) / Math.max(parsed.tasks.length, 1))
          : undefined;
      return parsed.tasks.map((task) => ({
        candidate: inferredCandidate,
        task_id: task.name ?? task.id,
        status: task.passed ? "ok" : "error",
        score: task.score,
        elapsed_ms: durationMs,
        model: parsed.meta.model,
        mode: modelDefaults?.mode,
        sidekick_runs: modelDefaults?.sidekickRuns,
        gateway_used: modelDefaults?.gatewayUsed,
        prompt_tokens: task.input_tokens,
        completion_tokens: task.output_tokens,
        notes: [
          `domain=${(parsed.meta.domains ?? []).join(",") || "unknown"}`,
          `task=${task.name ?? task.id}`,
          `passed=${Boolean(task.passed)}`,
          `assertions=${task.assertions_passed ?? 0}/${task.assertions_total ?? 0}`,
          modelDefaults ? `fusion_mode=${modelDefaults.mode}` : null,
        ].join("; "),
      }));
    }
    return [{ candidate: candidateId ?? parsed.candidate, ...parsed }];
  }
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line);
      return { candidate: candidateId ?? row.candidate, ...row };
    });
}

function readFusionEvents(path) {
  if (!path) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.schema_version === "understudy.fusion_proxy_event.v1");
}

function enrichRowsWithFusionEvents(rows, events) {
  if (!events.length) return rows;
  const queues = new Map();
  for (const event of events) {
    const model = String(event.requested_model ?? "");
    if (!model) continue;
    const queue = queues.get(model) ?? [];
    queue.push(event);
    queues.set(model, queue);
  }
  return rows.map((row) => {
    const model = String(row.model ?? "");
    if (!model.startsWith("understudy-fusion-")) return row;
    const event = queues.get(model)?.shift();
    if (!event) return row;
    const eventNotes = [
      `fusion_route=${event.route ?? "unknown"}`,
      event.routing_reason ? `routing_reason=${event.routing_reason}` : null,
      `upstream=${event.upstream_model ?? "unknown"}`,
      `sidekick=${event.sidekick_mode ?? "off"}`,
      event.sidekick_pending ? "sidekick_pending=true" : null,
      event.sidekick_error ? "sidekick_error=true" : null,
    ]
      .filter(Boolean)
      .join("; ");
    return {
      ...row,
      elapsed_ms: event.elapsed_ms ?? row.elapsed_ms,
      prompt_tokens: event.prompt_tokens ?? row.prompt_tokens,
      completion_tokens: event.completion_tokens ?? row.completion_tokens,
      gateway_used: event.gateway_used,
      sidekick_runs: event.sidekick_mode && event.sidekick_mode !== "off" ? 1 : 0,
      sidekick_tool_calls: event.tool_count ?? row.sidekick_tool_calls,
      notes: row.notes ? `${row.notes}; ${eventNotes}` : eventNotes,
    };
  });
}

function requireHandoff(path) {
  if (!existsSync(path)) throw new Error(`handoff not found: ${path}`);
  const handoff = readJson(path);
  if (handoff.schema_version !== "understudy.automationbench_handoff.v1") {
    throw new Error(`unsupported handoff schema: ${handoff.schema_version ?? "missing"}`);
  }
  if (!Array.isArray(handoff.candidates) || handoff.candidates.length === 0) {
    throw new Error("handoff has no candidates");
  }
  return handoff;
}

function optionalBoolean(value, name) {
  if (value === null || value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function candidateById(handoff) {
  return new Map(handoff.candidates.map((candidate) => [candidate.candidate, candidate]));
}

function normalizeRows(handoff, rows, options = {}) {
  const candidates = candidateById(handoff);
  return rows.map((row, index) => {
    const candidate = candidates.get(row.candidate);
    if (!candidate) {
      throw new Error(`row ${index} references unknown candidate: ${row.candidate}`);
    }
    const status = row.status ?? "ok";
    const score = row.score === undefined || row.score === null ? null : Number(row.score);
    const mode = options.mode
      ? options.mode
      : options.modePrefix
      ? `${options.modePrefix}-${candidate.candidate}`
      : (row.mode ?? "automationbench");
    const modelDefaults = fusionDefaultsForModel(row.model ?? candidate.model);
    const sidekickRuns =
      row.sidekick_runs === undefined
        ? options.sidekickRuns === undefined
          ? Number(modelDefaults?.sidekickRuns ?? 0)
          : Number(options.sidekickRuns)
        : Number(row.sidekick_runs);
    const gatewayUsed =
      options.gatewayUsed !== undefined
        ? options.gatewayUsed
        : row.gateway_used === true || row.gateway_used === false
        ? row.gateway_used
        : modelDefaults?.gatewayUsed === null || modelDefaults?.gatewayUsed === undefined
          ? candidate.route === "gateway"
          : modelDefaults.gatewayUsed;
    return {
      run_id: options.cohortRunId ?? row.run_id ?? candidate.run_id,
      task_id: String(row.task_id ?? row.example_id ?? row.id ?? `automationbench-row-${index}`),
      mode,
      model: String(row.model ?? candidate.model),
      elapsed_ms: row.elapsed_ms === undefined ? null : Number(row.elapsed_ms),
      prompt_tokens: row.prompt_tokens === undefined ? null : Number(row.prompt_tokens),
      completion_tokens: row.completion_tokens === undefined ? null : Number(row.completion_tokens),
      sidekick_runs: sidekickRuns,
      sidekick_tool_calls:
        row.sidekick_tool_calls === undefined
          ? Number(options.sidekickToolCalls ?? 0)
          : Number(row.sidekick_tool_calls),
      gateway_used: gatewayUsed,
      compacted: false,
      context_tokens_before: row.prompt_tokens === undefined ? null : Number(row.prompt_tokens),
      local_mem_gb: row.local_mem_gb === undefined ? null : Number(row.local_mem_gb),
      score,
      status,
      notes: String(row.notes ?? `automationbench; candidate=${row.candidate}; route=${candidate.route}`),
    };
  });
}

async function postRows(handoff, rows, token) {
  if (!token) throw new Error("--post requires --token or UNDERSTUDY_DESKTOP_TOKEN");
  const url = handoff.callback?.record_result_url;
  if (!url) throw new Error("handoff missing callback.record_result_url");
  for (const row of rows) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(row),
    });
    if (!response.ok) {
      throw new Error(`post failed ${response.status}: ${await response.text()}`);
    }
  }
}

function printCommands(handoff) {
  console.log(`# ${handoff.benchmark} handoff: ${handoff.run_id}`);
  console.log(`# domains=${handoff.domains.join(",")} num_examples=${handoff.num_examples}`);
  for (const command of handoff.commands ?? []) {
    console.log(command);
  }
  for (const candidate of handoff.candidates) {
    console.log("");
    console.log(`# candidate=${candidate.candidate} run_id=${candidate.run_id}`);
    console.log(`# route=${candidate.route} model=${candidate.model}`);
    console.log(
      `uv run auto-bench --model "${candidate.model}" --domains "${handoff.domains.join(",")}" --num-examples ${handoff.num_examples}`,
    );
  }
}

function printFusionCommands(handoff, baseUrl = "http://127.0.0.1:17890/v1") {
  const domains = handoff.domains.join(",");
  const examples = handoff.num_examples;
  const runs = [
    { label: "local-main", model: "gemma-4-26b-a4b-it-qat-mlx-vlm-understudy", baseUrl: "http://127.0.0.1:8091/v1", apiKey: "local" },
    { label: "local-fast", model: "gemma-4-e2b-it-qat-mlx-vlm-understudy", baseUrl: "http://127.0.0.1:8092/v1", apiKey: "local" },
    { label: "gateway-glm", model: "glm-5.2", baseUrl: "$UNDERSTUDY_GATEWAY_BASE_URL/v1", apiKey: "$UNDERSTUDY_GATEWAY_API_KEY" },
    { label: "fusion-main", model: "understudy-fusion-main", baseUrl, apiKey: "fusion" },
    { label: "fusion-sidekick-parallel", model: "understudy-fusion-sidekick-main", baseUrl, apiKey: "fusion" },
    { label: "fusion-sidekick-advisory", model: "understudy-fusion-sidekick-advisory-main", baseUrl, apiKey: "fusion" },
    { label: "fusion-routing", model: "understudy-fusion-routing", baseUrl, apiKey: "fusion" },
  ];
  console.log(`# ${handoff.benchmark} Fusion command matrix: ${handoff.run_id}`);
  console.log(`# Start proxy first: node scripts/automationbench-fusion-proxy.mjs --port 17890`);
  for (const run of runs) {
    const exportPath = `/tmp/understudy-automationbench-${handoff.run_id}-${run.label}.json`;
    console.log("");
    console.log(`# ${run.label}`);
    console.log(
      [
        "uv run auto-bench",
        `--model "${run.model}"`,
        `--base-url "${run.baseUrl}"`,
        `--api-key "${run.apiKey}"`,
        `--domains "${domains}"`,
        `--num-examples ${examples}`,
        "--max-concurrent 1",
        "--max-steps 10",
        "--toolset api",
        `--export-json "${exportPath}"`,
        "--save-every -1",
      ].join(" "),
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(usage());
    return;
  }
  const handoffPath = argValue(args, "--handoff");
  if (!handoffPath) throw new Error("--handoff is required");
  const handoff = requireHandoff(handoffPath);
  if (args.includes("--print-commands")) {
    printCommands(handoff);
  }
  if (args.includes("--print-fusion-commands")) {
    printFusionCommands(handoff, argValue(args, "--base-url") ?? undefined);
  }
  const resultsPath = argValue(args, "--results");
  if (resultsPath) {
    const resultRows = readResultRows(resultsPath, argValue(args, "--candidate"));
    const fusionEventLogPath = argValue(args, "--fusion-event-log");
    const enrichedRows = fusionEventLogPath
      ? enrichRowsWithFusionEvents(resultRows, readFusionEvents(fusionEventLogPath))
      : resultRows;
    const normalized = normalizeRows(handoff, enrichedRows, {
      cohortRunId: argValue(args, "--cohort-run-id"),
      mode: argValue(args, "--mode"),
      modePrefix: argValue(args, "--mode-prefix"),
      sidekickRuns: argValue(args, "--sidekick-runs"),
      sidekickToolCalls: argValue(args, "--sidekick-tool-calls"),
      gatewayUsed: optionalBoolean(argValue(args, "--gateway-used"), "--gateway-used"),
    });
    console.log(JSON.stringify({ schema_version: "understudy.automationbench_normalized_results.v1", rows: normalized }, null, 2));
    if (args.includes("--post")) {
      await postRows(handoff, normalized, argValue(args, "--token") ?? process.env.UNDERSTUDY_DESKTOP_TOKEN);
      console.error(`posted ${normalized.length} rows`);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
