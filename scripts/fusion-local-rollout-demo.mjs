#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_OUT_DIR = ".understudy/fusion-demo";
const DEFAULT_PROBLEMS = [
  {
    id: "mechanical-search",
    category: "mechanical",
    prompt:
      "Find the sidekick routing policy in the Understudy desktop harness and summarize what causes parallel delegation.",
    rubric: ["mentions sidekick routing", "separates mechanical work from judgment", "cites concrete evidence"],
  },
  {
    id: "verification-boundary",
    category: "verification",
    prompt:
      "Review whether a local rollout result is strong enough to claim success. State what evidence is missing before final acceptance.",
    rubric: ["treats weak evidence as incomplete", "lists final-state assertions", "does not overclaim"],
  },
  {
    id: "routing-judgment",
    category: "judgment",
    prompt:
      "A simple local task turned into a multi-file production-risk architecture change. Decide whether to keep local, use sidekick, or upgrade to gateway.",
    rubric: ["keeps final judgment with main", "allows sidekick only for bounded checks", "identifies gateway escalation"],
  },
];

const CANDIDATES = {
  "local-main": {
    route: "local",
    model: "gemma-4-26b-a4b-it-qat-mlx-vlm-understudy",
    baseUrl: "http://127.0.0.1:8091/v1",
    apiKey: "local",
  },
  "local-fast": {
    route: "local",
    model: "gemma-4-e2b-it-qat-mlx-vlm-understudy",
    baseUrl: "http://127.0.0.1:8092/v1",
    apiKey: "local",
  },
  "gateway-glm": {
    route: "gateway",
    model: "glm-5.2",
    baseUrl: "$UNDERSTUDY_GATEWAY_BASE_URL/v1",
    apiKey: "$UNDERSTUDY_GATEWAY_API_KEY",
  },
};

function usage() {
  return `Usage:
  node scripts/fusion-local-rollout-demo.mjs --run [--out-dir <dir>] [--attempts <n>] [--candidates <ids>] [--problems <path>] [--max-tokens <n>]
  node scripts/fusion-local-rollout-demo.mjs --status [--out-dir <dir>]
  node scripts/fusion-local-rollout-demo.mjs --watch [--out-dir <dir>]

Runs a small local Fusion rollout demo with durable JSONL events and a summary JSON.
This is meant for watching rollouts happen and trying the same problems multiple times before full AutomationBench.
`;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseList(value, fallback) {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : fallback;
}

function localGatewayCredentials() {
  const path = `${homedir()}/.understudy/credentials.json`;
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return {
      UNDERSTUDY_GATEWAY_BASE_URL: value.gateway_url,
      UNDERSTUDY_GATEWAY_API_KEY: value.api_key,
    };
  } catch {
    return {};
  }
}

function executionValue(value) {
  const match = String(value).match(/^\$([A-Z0-9_]+)(.*)$/);
  if (!match) return value;
  const envValue = process.env[match[1]] || localGatewayCredentials()[match[1]];
  if (!envValue) throw new Error(`${match[1]} is required to run ${value}`);
  return `${envValue}${match[2]}`;
}

function loadProblems(path) {
  if (!path) return DEFAULT_PROBLEMS;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("--problems must point to a JSON array");
  return parsed;
}

function nowIso() {
  return new Date().toISOString();
}

function runId() {
  return `fusion-demo-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z")}`;
}

function paths(outDir, id) {
  const dir = resolve(outDir, id);
  return {
    dir,
    events: resolve(dir, "events.jsonl"),
    summary: resolve(dir, "summary.json"),
    results: resolve(dir, "results.jsonl"),
  };
}

function appendJsonl(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw
    .split(/\n+/)
    .map((line) => JSON.parse(line));
}

function scoreAnswer(answer, problem) {
  const lower = answer.toLowerCase();
  const hits = (problem.rubric ?? []).filter((item) =>
    String(item)
      .toLowerCase()
      .split(/\s+/)
      .some((term) => term.length > 4 && lower.includes(term)),
  );
  const score = problem.rubric?.length ? hits.length / problem.rubric.length : null;
  return {
    score,
    notes: problem.rubric?.length ? `rubric_hits=${hits.length}/${problem.rubric.length}` : "no_rubric",
  };
}

