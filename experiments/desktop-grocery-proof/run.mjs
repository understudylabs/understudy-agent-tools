#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateRuntimeTrace } from "../../dist/runtime/conversation/contract.js";
import { runPiConversation } from "../../dist/runtime/conversation/pi-runtime.js";
import { renderExistingProof, writeBuyerReport } from "./report.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function extractJsonObject(text) {
  const trimmed = text.trim();
  for (const candidate of [trimmed, trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Try the bounded object projection next.
    }
  }
  return null;
}

export function scoreObject(actual, expected) {
  const entries = Object.entries(expected);
  const matches = actual
    ? entries.filter(([key, value]) => Object.is(actual[key], value)).length
    : 0;
  return {
    exact: matches === entries.length && Object.keys(actual ?? {}).length === entries.length,
    matched_fields: matches,
    total_fields: entries.length,
    field_accuracy: matches / entries.length,
  };
}

export function summarizeEvents(events, elapsedMs) {
  const outputByRole = {};
  let output = "";
  for (const event of events) {
    if (event.event === "teacher_continuation" && event.data?.output_mode === "replace") {
      output = "";
      continue;
    }
    if (event.event !== "delta" || typeof event.data?.text !== "string") continue;
    const role = String(event.data?.role ?? "unknown");
    outputByRole[role] = `${outputByRole[role] ?? ""}${event.data.text}`;
    output += event.data.text;
  }
  const usage = {};
  for (const event of events.filter((event) => event.event === "usage")) {
    const role = String(event.data?.role ?? "unknown");
    const row = usage[role] ?? {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      complete: true,
      source: "provider",
    };
    row.input_tokens += Number(event.data?.input_tokens ?? 0);
    row.output_tokens += Number(event.data?.output_tokens ?? 0);
    row.total_tokens += Number(event.data?.total_tokens ?? 0);
    row.complete = row.complete && event.data?.complete === true;
    if (event.data?.source !== "provider") row.source = String(event.data?.source ?? "unavailable");
    usage[role] = row;
  }
  const studentOutput = usage.student?.output_tokens ?? 0;
  const teacherOutput = usage.teacher?.output_tokens ?? 0;
  const answerOutput = studentOutput + teacherOutput;
  const answerTokens = (usage.student?.total_tokens ?? 0) + (usage.teacher?.total_tokens ?? 0);
  const supervisorTokens = usage.supervisor?.total_tokens ?? 0;
  return {
    output,
    output_by_role: outputByRole,
    elapsed_ms: elapsedMs,
    usage,
    verdicts: events
      .filter((event) => event.event === "supervisor_verdict")
      .map((event) => event.data),
    student_interruptions: events.filter((event) => event.event === "student_interruption").length,
    teacher_continuations: events.filter((event) => event.event === "teacher_continuation").length,
    small_model_output_share: answerOutput > 0 ? studentOutput / answerOutput : null,
    supervisor_token_overhead: answerTokens > 0 ? supervisorTokens / answerTokens : null,
    canonical_event_count: events.length,
  };
}

function isRemoteUrl(value) {
  const { hostname } = new URL(value);
  return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
}

function priceTokens(inputTokens, outputTokens, inputUsdPerMillion, outputUsdPerMillion) {
  return ((inputTokens * inputUsdPerMillion) + (outputTokens * outputUsdPerMillion)) / 1_000_000;
}

export function incumbentBudgetPreflight(tasks, options) {
  const inputTokens = tasks.reduce(
    (sum, task) => sum + Math.ceil([...task.prompt].length / 4) + 2_048,
    0,
  );
  const outputTokens = tasks.length * options.maxTokens;
  const estimatedMaxCostUsd = priceTokens(
    inputTokens,
    outputTokens,
    options.incumbentInputUsdPerMillion,
    options.incumbentOutputUsdPerMillion,
  );
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_max_cost_usd: estimatedMaxCostUsd,
    budget_usd: options.budgetUsd,
    within_budget: estimatedMaxCostUsd <= options.budgetUsd,
    basis: "prompt chars / 4 + 2048 input-token overhead per task; max output tokens",
  };
}

