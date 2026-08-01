// Experiment notes, receipts, and reproduction commands: ./README.md

import {
  AUTOMATIONBENCH_SUBSET,
  auditObservationLeakage,
  finish,
  fixtureSha256,
  getTask,
  parseToolCalls,
  reset,
  splitSha256,
  step,
  taskBands,
  taskPool,
  validateEvalRows,
} from "../../dist/automationbench-offline.js";

const MAX_MALFORMED_IN_ROW = 3;

function toolDefinitionsFromObservation(obs) {
  return obs.tools.map((tool) => {
    const parameters = tool.name === "api_search"
      ? {
        type: "object",
        properties: {
          query: { type: "string" },
          top_k: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      }
      : {
        type: "object",
        properties: {
          method: { type: "string" },
          url: { type: "string" },
          body: { type: "object" },
        },
        required: ["method", "url"],
        additionalProperties: false,
      };
    return { type: "function", function: { name: tool.name, description: tool.description, parameters } };
  });
}

export function toolSchemas() {
  const { obs } = reset("simple-api-crm-close-01");
  return toolDefinitionsFromObservation(obs);
}

function decodedEntries(message) {
  const raw = message && typeof message === "object" ? message.tool_calls : undefined;
  return Array.isArray(raw) ? raw : [];
}

function callId(entry, index, stepNumber) {
  try {
    const decoded = typeof entry === "string" ? JSON.parse(entry) : entry;
    return decoded && typeof decoded === "object" && typeof decoded.id === "string"
      ? decoded.id
      : `call-${stepNumber}-${index}`;
  } catch {
    return `malformed-${stepNumber}-${index}`;
  }
}

function toolMessage(id, content) {
  return { role: "tool", tool_call_id: id, content };
}

function rejectionMessage(content) {
  return { role: "user", content };
}

export async function runTaskWithModel({ taskId, callModel, maxSteps = 12 }) {
  const task = getTask(taskId);
  const { handle, obs: initial } = reset(taskId);
  const leakage = auditObservationLeakage(initial, task);
  if (leakage.length > 0) throw new Error(`${taskId}: observation leakage: ${leakage.join("; ")}`);
  const tools = toolDefinitionsFromObservation(initial);
  const transcript = [...initial.messages];
  let malformed = 0;
  let malformedStreak = 0;
  let terminalReward;
  while (!handle.done && handle.step < maxSteps) {
    const assistant = await callModel([...transcript], tools);
    if (!assistant || typeof assistant !== "object") {
      malformed += 1;
      malformedStreak += 1;
      transcript.push(rejectionMessage("Rejected assistant message: expected an object."));
      if (malformedStreak >= MAX_MALFORMED_IN_ROW) {
        terminalReward = finish(handle).reward;
        break;
      }
      continue;
    }
    const assistantMessage = { ...assistant, role: "assistant" };
    transcript.push(assistantMessage);
    const entries = decodedEntries(assistantMessage);
    if (entries.length === 0) {
      terminalReward = finish(handle).reward;
      break;
    }
    let calls;
    try {
      calls = parseToolCalls(assistantMessage);
    } catch (error) {
      malformed += entries.length;
      malformedStreak += entries.length;
      transcript.push(rejectionMessage(`Rejected tool call: ${error.message}`));
      if (malformedStreak >= MAX_MALFORMED_IN_ROW) {
        terminalReward = finish(handle).reward;
        break;
      }
      continue;
    }
    let rejected = false;
    for (const [index, call] of calls.entries()) {
      const id = callId(entries[index], index, handle.step);
      if (!tools.some((tool) => tool.function.name === call.name) || !call.arguments || Array.isArray(call.arguments)) {
        malformed += 1;
        malformedStreak += 1;
        rejected = true;
        transcript.push(toolMessage(id, `Rejected tool call: unknown or invalid tool ${call.name}.`));
        if (malformedStreak >= MAX_MALFORMED_IN_ROW) break;
        continue;
      }
      malformedStreak = 0;
      const result = step(handle, call);
      transcript.push(toolMessage(id, result.obs.messages.at(-1).content));
      if (result.done) {
        terminalReward = result.reward;
        break;
      }
    }
    if (terminalReward !== undefined) break;
    if (malformedStreak >= MAX_MALFORMED_IN_ROW) {
      terminalReward = finish(handle).reward;
      break;
    }
    if (!rejected) malformedStreak = 0;
  }
  if (terminalReward === undefined) {
    terminalReward = handle.done ? handle.forbiddenEffects.length > 0 ? 0 : finish(handle).reward : finish(handle).reward;
  }
  return {
    taskId,
    split: task.split,
    reward: terminalReward,
    steps: handle.step,
    malformed,
    forbiddenEffects: [...handle.forbiddenEffects],
    transcript,
  };
}

export async function evaluatePool({ split, frozenHoldoutSha256, callModel, concurrency = 4 }) {
  const pool = taskPool({ split, frozenHoldoutSha256 });
  const rows = [];
  const runId = `automationbench-${Date.now()}`;
  const results = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= pool.length) return;
      const task = pool[index];
      let result;
      try {
        result = await runTaskWithModel({ taskId: task.taskId, callModel });
      } catch (error) {
        result = {
          taskId: task.taskId,
          split: task.split,
          reward: 0,
          steps: 0,
          malformed: 0,
          forbiddenEffects: [],
          transcript: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
      results[index] = result;
      rows[index] = {
        schema_version: "understudy.eval_result.v1",
        run_id: runId,
        task_id: task.taskId,
        split: task.split,
        score: result.reward,
        status: result.error ? "error" : "ok",
        ...(result.error ? { error: result.error } : {}),
        model: callModel.model ?? null,
        route: "fireworks-openai-compatible",
        cost: { usd: null, basis: "provider-usage-receipt-required" },
        benchmark_id: AUTOMATIONBENCH_SUBSET.benchmark_id,
        subscores: {
          forbidden_effects: result.forbiddenEffects.length,
          steps: result.steps,
          malformed: result.malformed,
        },
        provenance: {
          harness_sha256: fixtureSha256(),
          split_sha256: splitSha256(split),
          artifact_refs: [`fixture://${AUTOMATIONBENCH_SUBSET.fixture_id}`],
        },
      };
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  const errors = validateEvalRows(rows);
  if (errors.length > 0) throw new Error(`invalid eval rows: ${errors.join("; ")}`);
  const bands = taskBands();
  const breakdown = {};
  for (const row of rows) {
    const family = row.task_id.split("-").slice(2, -1).join("-");
    const band = bands[family] ?? "unknown";
    const bucket = breakdown[band] ?? { count: 0, score: 0 };
    bucket.count += 1;
    bucket.score += row.score;
    breakdown[band] = bucket;
  }
  for (const bucket of Object.values(breakdown)) bucket.mean_score = bucket.score / bucket.count;
  return {
    rows,
    results,
    meanScore: rows.reduce((sum, row) => sum + row.score, 0) / rows.length,
    byBand: breakdown,
  };
}