async function callCandidate(candidate, problem, attempt, maxTokens) {
  const started = Date.now();
  const baseUrl = executionValue(candidate.baseUrl).replace(/\/$/, "");
  const apiKey = executionValue(candidate.apiKey);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey && apiKey !== "local" ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: candidate.model,
      messages: [
        {
          role: "system",
          content:
            "You are running a local Fusion rollout demo. Answer concisely. Preserve final judgment with the main agent and use sidekick only as bounded advisory context.",
        },
        {
          role: "user",
          content: problem.prompt,
        },
      ],
      temperature: 0.2 + (attempt % 3) * 0.1,
      max_tokens: maxTokens,
      stream: false,
    }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  const message = payload.choices?.[0]?.message ?? {};
  const content =
    message.content ??
    message.reasoning_content ??
    message.reasoning ??
    payload.choices?.[0]?.text ??
    "";
  if (!String(content).trim()) {
    throw new Error(`empty model response: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return {
    answer: String(content),
    elapsed_ms: Date.now() - started,
    prompt_tokens: payload.usage?.prompt_tokens ?? null,
    completion_tokens: payload.usage?.completion_tokens ?? null,
  };
}

function summarize(results) {
  const byCandidate = new Map();
  for (const result of results) {
    const current = byCandidate.get(result.candidate) ?? {
      candidate: result.candidate,
      rows: 0,
      ok_rows: 0,
      error_rows: 0,
      elapsed_ms: 0,
      score_rows: 0,
      score: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
    };
    current.rows += 1;
    current.ok_rows += result.status === "ok" ? 1 : 0;
    current.error_rows += result.status === "error" ? 1 : 0;
    current.elapsed_ms += Number(result.elapsed_ms ?? 0);
    current.prompt_tokens += Number(result.prompt_tokens ?? 0);
    current.completion_tokens += Number(result.completion_tokens ?? 0);
    if (typeof result.score === "number") {
      current.score_rows += 1;
      current.score += result.score;
    }
    byCandidate.set(result.candidate, current);
  }
  return [...byCandidate.values()].map((row) => ({
    candidate: row.candidate,
    rows: row.rows,
    ok_rows: row.ok_rows,
    error_rows: row.error_rows,
    avg_elapsed_ms: row.rows ? Math.round(row.elapsed_ms / row.rows) : null,
    avg_score: row.score_rows ? row.score / row.score_rows : null,
    avg_prompt_tokens: row.rows ? Math.round(row.prompt_tokens / row.rows) : null,
    avg_completion_tokens: row.rows ? Math.round(row.completion_tokens / row.rows) : null,
  }));
}

function writeSummary(path, meta, results) {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schema_version: "understudy.fusion_local_rollout_demo_summary.v1",
        ...meta,
        updated_at: nowIso(),
        rows: results.length,
        summary: summarize(results),
      },
      null,
      2,
    )}\n`,
  );
}

