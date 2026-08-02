import readline from "node:readline";
import {
  finish,
  oraclePolicy,
  partialCredit,
  reset,
  sentinelPolicy,
  splitCounts,
  splitSha256,
  step,
  taskPool,
} from "../../dist/automationbench-offline.js";

const handles = new Map();
let nextHandleId = 1;

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
}

function failure(id, error) {
  process.stdout.write(`${JSON.stringify({ id, ok: false, error: String(error?.message ?? error) })}\n`);
}

function handleFor(id) {
  const handle = handles.get(id);
  if (!handle) throw new Error(`unknown handle_id: ${id}`);
  return handle;
}

function runPolicy(taskId, policyFactory) {
  const { handle, obs: initial } = reset(taskId);
  const transcript = [{ type: "observation", obs: initial }];
  let obs = initial;
  while (!handle.done) {
    const action = policyFactory(taskId)(obs);
    if (!action) break;
    const result = step(handle, action);
    transcript.push({ type: "action", action, result });
    obs = result.obs;
  }
  if (!handle.done) {
    const result = finish(handle);
    transcript.push({ type: "finish", result });
  }
  return {
    taskId,
    transcript,
    reward: partialCredit(handle),
    steps: handle.step,
    forbiddenEffects: [...handle.forbiddenEffects],
  };
}

async function dispatch(message) {
  const { op } = message;
  if (op === "reset") {
    const { handle, obs } = reset(message.taskId, message.seed ?? 7);
    const handleId = `h-${nextHandleId++}`;
    handles.set(handleId, handle);
    return { handle_id: handleId, obs };
  }
  if (op === "step") {
    const result = step(handleFor(message.handle_id), message.action);
    return result;
  }
  if (op === "finish") {
    return finish(handleFor(message.handle_id));
  }
  if (op === "pool") {
    return taskPool({
      split: message.split,
      frozenHoldoutSha256: message.frozenHoldoutSha256,
    }).map((task) => ({ taskId: task.taskId, prompt: task.prompt }));
  }
  if (op === "split_info") {
    return { counts: splitCounts(), train: splitSha256("train"), dev: splitSha256("dev"), holdout: splitSha256("holdout") };
  }
  if (op === "oracle_trajectory") return runPolicy(message.taskId, oraclePolicy);
  if (op === "sentinel_trajectory") return runPolicy(message.taskId, () => sentinelPolicy());
  throw new Error(`unknown op: ${op}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
    reply(message.id, await dispatch(message));
  } catch (error) {
    failure(message?.id ?? null, error);
  }
});
