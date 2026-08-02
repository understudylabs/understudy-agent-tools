import {
  AUTOMATIONBENCH_SUBSET,
  finish,
  fixtureSha256,
  getTask,
  parseToolCalls,
  reset,
  splitSha256,
  step,
  taskPool,
} from "../../dist/automationbench-offline.js";

const MAX_STEPS = 12;

function toolSchemas(obs) {
  return obs.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.name === "api_search"
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
          },
    },
  }));
}

function toolMessage(entry, index, stepNumber, content) {
  let id = `call-${stepNumber}-${index}`;
  try {
    const decoded = typeof entry === "string" ? JSON.parse(entry) : entry;
    if (typeof decoded?.id === "string") id = decoded.id;
  } catch {
    // The evaluator will report malformed calls through its normal path.
  }
  return { role: "tool", tool_call_id: id, content };
}

function rejectedMessage(content) {
  return { role: "user", content: `Rejected tool call: ${content}` };
}

export async function runTask({ taskId, callModel }) {
  const task = getTask(taskId);
  const { handle, obs: initial } = reset(taskId);
  const tools = toolSchemas(initial);
  const transcript = [...initial.messages];
  let malformed = 0;
  let terminal;

  while (!handle.done && handle.step < MAX_STEPS) {
    const assistant = await callModel([...transcript], tools);
    const assistantMessage = assistant && typeof assistant === "object"
      ? { ...assistant, role: "assistant" }
      : { role: "assistant", content: "" };
    if (assistantMessage.malformed) malformed += 1;
    transcript.push(assistantMessage);

    const entries = Array.isArray(assistantMessage.tool_calls)
      ? assistantMessage.tool_calls
      : [];
    if (entries.length === 0) {
      terminal = finish(handle).reward;
      break;
    }

    let calls;
    try {
      calls = parseToolCalls(assistantMessage);
    } catch (error) {
      malformed += entries.length;
      transcript.push(rejectedMessage(error instanceof Error ? error.message : String(error)));
      continue;
    }

    for (const [index, call] of calls.entries()) {
      const result = step(handle, call);
      transcript.push(toolMessage(entries[index], index, handle.step, result.obs.messages.at(-1).content));
      if (result.done) {
        terminal = result.reward;
        break;
      }
    }
    if (terminal !== undefined) break;
  }

  if (terminal === undefined) terminal = finish(handle).reward;
  return {
    taskId,
    split: task.split,
    score: terminal,
    steps: handle.step,
    malformed,
    forbiddenEffects: [...handle.forbiddenEffects],
    transcript,
  };
}

export async function evaluatePool({ split, frozenHoldoutSha256, callModel, concurrency = 4 }) {
  const pool = taskPool({ split, frozenHoldoutSha256 });
  const results = new Array(pool.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= pool.length) return;
      const task = pool[index];
      try {
        results[index] = await runTask({ taskId: task.taskId, callModel });
      } catch (error) {
        results[index] = {
          taskId: task.taskId,
          split: task.split,
          score: 0,
          steps: 0,
          malformed: 0,
          forbiddenEffects: [],
          transcript: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  const rows = results.map((result) => ({
    schema_version: "understudy.eval_result.v1",
    run_id: callModel.runId,
    task_id: result.taskId,
    split: result.split,
    score: result.score,
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
  }));
  return {
    rows,
    results,
    meanScore: rows.reduce((sum, row) => sum + row.score, 0) / rows.length,
  };
}
