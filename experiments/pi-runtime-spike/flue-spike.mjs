import assert from "node:assert/strict";
import { createServer } from "node:http";

import { defineAgent, registerProvider } from "@flue/runtime";
import { createFlueContext, resolveModel } from "@flue/runtime/internal";
import { local } from "@flue/runtime/node";

import { basicChatPrompt } from "./shared-input.mjs";

function completionChunk(delta, finishReason = null, usage) {
  return {
    id: "chatcmpl-flue",
    object: "chat.completion.chunk",
    created: 1,
    model: "flue-local",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

const server = createServer(async (request, response) => {
  for await (const _part of request) {
    // Drain the local fixture request before responding.
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [
    completionChunk({ role: "assistant", content: "Flue local fixture passed." }),
    completionChunk({}, "stop", {
      prompt_tokens: 4,
      completion_tokens: 5,
      total_tokens: 9,
    }),
  ]) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
const address = server.address();
assert.ok(address && typeof address !== "string");

registerProvider("understudy-local", {
  api: "openai-completions",
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  apiKey: "local-fixture-key",
  contextWindow: 32_768,
  maxTokens: 8_192,
});

const agent = defineAgent(() => ({
  model: "understudy-local/flue-local",
  instructions: "You are the Understudy conversation runtime.",
  thinkingLevel: "off",
  compaction: false,
}));
const sandbox = local();
const context = createFlueContext({
  id: "understudy-flue-spike",
  agentName: "understudy",
  env: {},
  agentConfig: { resolveModel },
  createDefaultEnv: () => sandbox.createSessionEnv({ id: "understudy-flue-spike" }),
});
const events = [];
const unsubscribe = context.subscribeEvent((event) => events.push(event));
let harness;
try {
  harness = await context.initializeRootHarness(agent);
  const session = await harness.session();
  const result = await session.prompt(basicChatPrompt);
  assert.equal(result.text, "Flue local fixture passed.");
  assert.equal(result.usage.totalTokens, 9);
  const turnRequest = events.find((event) => event.type === "turn_request");
  assert.ok(turnRequest, "Flue did not expose its model request event");
  const systemPrompt = turnRequest.request.input.systemPrompt;
  const requestedTools = turnRequest.request.input.tools;
  assert.match(systemPrompt, /Understudy conversation runtime/);
  assert.match(systemPrompt, /headless mode with no human operator/);
  assert.ok(requestedTools.length > 0);
  if (process.env.FLUE_DEBUG === "1") {
    process.stderr.write(`${JSON.stringify(events, null, 2)}\n`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        contender: "@flue/runtime@1.0.0-beta.9",
        passed: true,
        model_request_count: events.filter((event) => event.type === "turn_request").length,
        requested_tool_names: requestedTools.map((tool) => tool.name),
        injected_headless_policy: systemPrompt.includes("headless mode with no human operator"),
        injected_workspace_context: systemPrompt.includes("Directory structure:"),
        event_types: events.map((event) => event.type),
        conversation_id: session.conversationId,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  unsubscribe();
  await harness?.close();
  await new Promise((accept) => server.close(accept));
}