export async function runHostedIncumbent({ task, runId, sessionId, options }) {
  const { remote } = validateIncumbentOptions(options);
  const apiKey = options.incumbentApiKeyEnv
    ? process.env[options.incumbentApiKeyEnv]
    : undefined;
  if (remote && !options.confirmSpend) {
    throw new Error("remote incumbent comparison requires --confirm-spend");
  }
  if (remote && !apiKey) {
    throw new Error(`remote incumbent credential is missing from ${options.incumbentApiKeyEnv}`);
  }
  const previousRemote = process.env.UNDERSTUDY_RUNTIME_ALLOW_REMOTE;
  if (remote) process.env.UNDERSTUDY_RUNTIME_ALLOW_REMOTE = "1";
  const events = [];
  try {
    await runPiConversation(
      {
        run_id: runId,
        session_id: sessionId,
        base_url: options.incumbentBaseUrl,
        model: options.incumbentModel,
        provider_kind: options.incumbentProviderKind,
        provider_api_key: apiKey,
        role: "primary",
        messages: [{ role: "user", content: task.prompt }],
        max_output_tokens: options.maxTokens,
        max_tool_rounds: 0,
        allow_remote: remote,
        runtime_backend: "pi",
      },
      (event) => events.push(event),
    );
  } finally {
    if (previousRemote === undefined) delete process.env.UNDERSTUDY_RUNTIME_ALLOW_REMOTE;
    else process.env.UNDERSTUDY_RUNTIME_ALLOW_REMOTE = previousRemote;
  }
  validateRuntimeTrace(events);
  return events;
}

