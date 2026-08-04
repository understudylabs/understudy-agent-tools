import assert from "node:assert/strict";
import test from "node:test";

import {
  ProtocolTrajectoryError,
  canonicalToolCatalogFingerprint,
  canonicalTrajectoryFingerprint,
  decodeAnthropicRequest,
  decodeAnthropicResponse,
  decodeOpenAIRequest,
  decodeOpenAIResponse,
  dereferenceLocalJsonSchema,
  encodeAnthropicRequest,
  encodeOpenAIRequest,
  validateTrajectory,
} from "../dist/protocol-trajectory/index.js";

const tools = [{
  name: "lookup",
  description: "Look up records",
  input_schema: {
    $defs: {
      query: {
        type: "object",
        properties: { values: { type: "array", items: {} }, label: { type: ["string", "null"] } },
        required: ["values", "label"],
      },
    },
    $ref: "#/$defs/query",
  },
}];

const canonical = {
  schema_version: "understudy.tool_trajectory.v1",
  system: [{ type: "text", text: "Use tools carefully. 世界" }],
  tools: [{
    name: "lookup",
    description: "Look up records",
    input_schema: {
      $defs: { query: { type: "object", properties: { values: { type: "array", items: {} }, label: { type: ["string", "null"] } }, required: ["values", "label"] } },
      type: "object",
      properties: { values: { type: "array", items: {} }, label: { type: ["string", "null"] } },
      required: ["values", "label"],
    },
  }],
  messages: [
    { role: "user", parts: [{ type: "text", text: "Find α and β" }] },
    { role: "assistant", parts: [
      { type: "text", text: "Checking. " },
      { type: "tool_call", id: "call-1", name: "lookup", arguments: { values: ["α", null, [1, 2]], label: null } },
      { type: "tool_call", id: "call-2", name: "lookup", arguments: ["β", null] },
    ] },
    { role: "tool", parts: [
      { type: "tool_result", call_id: "call-1", content: "found α", is_error: false },
      { type: "tool_result", call_id: "call-2", content: "timeout", is_error: true },
    ] },
    { role: "assistant", parts: [{ type: "tool_call", id: "call-3", name: "lookup", arguments: { values: [], label: "retry" } }] },
    { role: "tool", parts: [{ type: "tool_result", call_id: "call-3", content: "found β", is_error: false }] },
    { role: "assistant", parts: [{ type: "text", text: "Done: α, β." }] },
  ],
};

