#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

function usage() {
  return `Usage:
  node scripts/automationbench-handoff-runner.mjs --handoff <path> [--print-commands]
  node scripts/automationbench-handoff-runner.mjs --handoff <path> --results <path> [--candidate <id>] [--cohort-run-id <id>] [--mode <mode>] [--mode-prefix <prefix>] [--sidekick-runs <n>] [--sidekick-tool-calls <n>] [--post] [--token <token>]

Reads an Understudy AutomationBench handoff packet and either prints the intended
candidate runs or normalizes runner results for the desktop callback endpoint.

Result input may be a native AutomationBench export, a JSON array, or JSONL. Each row should include:
  candidate, task_id, status, score, elapsed_ms, model

Optional row fields:
  prompt_tokens, completion_tokens, local_mem_gb, notes, run_id
`;
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
      if (!candidateId) {
        throw new Error("native AutomationBench exports require --candidate");
      }
      const durationMs =
        typeof parsed.meta.duration_seconds === "number"
          ? Math.round((parsed.meta.duration_seconds * 1000) / Math.max(parsed.tasks.length, 1))
          : undefined;
      return parsed.tasks.map((task) => ({
        candidate: candidateId,
        task_id: task.name ?? task.id,
        status: task.passed ? "ok" : "error",
        score: task.score,
        elapsed_ms: durationMs,
        model: parsed.meta.model,
        prompt_tokens: task.input_tokens,
        completion_tokens: task.output_tokens,
        notes: [
          `domain=${(parsed.meta.domains ?? []).join(",") || "unknown"}`,
          `task=${task.name ?? task.id}`,
          `passed=${Boolean(task.passed)}`,
          `assertions=${task.assertions_passed ?? 0}/${task.assertions_total ?? 0}`,
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
    return {
      run_id: options.cohortRunId ?? row.run_id ?? candidate.run_id,
      task_id: String(row.task_id ?? row.example_id ?? row.id ?? `automationbench-row-${index}`),
      mode,
      model: String(row.model ?? candidate.model),
      elapsed_ms: row.elapsed_ms === undefined ? null : Number(row.elapsed_ms),
      prompt_tokens: row.prompt_tokens === undefined ? null : Number(row.prompt_tokens),
      completion_tokens: row.completion_tokens === undefined ? null : Number(row.completion_tokens),
      sidekick_runs: row.sidekick_runs === undefined ? Number(options.sidekickRuns ?? 0) : Number(row.sidekick_runs),
      sidekick_tool_calls:
        row.sidekick_tool_calls === undefined
          ? Number(options.sidekickToolCalls ?? 0)
          : Number(row.sidekick_tool_calls),
      gateway_used: candidate.route === "gateway",
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
  const resultsPath = argValue(args, "--results");
  if (resultsPath) {
    const normalized = normalizeRows(handoff, readResultRows(resultsPath, argValue(args, "--candidate")), {
      cohortRunId: argValue(args, "--cohort-run-id"),
      mode: argValue(args, "--mode"),
      modePrefix: argValue(args, "--mode-prefix"),
      sidekickRuns: argValue(args, "--sidekick-runs"),
      sidekickToolCalls: argValue(args, "--sidekick-tool-calls"),
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