async function runDemo(args) {
  const id = argValue(args, "--run-id") ?? runId();
  const outDir = argValue(args, "--out-dir") ?? DEFAULT_OUT_DIR;
  const attempts = Number(argValue(args, "--attempts") ?? 2);
  const maxTokens = Number(argValue(args, "--max-tokens") ?? 700);
  const candidateIds = parseList(argValue(args, "--candidates"), ["local-main", "local-fast"]);
  const problems = loadProblems(argValue(args, "--problems"));
  const selectedCandidates = candidateIds.map((id) => {
    const candidate = CANDIDATES[id];
    if (!candidate) throw new Error(`unknown candidate: ${id}`);
    return { id, ...candidate };
  });
  const p = paths(outDir, id);
  mkdirSync(p.dir, { recursive: true });
  const meta = {
    run_id: id,
    out_dir: p.dir,
    candidates: candidateIds,
    problem_ids: problems.map((problem) => problem.id),
    attempts,
  };
  appendJsonl(p.events, {
    schema_version: "understudy.fusion_local_rollout_demo_event.v1",
    type: "run_started",
    at: nowIso(),
    ...meta,
  });
  const results = readJsonl(p.results);
  writeSummary(p.summary, meta, results);
  for (const problem of problems) {
    for (const candidate of selectedCandidates) {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const rowId = `${problem.id}:${candidate.id}:${attempt}`;
        if (results.some((row) => row.row_id === rowId && row.status === "ok")) continue;
        appendJsonl(p.events, {
          schema_version: "understudy.fusion_local_rollout_demo_event.v1",
          type: "rollout_started",
          at: nowIso(),
          run_id: id,
          row_id: rowId,
          problem_id: problem.id,
          candidate: candidate.id,
          attempt,
        });
        try {
          const output = await callCandidate(candidate, problem, attempt, maxTokens);
          const scored = scoreAnswer(output.answer, problem);
          const row = {
            schema_version: "understudy.fusion_local_rollout_demo_result.v1",
            run_id: id,
            row_id: rowId,
            problem_id: problem.id,
            category: problem.category ?? "unknown",
            candidate: candidate.id,
            route: candidate.route,
            model: candidate.model,
            attempt,
            status: "ok",
            ...output,
            ...scored,
            created_at: nowIso(),
          };
          results.push(row);
          appendJsonl(p.results, row);
          appendJsonl(p.events, {
            schema_version: "understudy.fusion_local_rollout_demo_event.v1",
            type: "rollout_finished",
            at: nowIso(),
            run_id: id,
            row_id: rowId,
            status: "ok",
            elapsed_ms: row.elapsed_ms,
            score: row.score,
          });
        } catch (error) {
          const row = {
            schema_version: "understudy.fusion_local_rollout_demo_result.v1",
            run_id: id,
            row_id: rowId,
            problem_id: problem.id,
            category: problem.category ?? "unknown",
            candidate: candidate.id,
            route: candidate.route,
            model: candidate.model,
            attempt,
            status: "error",
            error: error.message,
            created_at: nowIso(),
          };
          results.push(row);
          appendJsonl(p.results, row);
          appendJsonl(p.events, {
            schema_version: "understudy.fusion_local_rollout_demo_event.v1",
            type: "rollout_finished",
            at: nowIso(),
            run_id: id,
            row_id: rowId,
            status: "error",
            error: error.message,
          });
        }
        writeSummary(p.summary, meta, results);
        console.log(`${rowId} -> ${results.at(-1).status}`);
      }
    }
  }
  appendJsonl(p.events, {
    schema_version: "understudy.fusion_local_rollout_demo_event.v1",
    type: "run_finished",
    at: nowIso(),
    run_id: id,
    rows: results.length,
  });
  writeSummary(p.summary, meta, results);
  console.log(p.summary);
}

function latestRunDir(outDir) {
  const dir = resolve(outDir);
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .map((name) => resolve(dir, name))
    .filter((path) => statSync(path).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function status(args) {
  const outDir = argValue(args, "--out-dir") ?? DEFAULT_OUT_DIR;
  const explicitRunId = argValue(args, "--run-id");
  const dir = explicitRunId ? resolve(outDir, explicitRunId) : latestRunDir(outDir);
  if (!dir) {
    console.log("No local Fusion demo runs yet.");
    return;
  }
  const summaryPath = resolve(dir, "summary.json");
  const eventsPath = resolve(dir, "events.jsonl");
  if (!existsSync(summaryPath)) {
    console.log(`No summary found in ${dir}`);
    return;
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const events = readJsonl(eventsPath).slice(-8);
  console.log(`run: ${summary.run_id}`);
  console.log(`rows: ${summary.rows}`);
  for (const row of summary.summary ?? []) {
    console.log(
      `${row.candidate}: rows=${row.rows} ok=${row.ok_rows} error=${row.error_rows} avg_ms=${row.avg_elapsed_ms} avg_score=${row.avg_score}`,
    );
  }
  console.log(`summary: ${summaryPath}`);
  console.log(`recent_events:`);
  for (const event of events) console.log(`  ${event.at} ${event.type} ${event.row_id ?? ""} ${event.status ?? ""}`);
}

async function watch(args) {
  const intervalMs = Number(argValue(args, "--interval-ms") ?? 1500);
  while (true) {
    console.clear();
    status(args);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log(usage());
    return;
  }
  if (args.includes("--run")) {
    await runDemo(args);
  } else if (args.includes("--status")) {
    status(args);
  } else if (args.includes("--watch")) {
    await watch(args);
  } else {
    throw new Error("choose --run, --status, or --watch");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
