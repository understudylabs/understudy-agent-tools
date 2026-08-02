import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitSha256, taskPool } from "../dist/automationbench-offline.js";
import { TASKS } from "../dist/automationbench-offline.js";
import { parseModelToolCalls, parseModelToolCallsDetailed, isFinishSignal } from "../experiments/gepa-automationbench/parser.mjs";
import { optimize, promptHygieneFindings } from "../experiments/gepa-automationbench/gepa.mjs";

describe("GEPA AutomationBench harness", () => {
  it("parses Nemotron text, OpenAI-native calls, and malformed text", () => {
    assert.deepEqual(parseModelToolCalls({ content: '<tool_call>{"name":"api_search","arguments":{"query":"crm"}}</tool_call>' }), [
      { name: "api_search", arguments: { query: "crm" } },
    ]);
    assert.deepEqual(parseModelToolCalls({ tool_calls: [{ function: { name: "api_search", arguments: '{"query":"crm"}' } }] }), [
      { name: "api_search", arguments: { query: "crm" } },
    ]);
    assert.deepEqual(parseModelToolCalls({ content: '<think>reasoning</think><tool_call>{"name":"api_search","arguments":{"query":"old"}}</tool_call><tool_call>{"name":"api_search","arguments":{"query":"new"}}</tool_call>' }), [
      { name: "api_search", arguments: { query: "new" } },
    ]);
    const nemotronSearch = `long reasoning preamble
step by step
</think>
<tool_call>
<function=api_search>
<parameter=top_k>
5
</parameter>
<parameter=query>
Ada Lovelace CRM contact
</parameter>
</function>
</tool_call>`;
    assert.deepEqual(parseModelToolCalls({ content: nemotronSearch }), [{ name: "api_search", arguments: { top_k: 5, query: "Ada Lovelace CRM contact" } }]);
    const nemotronPatch = `<tool_call>
<function=api_fetch>
<parameter=method>
PATCH
</parameter>
<parameter=url>
/crm/contacts/c-1
</parameter>
<parameter=body>
{"status":"won","priority":2}
</parameter>
</function>
</tool_call>`;
    assert.deepEqual(parseModelToolCalls({ content: nemotronPatch }), [{ name: "api_fetch", arguments: { method: "PATCH", url: "/crm/contacts/c-1", body: { status: "won", priority: 2 } } }]);
    assert.deepEqual(parseModelToolCallsDetailed({ content: `${nemotronSearch}\n${nemotronPatch}` }).blockCount, 2);
    assert.equal(isFinishSignal({ content: "I am done, but not using the sentinel." }), false);
    assert.equal(isFinishSignal({ content: "<think>done</think><finish/>" }), true);
    assert.throws(() => parseModelToolCalls({ content: "<tool_call>{bad}</tool_call>" }), /Unexpected|JSON/);
  });

  it("refuses holdout access without the exact frozen hash", () => {
    assert.throws(() => taskPool({ split: "holdout" }), /frozen-holdout refusal/);
    assert.throws(() => taskPool({ split: "holdout", frozenHoldoutSha256: "0".repeat(64) }), /hash mismatch/);
    assert.equal(taskPool({ split: "holdout", frozenHoldoutSha256: splitSha256("holdout") }).length, 12);
  });

  it("rejects fixture-specific candidate prompts", () => {
    assert.ok(promptHygieneFindings("Use c-1 and Ada Lovelace at ada.lovelace@example.test").length >= 3);
    assert.deepEqual(promptHygieneFindings("Be careful and use the available tools; emit <finish/> only when complete."), []);
    assert.deepEqual(promptHygieneFindings("Use the reference information returned by the available tools and verify the final state."), []);
  });

  it("evaluates and selects a reflective proposal that improves the score", async () => {
    const modelClient = {
      async chat(messages) {
        const system = messages.find((message) => message.role === "system")?.content ?? "";
        const user = messages.find((message) => message.role === "user")?.content ?? "";
        const task = TASKS.find((entry) => user.includes(entry.prompt));
        const action = system.includes("GEPA_MARKER") ? task?.oracle?.[messages.filter((message) => message.role === "tool").length] : null;
        return { message: { content: action ? `<tool_call>${JSON.stringify(action)}</tool_call>` : "<finish/>" }, usage: { prompt: 1, completion: 1 } };
      },
    };
    const reflectionClient = { async chat() { return { message: { content: "GEPA_MARKER: follow the available API tools and emit <finish/> when complete." } }; } };
    const result = await optimize({ modelClient, reflectionClient, model: "stub", reflectionModel: "stub", generations: 1, minibatch: 2, candidatesPerGeneration: 1, concurrency: 2 });
    assert.match(result.best.prompt, /GEPA_MARKER/);
    assert.equal(result.best.mean, 1);
    assert.ok(result.archive.some((entry) => entry.prompt.includes("GEPA_MARKER") && entry.mean === 1));
  });
});
