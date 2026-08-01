#!/usr/bin/env node

// Experiment notes, receipts, and reproduction commands: ./README.md

import assert from "node:assert/strict";

import {
  TASKS,
  getTask,
  parseToolCalls,
  sentinelPolicy,
  splitSha256,
} from "../../dist/automationbench-offline.js";
import { runTaskWithModel } from "./harness.mjs";
import { nemotronCallModel, parseNemotronTextMessage } from "./nemotron-text-tools.mjs";

const FROZEN_HOLDOUT = "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701";

function oracleModel(taskId) {
  let index = 0;
  return async () => {
    const call = getTask(taskId).oracle[index++];
    return call
      ? {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `oracle-${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }],
      }
      : { role: "assistant", content: "Done." };
  };
}

function sentinelModel(taskId) {
  const policy = sentinelPolicy();
  return async (messages) => {
    const step = messages.filter((message) => message.role === "tool").length;
    const call = policy({ task_id: taskId, step, messages, tools: [] });
    return call
      ? {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `sentinel-${step}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }],
      }
      : { role: "assistant", content: "Done." };
  };
}

function parsedFixture(text) {
  return parseNemotronTextMessage({ role: "assistant", content: text });
}

const clean = parsedFixture(`
<think>choose the CRM search</think>
<tool_call>
<function=api_search>
<parameter=query>
record deal won CRM
</parameter>
</function>
</tool_call>
`);
assert.equal(clean.content, "");
assert.deepEqual(JSON.parse(clean.tool_calls[0].function.arguments), { query: "record deal won CRM" });

const body = parsedFixture(`
<tool_call>
<function=api_fetch>
<parameter=method>PATCH</parameter>
<parameter=url>/crm/contacts/c-1</parameter>
<parameter=body>{"status":"won"}</parameter>
</function>
</tool_call>
`);
assert.deepEqual(JSON.parse(body.tool_calls[0].function.arguments), {
  method: "PATCH",
  url: "/crm/contacts/c-1",
  body: { status: "won" },
});

const multiple = parsedFixture(`
<tool_call><function=api_search><parameter=query>crm</parameter></function></tool_call>
<tool_call><function=api_fetch><parameter=method>GET</parameter><parameter=url>/crm/contacts</parameter></function></tool_call>
`);
assert.equal(multiple.tool_calls.length, 2);

const unterminatedThink = parsedFixture(`
<think>this reasoning never closed
<tool_call><function=api_search><parameter=query>hidden</parameter></function></tool_call>
`);
assert.equal(unterminatedThink.tool_calls, undefined);
assert.equal(unterminatedThink.content, "");

const missingFunction = parsedFixture("<tool_call><parameter=query>crm</parameter></tool_call>");
assert.throws(() => parseToolCalls(missingFunction), /missing a name/);

const invalidBody = parsedFixture(`
<tool_call>
<function=api_fetch>
<parameter=method>POST</parameter>
<parameter=url>/mail/drafts</parameter>
<parameter=body>not-json</parameter>
</function>
</tool_call>
`);
assert.throws(() => parseToolCalls(invalidBody), /missing a name/);

const originalFetch = globalThis.fetch;
let mockedRequest = 0;
globalThis.fetch = async () => {
  const request = mockedRequest;
  mockedRequest += 1;
  if (request === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  const content = request === 0
    ? "<think>budget exhausted"
    : "<tool_call><function=api_search><parameter=query>crm</parameter></function></tool_call>";
  const finishReason = request === 0 ? "length" : "stop";
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { role: "assistant", content } }],
    usage: {},
  }), { status: 200 });
};
const concurrentModel = nemotronCallModel({ model: "offline-test", timeoutMs: 1_000 });
await Promise.all([concurrentModel([], []), concurrentModel([], [])]);
assert.equal(concurrentModel.truncations, 1);
globalThis.fetch = originalFetch;

const sample = TASKS.filter((task) => task.split === "train").slice(0, 3);
for (const task of sample) {
  const oracle = await runTaskWithModel({ taskId: task.taskId, callModel: oracleModel(task.taskId) });
  assert.equal(oracle.reward, 1, `${task.taskId} oracle`);
  assert.equal(oracle.malformed, 0);
  const sentinel = await runTaskWithModel({ taskId: task.taskId, callModel: sentinelModel(task.taskId) });
  assert.equal(sentinel.reward, 0, `${task.taskId} sentinel`);
  assert.ok(sentinel.forbiddenEffects.length > 0);
  const noop = await runTaskWithModel({ taskId: task.taskId, callModel: async () => ({ role: "assistant", content: "Done." }) });
  assert.equal(noop.reward, 0, `${task.taskId} noop`);
  const malformed = await runTaskWithModel({
    taskId: task.taskId,
    callModel: async () => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "bad", type: "function", function: { name: "api_fetch", arguments: "[]" } }],
    }),
  });
  assert.equal(malformed.reward, 0, `${task.taskId} malformed`);
  assert.equal(malformed.malformed, 3);
}
assert.equal(splitSha256("holdout"), FROZEN_HOLDOUT);
process.stdout.write(`sanity ok: ${sample.length} tasks; holdout ${FROZEN_HOLDOUT}\n`);
