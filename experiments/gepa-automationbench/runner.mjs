import { auditObservationLeakage, finish, getTask, reset, step, partialCredit } from "../../dist/automationbench-offline.js";
import { parseModelToolCallsDetailed, isFinishSignal } from "./parser.mjs";
import { sha256 } from "./artifacts.mjs";

const graderKeys = ["assertions", "gold", "allowed_writes", "allowedWrites", "oracle", "initial_state", "reward", "score"];

function transcriptLeakage(transcript, task) {
  const serialized = JSON.stringify(transcript);
  const findings = [];
  for (const key of graderKeys) if (serialized.includes(`"${key}"`)) findings.push(`transcript exposes grader key: ${key}`);
  for (const assertion of task.assertions) {
    const path = assertion.kind === "equals" ? assertion.path : assertion.collection;
    if (serialized.includes(path)) findings.push(`transcript exposes assertion path: ${path}`);
  }
  for (const write of task.allowedWrites) if (serialized.includes(write)) findings.push(`transcript exposes allowed-write path: ${write}`);
  return findings;
}

function catalogText(tools) {
  return tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
}

export async function rolloutModel({ taskId, prompt, modelClient, model, store, phase = "rollout", maxSteps = 12, maxTokens = 2048, usdPerGpuHour = 7, gpuCount = 1 }) {
  const started = performance.now();
  const task = getTask(taskId);
  const { handle, obs } = reset(taskId);
  const transcript = [
    { role: "system", content: prompt },
    { role: "user", content: `${task.prompt}\n\nAvailable tools:\n${catalogText(obs.tools)}` },
  ];
  const initialLeakage = auditObservationLeakage(obs, task);
  if (initialLeakage.length) throw new Error(`observation leakage for ${taskId}: ${initialLeakage.join("; ")}`);
  let consecutiveParseFailures = 0;
  let parseFailures = 0;
  let noCallTurns = 0;
  let multipleToolCallTurns = 0;
  let finishEmitted = false;
  const encodingCounts = {};
  const failureExamples = [];
  const actions = [];
  let tokens = { prompt: 0, completion: 0 };
  for (let i = 0; i < maxSteps && !handle.done; i += 1) {
    const response = await modelClient.chat(transcript, { model, maxTokens });
    const message = response.message ?? response;
    const assistantContent = message.content || message.reasoning_content || "";
    tokens.prompt += Number(response.usage?.prompt ?? 0);
    tokens.completion += Number(response.usage?.completion ?? 0);
    transcript.push({ role: "assistant", content: assistantContent, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) });
    if (isFinishSignal(message)) {
      finishEmitted = true;
      break;
    }
    let calls;
    try {
      const parsed = parseModelToolCallsDetailed(message);
      calls = parsed.calls;
      encodingCounts[parsed.encoding] = (encodingCounts[parsed.encoding] ?? 0) + 1;
      if (parsed.usedLastBlock) multipleToolCallTurns += 1;
      consecutiveParseFailures = 0;
    } catch (error) {
      parseFailures += 1;
      consecutiveParseFailures += 1;
      failureExamples.push({ kind: "parse_failure", assistant: String(assistantContent).slice(0, 600), error: error instanceof Error ? error.message : "invalid tool call" });
      if (consecutiveParseFailures > 2) break;
      transcript.push({ role: "user", content: `Parse error: ${error instanceof Error ? error.message : "invalid tool call"}. Emit exactly one valid tool call.` });
      continue;
    }
    if (calls.length !== 1) {
      noCallTurns += calls.length === 0 ? 1 : 0;
      consecutiveParseFailures += 1;
      if (calls.length === 0) failureExamples.push({ kind: "no_call", assistant: String(assistantContent).slice(0, 600) });
      if (consecutiveParseFailures > 2) break;
      transcript.push({ role: "user", content: "Parse error: emit exactly one tool call or a finish signal." });
      continue;
    }
    const action = calls[0];
    actions.push(action);
    const result = step(handle, action);
    if (auditObservationLeakage(result.obs, task).length) throw new Error(`observation leakage for ${taskId}`);
    transcript.push({ role: "tool", content: JSON.stringify(result.obs.messages.at(-1)?.content ?? "") });
    if (result.done) break;
  }
  const terminal = handle.done ? { reward: partialCredit(handle), info: { forbidden_effects: handle.forbiddenEffects } } : finish(handle);
  const leakage = transcriptLeakage(transcript, task);
  if (leakage.length) throw new Error(`transcript leakage for ${taskId}: ${leakage.join("; ")}`);
  const elapsedMs = performance.now() - started;
  const usd = elapsedMs / 3_600_000 * usdPerGpuHour * gpuCount;
  const stepCapExhausted = !handle.done && !finishEmitted && handle.step >= maxSteps;
  const prematureFinish = finishEmitted && terminal.reward < 1;
  const result = { taskId, split: task.split, reward: terminal.reward, steps: handle.step, forbiddenEffects: [...handle.forbiddenEffects], tokens, actions, transcript, finalState: handle.state, elapsedMs, usd, prompt_sha256: sha256(prompt), leakage, parseFailures, noCallTurns, multipleToolCallTurns, stepCapExhausted, prematureFinish, encodingCounts, failureExamples };
  store?.appendReceipt({ phase, task_id: taskId, split: task.split, model: model ?? null, prompt_sha256: result.prompt_sha256, reward: result.reward, steps: result.steps, forbidden_effects: result.forbiddenEffects, tokens, elapsed_ms: elapsedMs, usd, parse_failures: parseFailures, no_call_turns: noCallTurns, multiple_tool_call_turns: multipleToolCallTurns, step_cap_exhausted: stepCapExhausted, premature_finish: prematureFinish, encoding_counts: encodingCounts });
  return result;
}