function anthropicFixture() {
  return {
    system: [{ type: "text", text: "Use tools carefully. 世界" }],
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
    messages: [
      { role: "user", content: [{ type: "text", text: "Find α and β" }] },
      { role: "assistant", content: [
        { type: "text", text: "Checking. " },
        { type: "tool_use", id: "call-1", name: "lookup", input: { values: ["α", null, [1, 2]], label: null } },
        { type: "tool_use", id: "call-2", name: "lookup", input: ["β", null] },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call-1", content: "found α" },
        { type: "tool_result", tool_use_id: "call-2", content: "timeout", is_error: true },
      ] },
      { role: "assistant", content: [{ type: "tool_use", id: "call-3", name: "lookup", input: { values: [], label: "retry" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-3", content: "found β" }] },
      { role: "assistant", content: [{ type: "text", text: "Done: α, β." }] },
    ],
  };
}

function openAiFixture() {
  return {
    tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
    messages: [
      { role: "system", content: "Use tools carefully. 世界" },
      { role: "user", content: "Find α and β" },
      { role: "assistant", content: "Checking. ", tool_calls: [
        { id: "call-1", type: "function", function: { name: "lookup", arguments: JSON.stringify({ values: ["α", null, [1, 2]], label: null }) } },
        { id: "call-2", type: "function", function: { name: "lookup", arguments: JSON.stringify(["β", null]) } },
      ] },
      { role: "tool", name: "lookup", tool_call_id: "call-1", content: "found α" },
      { role: "tool", name: "lookup", tool_call_id: "call-2", content: "timeout", is_error: true },
      { role: "assistant", content: null, tool_calls: [{ id: "call-3", type: "function", function: { name: "lookup", arguments: JSON.stringify({ values: [], label: "retry" }) } }] },
      { role: "tool", name: "lookup", tool_call_id: "call-3", content: "found β" },
      { role: "assistant", content: "Done: α, β." },
    ],
  };
}

test("golden Anthropic and OpenAI requests decode to one canonical trajectory", () => {
  const anthropic = decodeAnthropicRequest(anthropicFixture());
  const openai = decodeOpenAIRequest(openAiFixture());
  assert.deepEqual(openai, anthropic);
  assert.deepEqual(anthropic, canonical);
  assert.equal(canonicalTrajectoryFingerprint(openai), canonicalTrajectoryFingerprint(anthropic));
});

test("canonical request round trips through both native tool protocols", () => {
  assert.deepEqual(decodeAnthropicRequest(encodeAnthropicRequest(canonical, { model: "anthropic-model" })), canonical);
  assert.deepEqual(decodeOpenAIRequest(encodeOpenAIRequest(canonical, { model: "openai-model" })), canonical);
});

test("Anthropic mixed tool results and follow-up text convert without dropping either", () => {
  const mixed = anthropicFixture();
  mixed.messages[2].content.push({ type: "text", text: "Also continue with the next lookup." });
  const decoded = decodeAnthropicRequest(mixed);
  assert.deepEqual(decoded.messages.slice(2, 4), [
    canonical.messages[2],
    { role: "user", parts: [{ type: "text", text: "Also continue with the next lookup." }] },
  ]);
  const openai = encodeOpenAIRequest(decoded);
  assert.deepEqual(openai.messages.slice(3, 6), [
    { role: "tool", tool_call_id: "call-1", content: "found α" },
    { role: "tool", tool_call_id: "call-2", content: "timeout", is_error: true },
    { role: "user", content: "Also continue with the next lookup." },
  ]);
});

test("structured system and message text-part boundaries survive both protocols", () => {
  const structured = {
    schema_version: "understudy.tool_trajectory.v1",
    system: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
    tools: [],
    messages: [{ role: "user", parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
  };
  assert.deepEqual(decodeAnthropicRequest(encodeAnthropicRequest(structured)), structured);
  assert.deepEqual(decodeOpenAIRequest(encodeOpenAIRequest(structured)), structured);
});

test("non-streaming responses preserve mixed text, parallel calls, ids, and stop state", () => {
  const expected = {
    role: "assistant",
    parts: [
      { type: "text", text: "Working…" },
      { type: "tool_call", id: "a", name: "lookup", arguments: { label: null, values: ["世界"] } },
      { type: "tool_call", id: "b", name: "lookup", arguments: [null, "β"] },
    ],
    stop_reason: "tool_calls",
  };
  assert.deepEqual(decodeAnthropicResponse({ stop_reason: "tool_use", content: [
    { type: "text", text: "Working…" },
    { type: "tool_use", id: "a", name: "lookup", input: { label: null, values: ["世界"] } },
    { type: "tool_use", id: "b", name: "lookup", input: [null, "β"] },
  ] }), expected);
  const openai = decodeOpenAIResponse({ choices: [{ finish_reason: "tool_calls", message: { content: "Working…", tool_calls: [
    { id: "a", type: "function", function: { name: "lookup", arguments: JSON.stringify({ label: null, values: ["世界"] }) } },
    { id: "b", type: "function", function: { name: "lookup", arguments: JSON.stringify([null, "β"]) } },
  ] } }] });
  assert.deepEqual(openai.parts.map(({ raw_arguments, ...part }) => part), expected.parts);
  assert.equal(openai.stop_reason, expected.stop_reason);
});

test("malformed OpenAI arguments fail closed while retaining raw evidence", () => {
  assert.throws(
    () => decodeOpenAIResponse({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "bad", type: "function", function: { name: "lookup", arguments: '{"x":' } }] } }] }),
    (error) => {
      assert.ok(error instanceof ProtocolTrajectoryError);
      assert.equal(error.code, "malformed_tool_arguments");
      assert.equal(error.details.raw_arguments, '{"x":');
      assert.deepEqual(error.details.canonical_part, { type: "tool_call", id: "bad", name: "lookup", arguments: null, raw_arguments: '{"x":' });
      return true;
    },
  );
});

test("local schema refs dereference deterministically and unsafe refs fail closed", () => {
  const left = dereferenceLocalJsonSchema({ $defs: { leaf: { type: "string" } }, type: "array", items: { $ref: "#/$defs/leaf" } });
  assert.deepEqual(left, { $defs: { leaf: { type: "string" } }, type: "array", items: { type: "string" } });
  assert.equal(canonicalToolCatalogFingerprint([{ name: "x", input_schema: left }]), canonicalToolCatalogFingerprint([{ input_schema: { items: { type: "string" }, type: "array", $defs: { leaf: { type: "string" } } }, name: "x" }]));
  assert.throws(() => dereferenceLocalJsonSchema({ $ref: "https://example.com/schema" }), (error) => error.code === "external_schema_ref");
  assert.throws(() => dereferenceLocalJsonSchema({ $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" }), (error) => error.code === "cyclic_schema_ref");
});

test("trajectory validation rejects dropped, reordered, changed, orphan, and duplicate call ids", () => {
  const mutate = (messages) => ({ ...canonical, messages });
  assert.throws(() => validateTrajectory(mutate(canonical.messages.slice(0, 2))), (error) => error.code === "dropped_tool_result");
  const reordered = structuredClone(canonical.messages);
  reordered[2].parts.reverse();
  assert.throws(() => validateTrajectory(mutate(reordered)), (error) => error.code === "tool_result_order");
  const changed = structuredClone(canonical.messages);
  changed[2].parts[0].call_id = "changed";
  assert.throws(() => validateTrajectory(mutate(changed)), (error) => error.code === "tool_result_order");
  assert.throws(() => validateTrajectory(mutate([{ role: "tool", parts: [{ type: "tool_result", call_id: "orphan", content: null, is_error: false }] }])), (error) => error.code === "orphan_tool_result");
  const duplicate = structuredClone(canonical.messages);
  duplicate[3].parts[0].id = "call-1";
  assert.throws(() => validateTrajectory(mutate(duplicate)), (error) => error.code === "invalid_call_id");
});

test("fingerprints are deterministic, key-order independent, and structure sensitive", () => {
  const first = canonicalTrajectoryFingerprint(canonical);
  assert.equal(first, canonicalTrajectoryFingerprint(structuredClone(canonical)));
  const changed = structuredClone(canonical);
  changed.messages.at(-1).parts[0].text = "Different";
  assert.notEqual(first, canonicalTrajectoryFingerprint(changed));
});
