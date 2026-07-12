#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));

export function scoreToolTrace(events, task) {
  const calls = events.filter((event) => event.event === "tool_call");
  const results = events.filter((event) => event.event === "tool_result");
  const call = calls[0]?.data ?? null;
  const result = results.find((event) => event.data?.call_id === call?.call_id)?.data ?? null;
  const output = events
    .filter((event) => event.event === "delta" && typeof event.data?.text === "string")
    .map((event) => event.data.text)
    .join("")
    .trim();
  const checks = {
    exactly_one_call: calls.length === 1,
    exact_tool_name: call?.name === task.tool,
    exact_arguments:
      call?.parse_error == null && isDeepStrictEqual(call?.parsed_arguments, task.arguments),
    paired_successful_result:
      results.length === 1 && result?.name === task.tool && result?.ok === true,
    exact_output: output === task.expected_output,
  };
  return {
    strict_pass: Object.values(checks).every(Boolean),
    checks,
    output,
    call_count: calls.length,
    result_count: results.length,
    called_tool: call?.name ?? null,
    parsed_arguments: call?.parsed_arguments ?? null,
    parse_error: call?.parse_error ?? null,
    result_ok: result?.ok ?? false,
    orphan_result_count: results.filter(
      (candidate) => !calls.some((item) => item.data?.call_id === candidate.data?.call_id),
    ).length,
  };
}

export function summarizeRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const selected = groups.get(row.candidate) ?? [];
    selected.push(row);
    groups.set(row.candidate, selected);
  }
  return Object.fromEntries([...groups].map(([candidate, selected]) => [candidate, {
    slot_id: selected[0]?.slot_id ?? null,
    strict_passes: selected.filter((row) => row.strict_pass).length,
    attempts: selected.length,
    strict_accuracy: selected.filter((row) => row.strict_pass).length / selected.length,
    exact_name_rate: selected.filter((row) => row.checks.exact_tool_name).length / selected.length,
    exact_arguments_rate: selected.filter((row) => row.checks.exact_arguments).length / selected.length,
    successful_result_rate:
      selected.filter((row) => row.checks.paired_successful_result).length / selected.length,
    exact_output_rate: selected.filter((row) => row.checks.exact_output).length / selected.length,
    parse_errors: selected.filter((row) => row.parse_error != null).length,
    orphan_results: selected.reduce((sum, row) => sum + row.orphan_result_count, 0),
    mean_latency_ms: Math.round(
      selected.reduce((sum, row) => sum + row.elapsed_ms, 0) / selected.length,
    ),
    total_tokens: selected.reduce((sum, row) => sum + row.total_tokens, 0),
    failures: selected
      .filter((row) => !row.strict_pass)
      .map((row) => ({
        repetition: row.repetition,
        task_id: row.task_id,
        called_tool: row.called_tool,
        parsed_arguments: row.parsed_arguments,
        result_ok: row.result_ok,
        output: row.output,
        checks: row.checks,
      })),
  }]));
}

