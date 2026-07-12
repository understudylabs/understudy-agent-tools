#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    const row = usage[role] ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    row.input_tokens += Number(event.data?.input_tokens ?? 0);
    row.output_tokens += Number(event.data?.output_tokens ?? 0);
    row.total_tokens += Number(event.data?.total_tokens ?? 0);
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

function parseArgs(argv) {
  const options = {
    studentSlot: 9,
    teacherSlot: 5,
    maxTokens: 384,
    outputRoot: join(homedir(), ".understudy", "proofs", "grocery-marketplace"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--student-slot") options.studentSlot = Number(next);
    else if (value === "--teacher-slot") options.teacherSlot = Number(next);
    else if (value === "--max-tokens") options.maxTokens = Number(next);
    else if (value === "--output-root") options.outputRoot = resolve(next);
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
  const rows = [];
  for (const mode of modes) {
    for (const task of tasks) {
      const runId = `${proofId}-${mode.id}-${task.id}`;
      const sessionId = `${proofId}-${mode.id}`;
      const before = performance.now();
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
      const events = await readNdjson(response);
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
      const row = {
        proof_id: proofId,
        suite_sha256: suiteHash,
        run_id: runId,
        session_id: sessionId,
        task_id: task.id,
        task_title: task.title,
        mode: mode.id,
        student_slot_id: options.studentSlot,
        teacher_slot_id: options.teacherSlot,
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
    format: "understudy.desktop_grocery_proof.v1",
    proof_id: proofId,
    suite_sha256: suiteHash,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    api_version: capabilities.api_version,
    event_schema: capabilities.event_schema,
    task_count: tasks.length,
    run_count: rows.length,
    slots: { student: options.studentSlot, teacher: options.teacherSlot },
    by_mode: byMode,
  };
  writeProofFile(
    join(outputDir, "results.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  writeProofFile(join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeProofFile(join(outputDir, "tasks.json"), tasksBytes);
  process.stdout.write(`${JSON.stringify({ output_dir: outputDir, summary }, null, 2)}\n`);
  return { outputDir, summary, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProof().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
