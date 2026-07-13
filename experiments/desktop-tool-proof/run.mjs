#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { validateRuntimeTrace } from "../../dist/runtime/conversation/contract.js";
import { runPiConversation } from "../../dist/runtime/conversation/pi-runtime.js";

const here = dirname(fileURLToPath(import.meta.url));

const suiteFiles = Object.freeze({
  core: "tasks.json",
  hard: "tasks-hard.json",
});

const directMcpToolNames = [
  "status",
  "residency",
  "list_models",
  "list_snapshot_models",
  "list_traces",
  "search_traces",
  "open_trace",
];

const directWrapperTools = [
  {
    name: "understudy_mcp_tool",
    description: "Call the local Understudy Desktop MCP tool surface.",
    input_schema: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          enum: ["knowledge_dossiers", "local_benchmarks", "ui_focus"],
        },
        arguments: { type: "object" },
      },
      required: ["tool_name"],
      additionalProperties: false,
    },
  },
  {
    name: "understudy_agent_tools",
    description: "Run a safe, read-only Understudy agent-tools CLI command.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: [
            "version",
            "spine",
            "platforms",
            "skills_list",
            "skills_search",
            "skills_inspect",
            "doctor",
            "models_pull_plan",
          ],
        },
        query: { type: "string" },
        name: { type: "string" },
        model_id: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

export function expectedCallsForTask(task) {
  if (Array.isArray(task.calls)) return task.calls;
  if (typeof task.tool === "string") {
    return [{ tool: task.tool, arguments: task.arguments ?? {} }];
  }
  return [];
}

export function selectTasks(tasks, taskIds = []) {
  if (taskIds.length === 0) return tasks;
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error("task-id values must be unique");
  }
  const selected = taskIds.map((taskId) => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`unknown task-id: ${taskId}`);
    return task;
  });
  return selected;
}

export function resolveSuiteFile(suite) {
  const filename = suiteFiles[suite];
  if (!filename) {
    throw new Error(`unknown suite: ${suite}; expected one of ${Object.keys(suiteFiles).join(", ")}`);
  }
  return filename;
}

export function residencyIsolationPlan(slots, targetSlotId) {
  const target = slots.find((slot) => slot.id === targetSlotId);
  if (!target) throw new Error(`candidate slot ${targetSlotId} does not exist`);
  const coolSlotIds = slots
    .filter((slot) => slot.id !== targetSlotId)
    .filter((slot) => slot.state === "running" || slot.state === "loading")
    .map((slot) => slot.id);
  const targetAction = target.state === "running"
    ? "ready"
    : target.state === "loading"
      ? "wait"
      : "warm";
  return { coolSlotIds, targetAction };
}

