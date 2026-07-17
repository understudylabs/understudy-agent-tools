import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

import {
  RuntimeEventWriter,
  validateRuntimeTrace,
} from "../../dist/runtime/conversation/contract.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=";

function sendChunks(response, chunks, delayMs = 0) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  let index = 0;
  const send = () => {
    if (response.destroyed) return;
    if (index === chunks.length) {
      response.end("data: [DONE]\n\n");
      return;
    }
    response.write(`data: ${JSON.stringify(chunks[index++])}\n\n`);
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  };
  send();
}

function chunk(delta, finishReason = null, usage) {
  return {
    id: "chatcmpl-pi-spike",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

async function listen(server) {
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server) {
  await new Promise((accept) => server.close(accept));
}

function fixtureModel(port) {
  return {
    id: "fixture-model",
    name: "fixture-model",
    api: "openai-completions",
    provider: "understudy-local",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8_192,
  };
}

function piAgent(model, writer, tools = []) {
  const terminal = { seen: false };
  const agent = new Agent({
    initialState: {
      systemPrompt: "Use the local tool when useful.",
      model,
      thinkingLevel: "off",
      messages: [],
      tools,
    },
    sessionId: "session-pi-spike",
    toolExecution: "sequential",
    getApiKey: () => "local-fixture-key",
    streamFn: (selectedModel, context, options) =>
      streamSimple(selectedModel, context, {
        ...options,
        apiKey: "local-fixture-key",
        maxRetries: 0,
      }),
  });
  agent.subscribe(async (event) => {
    if (terminal.seen) return;
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        await writer.emit("delta", {
          role: "primary",
          text: update.delta,
          model: model.id,
        });
      } else if (update.type === "thinking_delta") {
        await writer.emit("reasoning_delta", {
          role: "primary",
          text: update.delta,
          model: model.id,
        });
      }
    } else if (event.type === "tool_execution_start") {
      await writer.emit("tool_call", {
        call_id: event.toolCallId,
        name: event.toolName,
        raw_arguments: JSON.stringify(event.args),
        parsed_arguments: event.args,
      });
    } else if (event.type === "tool_execution_end") {
      await writer.emit("tool_result", {
        call_id: event.toolCallId,
        name: event.toolName,
        ok: !event.isError,
        result: event.result,
      });
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      const usage = message.usage;
      const complete = [usage.input, usage.output, usage.totalTokens].every(Number.isFinite);
      await writer.emit("usage", {
        role: "primary",
        model: model.id,
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        reasoning_tokens: usage.reasoning ?? 0,
        cached_input_tokens: usage.cacheRead ?? 0,
        total_tokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
        source: complete ? "provider" : "unavailable",
        complete,
      });
      if (message.stopReason === "aborted") {
        terminal.seen = true;
        await writer.emit("cancellation", {
          stage: "model_stream",
          reason: message.errorMessage || "aborted",
        });
      } else if (message.stopReason === "error") {
        terminal.seen = true;
        await writer.emit("error", {
          stage: "model_stream",
          code: "pi_runtime_error",
          message: message.errorMessage || "Pi runtime error",
          recoverable: false,
        });
      }
    }
  });
  return agent;
}

async function toolImageTrace() {
  let requests = 0;
  let sawImage = false;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const piece of request) raw += piece;
    const body = JSON.parse(raw);
    requests += 1;
    sawImage ||= JSON.stringify(body.messages).includes("data:image/png;base64,");
    if (requests === 1) {
      sendChunks(response, [
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call-pi-status",
              type: "function",
              function: { name: "status", arguments: "{\"query\":\"runtime\"}" },
            },
          ],
        }),
        chunk({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }),
      ]);
    } else {
      sendChunks(response, [
        chunk({ role: "assistant", content: "Local runtime is healthy." }),
        chunk({}, "stop", { prompt_tokens: 18, completion_tokens: 5, total_tokens: 23 }),
      ]);
    }
  });
  const port = await listen(server);
  const events = [];
  const request = {
    run_id: "run-pi-tool-image",
    session_id: "session-pi-spike",
    initial_sequence: 0,
  };
  const writer = new RuntimeEventWriter(request, (event) => events.push(event));
  const imageBytes = Buffer.from(PNG_BASE64, "base64");
  await writer.emit("image_attachment", {
    attachment_id: createHash("sha256").update(imageBytes).digest("hex"),
    filename: "pixel.png",
    media_type: "image/png",
    byte_count: imageBytes.byteLength,
  });
  await writer.emit("message", { role: "user", text: "Check image and runtime status.", model: null });
  const tools = [
    {
      name: "status",
      label: "Runtime status",
      description: "Read local runtime status.",
      parameters: Type.Object({ query: Type.String() }),
      async execute(toolCallId, params) {
        assert.equal(toolCallId, "call-pi-status");
        assert.deepEqual(params, { query: "runtime" });
        return {
          content: [{ type: "text", text: "runtime: healthy" }],
          details: { healthy: true },
        };
      },
    },
  ];
  const agent = piAgent(fixtureModel(port), writer, tools);
  try {
    await agent.prompt("Check image and runtime status.", [
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ]);
  } finally {
    await close(server);
  }
  validateRuntimeTrace(events);
  assert.equal(requests, 2);
  assert.equal(sawImage, true);
  assert.deepEqual(
    events.filter((event) => event.event === "tool_call").map((event) => event.data.call_id),
    ["call-pi-status"],
  );
  return events;
}

async function cancellationTrace() {
  const server = createServer((_request, response) => {
    sendChunks(
      response,
      [
        chunk({ role: "assistant", content: "partial " }),
        chunk({ content: "never reaches client" }),
        chunk({}, "stop", { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 }),
      ],
      150,
    );
  });
  const port = await listen(server);
  const events = [];
  const writer = new RuntimeEventWriter(
    { run_id: "run-pi-cancel", session_id: "session-pi-spike", initial_sequence: 0 },
    (event) => events.push(event),
  );
  await writer.emit("message", { role: "user", text: "Start then cancel.", model: null });
  const agent = piAgent(fixtureModel(port), writer);
  const abortOnDelta = agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      agent.abort();
    }
  });
  try {
    await agent.prompt("Start then cancel.");
  } finally {
    abortOnDelta();
    await close(server);
  }
  validateRuntimeTrace(events);
  assert.equal(events.at(-1)?.event, "cancellation");
  return events;
}

const started = performance.now();
const toolImage = await toolImageTrace();
const cancellation = await cancellationTrace();
process.stdout.write(
  `${JSON.stringify(
    {
      contender: "@earendil-works/pi-agent-core@0.80.3",
      node: process.version,
      passed: true,
      elapsed_ms: Math.round(performance.now() - started),
      traces: [
        { id: "tool-image", events: toolImage.map((event) => event.event) },
        { id: "cancellation", events: cancellation.map((event) => event.event) },
      ],
    },
    null,
    2,
  )}\n`,
);