function parseArgs(argv) {
  const options = {
    candidates: [],
    repetitions: 3,
    maxTokens: 160,
    outputRoot: join(homedir(), ".understudy", "proofs", "tool-correctness"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--candidate") {
      const [label, rawSlot] = String(next).split(":");
      options.candidates.push({ label, slotId: Number(rawSlot) });
    } else if (value === "--repetitions") options.repetitions = Number(next);
    else if (value === "--max-tokens") options.maxTokens = Number(next);
    else if (value === "--output-root") options.outputRoot = resolve(next);
    else throw new Error(`unknown argument: ${value}`);
    index += 1;
  }
  if (options.candidates.length === 0) {
    throw new Error("provide at least one --candidate label:slot");
  }
  const labels = new Set();
  for (const candidate of options.candidates) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(candidate.label) || labels.has(candidate.label)) {
      throw new Error(`candidate label must be unique and URL-safe: ${candidate.label}`);
    }
    if (!Number.isInteger(candidate.slotId) || candidate.slotId <= 0) {
      throw new Error(`candidate slot must be a positive integer: ${candidate.slotId}`);
    }
    labels.add(candidate.label);
  }
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 20) {
    throw new Error("repetitions must be an integer from 1 to 20");
  }
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 16 || options.maxTokens > 2_048) {
    throw new Error("max-tokens must be an integer from 16 to 2048");
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

function writeProofFile(path, data) {
  writeFileSync(path, data, { flag: "wx", mode: 0o600 });
}

function eventTokens(events) {
  return events
    .filter((event) => event.event === "usage")
    .reduce((sum, event) => sum + Number(event.data?.total_tokens ?? 0), 0);
}

export async function runProof(options = parseArgs(process.argv.slice(2))) {
  const taskBytes = readFileSync(join(here, "tasks.json"));
  const tasks = JSON.parse(taskBytes);
  const suiteSha256 = createHash("sha256").update(taskBytes).digest("hex");
  const startedAt = new Date();
  const proofId = `tools-${suiteSha256.slice(0, 10)}-${startedAt.toISOString().replaceAll(/[-:.]/g, "")}`;
  const outputDir = join(options.outputRoot, proofId);
  mkdirSync(options.outputRoot, { recursive: true, mode: 0o700 });
  mkdirSync(outputDir, { mode: 0o700 });
  const capability = readCapability();
  const capabilitiesResponse = await apiFetch(capability, "/v1/capabilities");
  if (!capabilitiesResponse.ok) {
    throw new Error(`capabilities returned ${capabilitiesResponse.status}`);
  }
  const capabilities = await capabilitiesResponse.json();
  if (
    capabilities.schema_version !== "understudy.desktop_api.v2"
    || capabilities.features?.streaming_ndjson !== true
    || capabilities.features?.persisted_run_events !== true
  ) {
    throw new Error("Understudy Desktop API v2 canonical streaming evidence is required");
  }

  const rows = [];
  for (const candidate of options.candidates) {
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      for (const task of tasks) {
        const runId = `${proofId}-${candidate.label}-r${repetition}-${task.id}`;
        const sessionId = runId;
        const before = performance.now();
        const response = await apiFetch(
          capability,
          `/v1/conversations/${encodeURIComponent(sessionId)}/turns`,
          {
            method: "POST",
            body: JSON.stringify({
              slotId: candidate.slotId,
              text: task.prompt,
              runId,
              maxTokens: options.maxTokens,
            }),
          },
        );
        if (!response.ok) {
          throw new Error(
            `${candidate.label}/r${repetition}/${task.id} returned ${response.status}: ${await response.text()}`,
          );
        }
        const events = await readNdjson(response);
        const score = scoreToolTrace(events, task);
        const row = {
          proof_id: proofId,
          suite_sha256: suiteSha256,
          candidate: candidate.label,
          slot_id: candidate.slotId,
          repetition,
          task_id: task.id,
          expected_tool: task.tool,
          expected_arguments: task.arguments,
          run_id: runId,
          session_id: sessionId,
          elapsed_ms: Math.round(performance.now() - before),
          total_tokens: eventTokens(events),
          canonical_event_count: events.length,
          ...score,
        };
        rows.push(row);
        writeProofFile(
          join(outputDir, `${candidate.label}-r${repetition}-${task.id}.events.jsonl`),
          `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        );
        process.stdout.write(
          `${candidate.label.padEnd(10)} r${repetition} ${task.id.padEnd(22)} `
          + `${score.strict_pass ? "PASS" : "FAIL"} tool=${score.called_tool ?? "none"}\n`,
        );
      }
    }
  }
  const summary = {
    format: "understudy.desktop_tool_proof.v1",
    proof_id: proofId,
    suite_sha256: suiteSha256,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    api_version: capabilities.api_version,
    event_schema: capabilities.event_schema,
    task_count: tasks.length,
    repetitions: options.repetitions,
    run_count: rows.length,
    candidates: summarizeRows(rows),
  };
  writeProofFile(
    join(outputDir, "results.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  writeProofFile(join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeProofFile(join(outputDir, "tasks.json"), taskBytes);
  process.stdout.write(`${JSON.stringify({ output_dir: outputDir, summary }, null, 2)}\n`);
  return { outputDir, rows, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProof().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