export function validateIncumbentOptions(options) {
  const incumbentEnabled = options.incumbentBaseUrl != null || options.incumbentModel != null;
  if (incumbentEnabled && (!options.incumbentBaseUrl || !options.incumbentModel)) {
    throw new Error("hosted incumbent comparison requires both --incumbent-base-url and --incumbent-model");
  }
  if (!["openai-compatible", "anthropic"].includes(options.incumbentProviderKind)) {
    throw new Error("incumbentProviderKind must be openai-compatible or anthropic");
  }
  if (options.incumbentApiKeyEnv && !/^[A-Z][A-Z0-9_]*$/.test(options.incumbentApiKeyEnv)) {
    throw new Error("incumbentApiKeyEnv must be an uppercase environment variable name");
  }
  if (incumbentEnabled && (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new Error("maxTokens must be a positive integer for an incumbent comparison");
  }
  const remote = incumbentEnabled && isRemoteUrl(options.incumbentBaseUrl);
  if (remote) {
    for (const [name, value] of Object.entries({
      incumbentInputUsdPerMillion: options.incumbentInputUsdPerMillion,
      incumbentOutputUsdPerMillion: options.incumbentOutputUsdPerMillion,
    })) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative number for a remote incumbent`);
      }
    }
    if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) {
      throw new Error("budgetUsd must be positive for a remote incumbent");
    }
    if (!options.incumbentApiKeyEnv) {
      throw new Error("remote incumbent comparison requires --incumbent-api-key-env");
    }
    if (!options.confirmSpend) {
      throw new Error("remote incumbent comparison requires --confirm-spend");
    }
  }
  return { incumbentEnabled, remote };
}

function parseArgs(argv) {
  const options = {
    studentSlot: 9,
    teacherSlot: 5,
    maxTokens: 384,
    outputRoot: join(homedir(), ".understudy", "proofs", "grocery-marketplace"),
    reportFrom: null,
    reportOutputRoot: null,
    incumbentBaseUrl: null,
    incumbentModel: null,
    incumbentProviderKind: "openai-compatible",
    incumbentApiKeyEnv: null,
    incumbentInputUsdPerMillion: null,
    incumbentOutputUsdPerMillion: null,
    budgetUsd: null,
    confirmSpend: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--confirm-spend") {
      options.confirmSpend = true;
      continue;
    }
    if (value === "--student-slot") options.studentSlot = Number(next);
    else if (value === "--teacher-slot") options.teacherSlot = Number(next);
    else if (value === "--max-tokens") options.maxTokens = Number(next);
    else if (value === "--output-root") options.outputRoot = resolve(next);
    else if (value === "--report-from") options.reportFrom = resolve(next);
    else if (value === "--report-output-root") options.reportOutputRoot = resolve(next);
    else if (value === "--incumbent-base-url") options.incumbentBaseUrl = next;
    else if (value === "--incumbent-model") options.incumbentModel = next;
    else if (value === "--incumbent-provider-kind") options.incumbentProviderKind = next;
    else if (value === "--incumbent-api-key-env") options.incumbentApiKeyEnv = next;
    else if (value === "--incumbent-input-usd-per-million") {
      options.incumbentInputUsdPerMillion = Number(next);
    } else if (value === "--incumbent-output-usd-per-million") {
      options.incumbentOutputUsdPerMillion = Number(next);
    } else if (value === "--budget-usd") options.budgetUsd = Number(next);
    else throw new Error(`unknown argument: ${value}`);
    index += 1;
  }
  for (const [name, value] of Object.entries({
    studentSlot: options.studentSlot,
    teacherSlot: options.teacherSlot,
    maxTokens: options.maxTokens,
  })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  if (options.studentSlot === options.teacherSlot) {
    throw new Error("student and teacher slots must be distinct");
  }
  if (options.reportOutputRoot && !options.reportFrom) {
    throw new Error("--report-output-root requires --report-from");
  }
  validateIncumbentOptions(options);
  return options;
}

function readCapability() {
  const path = process.env.UNDERSTUDY_DESKTOP_API_FILE
    ?? join(homedir(), ".understudy", "desktop-api.json");
  const metadata = statSync(path);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`desktop capability permissions are broader than 0600: ${path}`);
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  const url = new URL(value.base_url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("desktop capability is not a loopback HTTP endpoint");
  }
  if (typeof value.token !== "string" || value.token.length < 32) {
    throw new Error("desktop capability has no valid bearer token");
  }
  return { baseUrl: url.origin, token: value.token };
}

async function apiFetch(capability, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${capability.token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(new URL(path, capability.baseUrl), { ...init, headers });
}

async function readNdjson(response) {
  if (!response.body) return [];
  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) events.push(JSON.parse(line));
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) events.push(JSON.parse(buffer));
  return events;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function writeProofFile(path, data) {
  writeFileSync(path, data, { flag: "wx", mode: 0o600 });
}

export async function runProof(options = parseArgs(process.argv.slice(2))) {
  const tasksBytes = readFileSync(join(here, "tasks.json"));
  const tasks = JSON.parse(tasksBytes);
  const suiteHash = createHash("sha256").update(tasksBytes).digest("hex");
  const {
    incumbentEnabled,
    remote: incumbentRemote,
  } = validateIncumbentOptions(options);
  const incumbentBudget = incumbentEnabled && incumbentRemote
    ? incumbentBudgetPreflight(tasks, options)
    : null;
  if (incumbentBudget && !incumbentBudget.within_budget) {
    throw new Error(
      `incumbent worst-case cost $${incumbentBudget.estimated_max_cost_usd.toFixed(6)} exceeds budget $${options.budgetUsd.toFixed(6)}`,
    );
  }
  const startedAt = new Date();
  const proofId = `grocery-${suiteHash.slice(0, 10)}-${startedAt.toISOString().replaceAll(/[-:.]/g, "")}`;
  const outputDir = join(options.outputRoot, proofId);
  mkdirSync(options.outputRoot, { recursive: true, mode: 0o700 });
  mkdirSync(outputDir, { mode: 0o700 });
  const capability = readCapability();
  const capabilitiesResponse = await apiFetch(capability, "/v1/capabilities");
  if (!capabilitiesResponse.ok) throw new Error(`capabilities returned ${capabilitiesResponse.status}`);
  const capabilities = await capabilitiesResponse.json();
  const [apiMajor, apiMinor] = String(capabilities.api_version ?? "0.0")
    .split(".")
    .map(Number);
  if (
    capabilities.schema_version !== "understudy.desktop_api.v2"
    || apiMajor !== 2
    || apiMinor < 1
    || capabilities.features?.local_supervision !== true
  ) {
    throw new Error("Understudy Desktop 2.1.0 local supervision API is required");
  }

  const modes = [
    { id: "small", slotId: options.studentSlot },
    { id: "main", slotId: options.teacherSlot },
    {
      id: "supervised",
      slotId: options.studentSlot,
      supervisorSlotId: options.teacherSlot,
    },
  ];
  if (incumbentEnabled) modes.push({ id: "hosted" });
  const rows = [];
  let hostedCostUsd = 0;
  for (const mode of modes) {
    for (const task of tasks) {
      const runId = `${proofId}-${mode.id}-${task.id}`;
      const sessionId = `${proofId}-${mode.id}`;
      const before = performance.now();
      let events;
      if (mode.id === "hosted") {
        events = await runHostedIncumbent({ task, runId, sessionId, options });
      } else {
        const response = await apiFetch(
          capability,
          `/v1/conversations/${encodeURIComponent(sessionId)}/turns`,
          {
            method: "POST",
            body: JSON.stringify({
              slotId: mode.slotId,
              supervisorSlotId: mode.supervisorSlotId,
              text: task.prompt,
              runId,
              maxTokens: options.maxTokens,
            }),
          },
        );
        if (!response.ok) {
          throw new Error(`${mode.id}/${task.id} returned ${response.status}: ${await response.text()}`);
        }
        events = await readNdjson(response);
      }
      const evidence = summarizeEvents(events, Math.round(performance.now() - before));
      const parsed = extractJsonObject(evidence.output);
      const score = scoreObject(parsed, task.expected);
      const studentParsed = mode.id === "supervised"
        ? extractJsonObject(evidence.output_by_role.student ?? "")
        : null;
      const studentScore = mode.id === "supervised"
        ? scoreObject(studentParsed, task.expected)
        : null;
      const intervened = evidence.verdicts.some(
        (verdict) => verdict.verdict === "nudge" || verdict.verdict === "interrupt",
      );
      const hostedUsage = mode.id === "hosted" ? evidence.usage.primary : null;
      if (
        mode.id === "hosted"
        && incumbentRemote
        && (hostedUsage?.complete !== true || hostedUsage.source !== "provider")
      ) {
        throw new Error(
          `hosted/${task.id} did not report complete provider usage; cannot enforce spend or report cost`,
        );
      }
      const costUsd = mode.id === "hosted" && hostedUsage?.complete === true
        ? priceTokens(
          hostedUsage.input_tokens,
          hostedUsage.output_tokens,
          options.incumbentInputUsdPerMillion ?? 0,
          options.incumbentOutputUsdPerMillion ?? 0,
        )
        : null;
      if (mode.id === "hosted" && incumbentRemote) {
        hostedCostUsd += costUsd;
        if (hostedCostUsd > options.budgetUsd) {
          throw new Error(
            `hosted incumbent reported cost $${hostedCostUsd.toFixed(6)} exceeds budget $${options.budgetUsd.toFixed(6)}`,
          );
        }
      }
      const row = {
        proof_id: proofId,
        suite_sha256: suiteHash,
        run_id: runId,
        session_id: sessionId,
        task_id: task.id,
        task_title: task.title,
        mode: mode.id,
        student_slot_id: mode.id === "hosted" ? null : options.studentSlot,
        teacher_slot_id: mode.id === "hosted" ? null : options.teacherSlot,
        model: mode.id === "hosted" ? options.incumbentModel : null,
        parsed_output: parsed,
        score,
        student_parsed_output: studentParsed,
        student_score: studentScore,
        supervisor_intervened: mode.id === "supervised" ? intervened : null,
        supervisor_missed_error: mode.id === "supervised"
          ? !intervened && !studentScore.exact
          : null,
        supervisor_false_positive: mode.id === "supervised"
          ? intervened && studentScore.exact
          : null,
        supervisor_correct_intervention: mode.id === "supervised"
          ? intervened && !studentScore.exact && score.exact
          : null,
        cost_usd: costUsd,
        cost_basis: mode.id === "hosted" && incumbentRemote
          ? "provider usage × user-supplied token prices"
          : null,
        ...evidence,
      };
      rows.push(row);
      writeProofFile(
        join(outputDir, `${mode.id}-${task.id}.events.jsonl`),
        `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      process.stdout.write(
        `${mode.id.padEnd(10)} ${task.id.padEnd(20)} accuracy=${score.field_accuracy.toFixed(2)} `
        + `latency=${evidence.elapsed_ms}ms verdicts=${evidence.verdicts.length}\n`,
      );
    }
  }

  const byMode = Object.fromEntries(modes.map((mode) => {
    const selected = rows.filter((row) => row.mode === mode.id);
    const tokens = selected.reduce((sum, row) => sum + Object.values(row.usage)
      .reduce((inner, usage) => inner + usage.total_tokens, 0), 0);
    return [mode.id, {
      exact_passes: selected.filter((row) => row.score.exact).length,
      task_count: selected.length,
      mean_field_accuracy: mean(selected.map((row) => row.score.field_accuracy)),
      mean_latency_ms: Math.round(mean(selected.map((row) => row.elapsed_ms))),
      total_tokens: tokens,
      cost_usd: mode.id === "hosted"
        && selected.every((row) => typeof row.cost_usd === "number")
        ? selected.reduce((sum, row) => sum + row.cost_usd, 0)
        : null,
      interventions: selected.filter((row) => row.supervisor_intervened).length,
      student_interruptions: selected.reduce((sum, row) => sum + row.student_interruptions, 0),
      supervisor_verdicts: selected.reduce((sum, row) => sum + row.verdicts.length, 0),
      supervisor_missed_errors: selected.filter((row) => row.supervisor_missed_error).length,
      supervisor_false_positives: selected.filter((row) => row.supervisor_false_positive).length,
      supervisor_correct_interventions: selected.filter(
        (row) => row.supervisor_correct_intervention,
      ).length,
      mean_small_model_output_share: mode.id === "supervised"
        ? mean(selected.map((row) => row.small_model_output_share ?? 0))
        : null,
      mean_supervisor_token_overhead: mode.id === "supervised"
        ? mean(selected.map((row) => row.supervisor_token_overhead ?? 0))
        : null,
    }];
  }));
  byMode.small.latency_reduction_vs_main = 1 - (byMode.small.mean_latency_ms / byMode.main.mean_latency_ms);
  byMode.supervised.latency_reduction_vs_main = 1
    - (byMode.supervised.mean_latency_ms / byMode.main.mean_latency_ms);
  byMode.small.quality_delta_vs_main = byMode.small.mean_field_accuracy
    - byMode.main.mean_field_accuracy;
  byMode.supervised.quality_delta_vs_main = byMode.supervised.mean_field_accuracy
    - byMode.main.mean_field_accuracy;
  const summary = {
    format: "understudy.desktop_grocery_proof.v2",
    proof_id: proofId,
    suite_sha256: suiteHash,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    api_version: capabilities.api_version,
    event_schema: capabilities.event_schema,
    task_count: tasks.length,
    run_count: rows.length,
    slots: { student: options.studentSlot, teacher: options.teacherSlot },
    incumbent: incumbentEnabled ? {
      model: options.incumbentModel,
      provider_kind: options.incumbentProviderKind,
      remote: incumbentRemote,
      base_url_sha256: createHash("sha256").update(options.incumbentBaseUrl).digest("hex"),
      input_usd_per_million: options.incumbentInputUsdPerMillion,
      output_usd_per_million: options.incumbentOutputUsdPerMillion,
      budget: incumbentBudget,
    } : null,
    report_file: "report.html",
    report_model_file: "report.json",
    by_mode: byMode,
  };
  writeProofFile(
    join(outputDir, "results.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  writeProofFile(join(outputDir, "tasks.json"), tasksBytes);
  const report = writeBuyerReport(outputDir, summary, rows, tasks);
  // Publish the immutable summary last so its report references cannot dangle
  // if report validation or writing fails.
  writeProofFile(join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output_dir: outputDir, summary }, null, 2)}\n`);
  return { outputDir, summary, rows, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const operation = options.reportFrom
    ? Promise.resolve().then(() => renderExistingProof(options.reportFrom, {
      outputRoot: options.reportOutputRoot ?? undefined,
    }))
    : runProof(options);
  operation.then((result) => {
    if (options.reportFrom) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