export function scoreToolTrace(events, task) {
  const calls = events.filter((event) => event.event === "tool_call");
  const results = events.filter((event) => event.event === "tool_result");
  const expectedCalls = expectedCallsForTask(task);
  const terminalError = events.find(
    (event) => event.event === "error" || event.event === "cancellation",
  );
  const callData = calls.map((event) => event.data ?? {});
  const matchedResults = callData.map((call) => (
    results.find((event) => event.data?.call_id === call.call_id)?.data ?? null
  ));
  const output = events
    .filter((event) => event.event === "delta" && typeof event.data?.text === "string")
    .map((event) => event.data.text)
    .join("")
    .trim();
  const exactCallCount = calls.length === expectedCalls.length;
  const checks = {
    terminal_error_free: terminalError == null,
    exact_call_count: exactCallCount,
    exact_tool_sequence: exactCallCount && expectedCalls.every(
      (expected, index) => callData[index]?.name === expected.tool,
    ),
    exact_arguments: exactCallCount && expectedCalls.every((expected, index) => (
      callData[index]?.parse_error == null
      && isDeepStrictEqual(callData[index]?.parsed_arguments, expected.arguments)
    )),
    paired_successful_results:
      results.length === expectedCalls.length
      && expectedCalls.every((expected, index) => (
        matchedResults[index]?.name === expected.tool && matchedResults[index]?.ok === true
      )),
    no_orphan_results: results.every(
      (result) => callData.some((call) => call.call_id === result.data?.call_id),
    ),
    exact_output: output === task.expected_output,
  };
  const parseErrors = callData
    .map((call) => call.parse_error)
    .filter((value) => value != null);
  return {
    strict_pass: Object.values(checks).every(Boolean),
    checks,
    output,
    call_count: calls.length,
    result_count: results.length,
    called_tool: callData[0]?.name ?? null,
    parsed_arguments: callData[0]?.parsed_arguments ?? null,
    call_sequence: callData.map((call) => ({
      tool: call.name ?? null,
      arguments: call.parsed_arguments ?? null,
      parse_error: call.parse_error ?? null,
    })),
    parse_error: parseErrors[0] ?? null,
    parse_error_count: parseErrors.length,
    result_ok: matchedResults.every((result) => result?.ok === true),
    terminal_error: terminalError?.data?.message
      ?? terminalError?.data?.reason
      ?? (terminalError ? terminalError.event : null),
    orphan_result_count: results.filter(
      (candidate) => !callData.some((call) => call.call_id === candidate.data?.call_id),
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
    model_id: selected[0]?.model_id ?? null,
    runtime_backend: selected[0]?.runtime_backend ?? null,
    strict_passes: selected.filter((row) => row.strict_pass).length,
    attempts: selected.length,
    strict_accuracy: selected.filter((row) => row.strict_pass).length / selected.length,
    exact_call_count_rate:
      selected.filter((row) => row.checks.exact_call_count).length / selected.length,
    exact_name_rate:
      selected.filter((row) => row.checks.exact_tool_sequence).length / selected.length,
    exact_arguments_rate: selected.filter((row) => row.checks.exact_arguments).length / selected.length,
    successful_result_rate:
      selected.filter((row) => row.checks.paired_successful_results).length / selected.length,
    exact_output_rate: selected.filter((row) => row.checks.exact_output).length / selected.length,
    parse_errors: selected.reduce((sum, row) => sum + row.parse_error_count, 0),
    terminal_errors: selected.filter((row) => row.terminal_error != null).length,
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
        call_sequence: row.call_sequence,
        result_ok: row.result_ok,
        terminal_error: row.terminal_error,
        output: row.output,
        checks: row.checks,
      })),
  }]));
}

export function directToolDefinitions(mcpTools) {
  const selected = directMcpToolNames.map((name) => {
    const tool = mcpTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Desktop MCP is missing required direct-proof tool: ${name}`);
    return {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.inputSchema ?? { type: "object", properties: {} },
    };
  });
  return [...selected, ...directWrapperTools];
}

export function resolveDirectCandidates(candidates, residency, agentCard) {
  const warmModels = agentCard?.app?.warm_models;
  if (!Array.isArray(warmModels)) {
    throw new Error("agent card does not contain warm model paths");
  }
  return candidates.map((candidate) => {
    const slot = residency?.slots?.find((row) => row.id === candidate.slotId);
    if (!slot || slot.state !== "running" || !Number.isInteger(slot.port)) {
      throw new Error(`candidate ${candidate.label} slot ${candidate.slotId} is not warm`);
    }
    const warm = warmModels.find(
      (row) => row.id === slot.model_id && row.port === slot.port,
    );
    if (!warm || typeof warm.model_path !== "string" || !warm.model_path) {
      throw new Error(`candidate ${candidate.label} has no attested warm model path`);
    }
    return {
      ...candidate,
      modelId: slot.model_id,
      modelPath: warm.model_path,
      baseUrl: `http://127.0.0.1:${slot.port}/v1`,
    };
  });
}

function parseArgs(argv) {
  const options = {
    candidates: [],
    repetitions: 3,
    maxTokens: 160,
    timeoutMs: 30_000,
    outputRoot: join(homedir(), ".understudy", "proofs", "tool-correctness"),
    executionMode: "direct-pi",
    taskIds: [],
    suite: "core",
    manageResidency: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--desktop-api") {
      options.executionMode = "desktop-api";
      continue;
    }
    if (value === "--direct-runtime") {
      options.executionMode = "direct-pi";
      continue;
    }
    if (value === "--prewarmed") {
      options.manageResidency = false;
      continue;
    }
    if (value === "--candidate") {
      const [label, rawSlot] = String(next).split(":");
      options.candidates.push({ label, slotId: Number(rawSlot) });
    } else if (value === "--repetitions") options.repetitions = Number(next);
    else if (value === "--max-tokens") options.maxTokens = Number(next);
    else if (value === "--timeout-ms") options.timeoutMs = Number(next);
    else if (value === "--task-id") options.taskIds.push(String(next));
    else if (value === "--suite") options.suite = String(next);
    else if (value === "--output-root") options.outputRoot = resolve(next);
    else throw new Error(`unknown argument: ${value}`);
    index += 1;
  }
  if (options.candidates.length === 0) {
    throw new Error("provide at least one --candidate label:slot");
  }
  const labels = new Set();
  const slots = new Set();
  for (const candidate of options.candidates) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(candidate.label) || labels.has(candidate.label)) {
      throw new Error(`candidate label must be unique and URL-safe: ${candidate.label}`);
    }
    if (!Number.isInteger(candidate.slotId) || candidate.slotId <= 0) {
      throw new Error(`candidate slot must be a positive integer: ${candidate.slotId}`);
    }
    if (slots.has(candidate.slotId)) {
      throw new Error(`candidate slots must be unique: ${candidate.slotId}`);
    }
    labels.add(candidate.label);
    slots.add(candidate.slotId);
  }
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 20) {
    throw new Error("repetitions must be an integer from 1 to 20");
  }
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 16 || options.maxTokens > 2_048) {
    throw new Error("max-tokens must be an integer from 16 to 2048");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 300_000) {
    throw new Error("timeout-ms must be an integer from 1000 to 300000");
  }
  resolveSuiteFile(options.suite);
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

function readAgentCard() {
  const path = process.env.UNDERSTUDY_AGENT_CARD_FILE
    ?? join(homedir(), ".understudy", "agent-card.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

async function mcpRequest(capability, method, params) {
  const response = await apiFetch(capability, "/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Desktop MCP ${method} returned ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`Desktop MCP ${method} failed: ${body.error.message}`);
  return body.result;
}

async function residencySnapshot(capability) {
  const result = await mcpRequest(capability, "tools/call", {
    name: "residency",
    arguments: {},
  });
  const snapshot = result?.structuredContent;
  if (!snapshot || !Array.isArray(snapshot.slots)) {
    throw new Error("Desktop residency returned no slot list");
  }
  return snapshot;
}

async function setSlotState(capability, toolName, slotId) {
  await mcpRequest(capability, "tools/call", {
    name: toolName,
    arguments: { slot_id: slotId },
  });
}

async function waitForSlot(capability, slotId, desiredState, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await residencySnapshot(capability);
    const slot = snapshot.slots.find((candidate) => candidate.id === slotId);
    if (!slot) throw new Error(`candidate slot ${slotId} disappeared during residency change`);
    if (slot.state === desiredState) return slot;
    if (slot.state === "error") throw new Error(`candidate slot ${slotId} entered error state`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`candidate slot ${slotId} did not reach ${desiredState} within ${timeoutMs}ms`);
}

async function waitForPortClosed(port, timeoutMs = 10_000) {
  if (!Number.isInteger(port)) return;
  const url = `http://127.0.0.1:${port}/v1/models`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`model server port ${port} stayed open after slot cooling`);
}

async function coolSlotAndVerify(capability, slotId) {
  const before = await residencySnapshot(capability);
  const port = before.slots.find((slot) => slot.id === slotId)?.port;
  await setSlotState(capability, "cool_slot", slotId);
  await waitForSlot(capability, slotId, "stopped", 10_000);
  await waitForPortClosed(port);
}

async function isolateCandidate(capability, slotId) {
  const before = await residencySnapshot(capability);
  const plan = residencyIsolationPlan(before.slots, slotId);
  for (const victim of plan.coolSlotIds) {
    await coolSlotAndVerify(capability, victim);
  }
  if (plan.coolSlotIds.length > 0) {
    // Metal/IOGPU teardown can outlive process exit. Keep the next model load
    // out of the allocator completion window that triggered the kernel panic.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  if (plan.targetAction === "warm") {
    await setSlotState(capability, "warm_slot", slotId);
  }
  if (plan.targetAction !== "ready") {
    await waitForSlot(capability, slotId, "running");
  }
}

async function restoreResidency(capability, originalRunningSlotIds) {
  const current = await residencySnapshot(capability);
  for (const slot of current.slots) {
    if (
      (slot.state === "running" || slot.state === "loading")
      && !originalRunningSlotIds.includes(slot.id)
    ) {
      await coolSlotAndVerify(capability, slot.id);
    }
  }
  for (const slotId of originalRunningSlotIds) {
    const snapshot = await residencySnapshot(capability);
    const slot = snapshot.slots.find((candidate) => candidate.id === slotId);
    if (!slot || slot.state === "running") continue;
    if (slot.state !== "loading") await setSlotState(capability, "warm_slot", slotId);
    await waitForSlot(capability, slotId, "running");
  }
}

function modelSystemPrompt(modelId) {
  const cards = JSON.parse(readFileSync(
    resolve(here, "../../apps/homescreen/src-tauri/knowledge/model_cards.json"),
    "utf8",
  ));
  const card = cards.find((candidate) => candidate.id === modelId);
  const targetId = card?.alias_for ?? modelId;
  return cards.find((candidate) => candidate.id === targetId)?.system_prompt
    ?? cards.find((candidate) => candidate.id === "default")?.system_prompt
    ?? "You are an AI assistant in the Understudy desktop app.";
}

async function loadDirectContext(capability, candidates) {
  const [toolResult, residencyResult] = await Promise.all([
    mcpRequest(capability, "tools/list", {}),
    mcpRequest(capability, "tools/call", { name: "residency", arguments: {} }),
  ]);
  const tools = directToolDefinitions(toolResult?.tools ?? []);
  const targets = resolveDirectCandidates(
    candidates,
    residencyResult?.structuredContent,
    readAgentCard(),
  );
  return {
    tools,
    targets: new Map(targets.map((target) => [target.label, target])),
    toolSchemaSha256: createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
  };
}

async function runDirectTurn(
  capability,
  context,
  candidate,
  task,
  runId,
  sessionId,
  maxTokens,
  timeoutMs,
) {
  const target = context.targets.get(candidate.label);
  if (!target) throw new Error(`direct target is missing for ${candidate.label}`);
  const previousToolToken = process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN;
  process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN = capability.token;
  const events = [];
  try {
    await runPiConversation(
      {
        run_id: runId,
        session_id: sessionId,
        base_url: target.baseUrl,
        model: target.modelPath,
        provider_kind: "openai-compatible",
        role: "primary",
        messages: [
          { role: "system", content: modelSystemPrompt(target.modelId) },
          { role: "user", content: task.prompt },
        ],
        tools: context.tools,
        tool_executor_url: `${capability.baseUrl}/api/conversation-runtime/tool?slot_id=${target.slotId}`,
        max_output_tokens: maxTokens,
        max_tool_rounds: 4,
        allow_remote: false,
        runtime_backend: "pi",
      },
      (event) => events.push(event),
      AbortSignal.timeout(timeoutMs),
    );
  } finally {
    if (previousToolToken === undefined) delete process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN;
    else process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN = previousToolToken;
  }
  validateRuntimeTrace(events);
  return { events, target };
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
  const reportProgress = options.onProgress ?? ((line) => process.stdout.write(line));
  const reportResult = options.reportResult ?? true;
  const suite = options.suite ?? "core";
  const sourceTaskFile = resolveSuiteFile(suite);
  const sourceTaskBytes = readFileSync(join(here, sourceTaskFile));
  const tasks = selectTasks(JSON.parse(sourceTaskBytes), options.taskIds);
  const taskBytes = options.taskIds.length === 0
    ? sourceTaskBytes
    : Buffer.from(`${JSON.stringify(tasks, null, 2)}\n`);
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
  const managedResidency = options.executionMode === "direct-pi" && options.manageResidency !== false;
  const originalResidency = managedResidency ? await residencySnapshot(capability) : null;
  if (originalResidency?.slots.some((slot) => slot.state === "loading")) {
    throw new Error("managed proof cannot start while a residency slot is loading; wait and retry");
  }
  const originalRunningSlotIds = originalResidency?.slots
    .filter((slot) => slot.state === "running")
    .map((slot) => slot.id) ?? [];
  let sharedToolSchemaSha256 = null;

  const rows = [];
  try {
    for (const candidate of options.candidates) {
      if (managedResidency) await isolateCandidate(capability, candidate.slotId);
      const directContext = options.executionMode === "direct-pi"
        ? await loadDirectContext(capability, [candidate])
        : null;
      if (directContext) {
        if (
          sharedToolSchemaSha256 != null
          && sharedToolSchemaSha256 !== directContext.toolSchemaSha256
        ) {
          throw new Error("Desktop tool schema changed during managed proof");
        }
        sharedToolSchemaSha256 = directContext.toolSchemaSha256;
      }
      for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
        for (const task of tasks) {
          const runId = `${proofId}-${candidate.label}-r${repetition}-${task.id}`;
          const sessionId = runId;
          const before = performance.now();
          let events;
          let modelId = null;
          if (directContext) {
            const direct = await runDirectTurn(
              capability,
              directContext,
              candidate,
              task,
              runId,
              sessionId,
              options.maxTokens,
              options.timeoutMs,
            );
            events = direct.events;
            modelId = direct.target.modelId;
          } else {
            const response = await apiFetch(
              capability,
              `/v1/conversations/${encodeURIComponent(sessionId)}/turns`,
              {
                method: "POST",
                signal: AbortSignal.timeout(options.timeoutMs),
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
            events = await readNdjson(response);
          }
          const score = scoreToolTrace(events, task);
          const row = {
            proof_id: proofId,
            suite,
            suite_sha256: suiteSha256,
            candidate: candidate.label,
            slot_id: candidate.slotId,
            model_id: modelId,
            runtime_backend: directContext ? "pi" : "desktop-api",
            repetition,
            task_id: task.id,
            expected_calls: expectedCallsForTask(task),
            expected_output: task.expected_output,
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
          reportProgress(
            `${candidate.label.padEnd(10)} r${repetition} ${task.id.padEnd(22)} `
            + `${score.strict_pass ? "PASS" : "FAIL"} tools=${score.call_sequence
              .map(({ tool }) => tool)
              .join(",") || "none"}\n`,
          );
        }
      }
      if (managedResidency) {
        await coolSlotAndVerify(capability, candidate.slotId);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
      }
    }
  } finally {
    if (managedResidency) await restoreResidency(capability, originalRunningSlotIds);
  }
  const summary = {
    format: "understudy.desktop_tool_proof.v3",
    proof_id: proofId,
    suite,
    source_task_file: sourceTaskFile,
    suite_sha256: suiteSha256,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    api_version: capabilities.api_version,
    event_schema: capabilities.event_schema,
    task_count: tasks.length,
    repetitions: options.repetitions,
    run_count: rows.length,
    timeout_ms: options.timeoutMs,
    execution_mode: options.executionMode,
    residency_mode: managedResidency ? "managed-exclusive" : "prewarmed",
    original_running_slot_ids: originalRunningSlotIds,
    release_cohort_eligible: false,
    tool_schema_sha256: sharedToolSchemaSha256,
    candidates: summarizeRows(rows),
  };
  writeProofFile(
    join(outputDir, "results.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  writeProofFile(join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeProofFile(join(outputDir, "tasks.json"), taskBytes);
  if (reportResult) {
    process.stdout.write(`${JSON.stringify({ output_dir: outputDir, summary }, null, 2)}\n`);
  }
  return { outputDir, rows, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProof().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
