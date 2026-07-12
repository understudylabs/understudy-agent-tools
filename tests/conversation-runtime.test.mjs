import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import {
  conversationRuntimeStatus,
  installConversationRuntime,
  startConversationRuntime,
  stopConversationRuntime,
} from "../dist/runtime/conversation/lifecycle.js";
import { runVercelConversation } from "../dist/runtime/conversation/vercel-runtime.js";
import { runPiConversation } from "../dist/runtime/conversation/pi-runtime.js";
import { validateRuntimeTrace } from "../dist/runtime/conversation/contract.js";
import { runConversationConformance } from "../dist/runtime/conversation/conformance.js";

const runtimeHome = mkdtempSync(join(tmpdir(), "understudy-conversation-runtime-"));
const basicChatFixture = JSON.parse(
  readFileSync(
    new URL(
      "../schemas/conversation-runtime-conformance/inputs/basic-chat.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const PNG_ID = createHash("sha256").update(PNG_BYTES).digest("hex");

async function requestJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

function sendFixtureSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

before(() => {
  process.env.UNDERSTUDY_CONVERSATION_RUNTIME_HOME = runtimeHome;
});
after(async () => {
  await stopConversationRuntime().catch(() => {});
  rmSync(runtimeHome, { recursive: true, force: true });
  delete process.env.UNDERSTUDY_CONVERSATION_RUNTIME_HOME;
});

test("CLI lifecycle installs, starts, diagnoses, and stops the packaged sidecar", async () => {
  const injectedToolToken = "desktop-loopback-token-".padEnd(64, "a");
  process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN = injectedToolToken;
  const installed = installConversationRuntime();
  assert.equal(installed.installed, true);
  assert.equal(installed.running, false);

  const running = await startConversationRuntime();
  assert.equal(running.running, true);
  assert.equal(running.healthy, true);
  assert.match(running.base_url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(statSync(running.token_path).mode & 0o077, 0);
  assert.equal(statSync(running.tool_token_path).mode & 0o077, 0);
  assert.ok(readFileSync(running.token_path, "utf8").trim().length >= 64);
  assert.equal(readFileSync(running.tool_token_path, "utf8").trim(), injectedToolToken);

  const probed = await conversationRuntimeStatus();
  assert.equal(probed.healthy, true);

  const stopped = await stopConversationRuntime();
  assert.equal(stopped.running, false);
  assert.equal(stopped.healthy, false);
  delete process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN;
});

test("Vercel runtime emits canonical input, delta, and provider usage", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      {
        id: "chatcmpl-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Vercel local fixture passed." },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        id: "chatcmpl-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ]) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const events = [];
  try {
    await runVercelConversation(
      {
        run_id: "run-public-fixture",
        session_id: "session-public-fixture",
        base_url: `http://127.0.0.1:${address.port}/v1`,
        model: "fixture-model",
        role: "primary",
        messages: basicChatFixture.messages,
        tools: basicChatFixture.tools,
      },
      (event) => events.push(event),
    );
  } finally {
    await new Promise((accept) => server.close(accept));
  }

  assert.deepEqual(
    events.map((event) => event.event),
    ["message", "delta", "usage"],
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [0, 1, 2],
  );
  assert.deepEqual(
    {
      input_tokens: events[2].data.input_tokens,
      output_tokens: events[2].data.output_tokens,
      total_tokens: events[2].data.total_tokens,
      source: events[2].data.source,
      complete: events[2].data.complete,
    },
    {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      source: "provider",
      complete: true,
    },
  );
  validateRuntimeTrace(events);
});

test("Pi runtime emits the same canonical basic-chat evidence", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      {
        id: "chatcmpl-pi-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "pi-fixture-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Pi managed fixture passed." },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-pi-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "pi-fixture-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
      },
    ]) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const events = [];
  try {
    await runPiConversation(
      {
        run_id: "run-managed-pi-fixture",
        session_id: "session-managed-pi-fixture",
        base_url: `http://127.0.0.1:${address.port}/v1`,
        model: "pi-fixture-model",
        role: "primary",
        messages: basicChatFixture.messages,
        tools: basicChatFixture.tools,
        runtime_backend: "pi",
      },
      (event) => events.push(event),
    );
  } finally {
    await new Promise((accept) => server.close(accept));
  }
  assert.deepEqual(
    events.map((event) => event.event),
    ["message", "delta", "usage"],
  );
  assert.ok(events.every((event) => event.runtime_id === "pi-agent-session"));
  assert.equal(events.at(-1).data.input_tokens, 4);
  assert.equal(events.at(-1).data.output_tokens, 4);
  validateRuntimeTrace(events);
});

test("Pi runtime owns the image and authenticated tool round", async () => {
  let providerCalls = 0;
  let imageSeen = false;
  let toolCalls = 0;
  const toolToken = "desktop-tool-token-".padEnd(64, "b");
  process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN = toolToken;
  const server = createServer(async (request, response) => {
    const body = await requestJson(request);
    if (request.url === "/tool") {
      toolCalls += 1;
      assert.equal(request.headers.authorization, `Bearer ${toolToken}`);
      assert.equal(body.run_id, "run-managed-pi-tool-image");
      assert.equal(body.name, "status");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: { status: "healthy" } }));
      return;
    }
    providerCalls += 1;
    imageSeen ||= JSON.stringify(body.messages).includes("data:image/png;base64,");
    if (providerCalls === 1) {
      sendFixtureSse(response, [
        {
          id: "chatcmpl-pi-tool",
          object: "chat.completion.chunk",
          created: 1,
          model: "pi-tool-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-status",
                    type: "function",
                    function: { name: "status", arguments: "{}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl-pi-tool",
          object: "chat.completion.chunk",
          created: 1,
          model: "pi-tool-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        },
      ]);
    } else {
      sendFixtureSse(response, [
        {
          id: "chatcmpl-pi-tool-final",
          object: "chat.completion.chunk",
          created: 1,
          model: "pi-tool-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "The local runtime is healthy." },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl-pi-tool-final",
          object: "chat.completion.chunk",
          created: 1,
          model: "pi-tool-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19 },
        },
      ]);
    }
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const events = [];
  try {
    await runPiConversation(
      {
        run_id: "run-managed-pi-tool-image",
        session_id: "session-managed-pi-tool-image",
        base_url: `http://127.0.0.1:${address.port}/v1`,
        model: "pi-tool-model",
        role: "primary",
        messages: [
          {
            role: "user",
            content: "Inspect the image and check status.",
            attachments: [
              {
                id: PNG_ID,
                filename: "pixel.png",
                media_type: "image/png",
                data_url: `data:image/png;base64,${PNG_BASE64}`,
              },
            ],
          },
        ],
        tools: [
          {
            name: "status",
            description: "Read runtime status.",
            input_schema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
        tool_executor_url: `http://127.0.0.1:${address.port}/tool`,
        runtime_backend: "pi",
      },
      (event) => events.push(event),
    );
  } finally {
    await new Promise((accept) => server.close(accept));
    delete process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN;
  }
  assert.equal(providerCalls, 2);
  assert.equal(toolCalls, 1);
  assert.equal(imageSeen, true);
  assert.deepEqual(
    events.map((event) => event.event),
    ["image_attachment", "message", "usage", "tool_call", "tool_result", "delta", "usage"],
  );
  validateRuntimeTrace(events);
});

test("Pi runtime reopens persisted session history after restart", async () => {
  let providerCalls = 0;
  let secondRequest = null;
  const server = createServer(async (request, response) => {
    const body = await requestJson(request);
    providerCalls += 1;
    if (providerCalls === 2) secondRequest = body;
    const content = providerCalls === 1 ? "The durable fact is seven." : "The fact remains seven.";
    sendFixtureSse(response, [
      {
        id: `chatcmpl-pi-restart-${providerCalls}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "pi-restart-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content },
            finish_reason: null,
          },
        ],
      },
      {
        id: `chatcmpl-pi-restart-${providerCalls}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "pi-restart-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 6, completion_tokens: 5, total_tokens: 11 },
      },
    ]);
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseRequest = {
    session_id: "session-managed-pi-restart",
    base_url: `http://127.0.0.1:${address.port}/v1`,
    model: "pi-restart-model",
    role: "primary",
    tools: [],
    runtime_backend: "pi",
  };
  const firstEvents = [];
  const secondEvents = [];
  try {
    await runPiConversation(
      {
        ...baseRequest,
        run_id: "run-managed-pi-restart-1",
        messages: [{ role: "user", content: "Remember that the durable fact is seven." }],
      },
      (event) => firstEvents.push(event),
    );
    await runPiConversation(
      {
        ...baseRequest,
        run_id: "run-managed-pi-restart-2",
        messages: [
          { role: "user", content: "Remember that the durable fact is seven." },
          { role: "assistant", content: "The durable fact is seven." },
          { role: "user", content: "What was the durable fact?" },
        ],
      },
      (event) => secondEvents.push(event),
    );
  } finally {
    await new Promise((accept) => server.close(accept));
  }
  assert.equal(providerCalls, 2);
  assert.ok(secondRequest);
  const serialized = JSON.stringify(secondRequest.messages);
  assert.match(serialized, /durable fact is seven/);
  assert.match(serialized, /What was the durable fact/);
  validateRuntimeTrace(firstEvents);
  validateRuntimeTrace(secondEvents);
});

test("Pi runtime cancellation preserves the partial and terminates canonically", async () => {
  const provider = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = [
      {
        id: "chatcmpl-pi-cancel",
        object: "chat.completion.chunk",
        created: 1,
        model: "pi-cancel-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "partial output" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-pi-cancel",
        object: "chat.completion.chunk",
        created: 1,
        model: "pi-cancel-model",
        choices: [
          { index: 0, delta: { content: " must not arrive" }, finish_reason: null },
        ],
      },
    ];
    response.write(`data: ${JSON.stringify(chunks[0])}\n\n`);
    setTimeout(() => {
      if (response.destroyed) return;
      response.write(`data: ${JSON.stringify(chunks[1])}\n\n`);
      response.end("data: [DONE]\n\n");
    }, 250);
  });
  await new Promise((accept) => provider.listen(0, "127.0.0.1", accept));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  const events = [];
  try {
    await runPiConversation(
      {
        run_id: "run-managed-pi-cancel",
        session_id: "session-managed-pi-cancel",
        base_url: `http://127.0.0.1:${address.port}/v1`,
        model: "pi-cancel-model",
        role: "primary",
        messages: [{ role: "user", content: "Start then stop." }],
        tools: [],
        runtime_backend: "pi",
      },
      (event) => {
        events.push(event);
        if (event.event === "delta") controller.abort("deterministic_test_cancel");
      },
      controller.signal,
    );
  } finally {
    await new Promise((accept) => provider.close(accept));
  }
  assert.equal(
    events.filter((event) => event.event === "delta").map((event) => event.data.text).join(""),
    "partial output",
  );
  assert.equal(events.at(-1).event, "cancellation");
  assert.match(events.at(-1).data.reason, /abort|cancel/i);
  validateRuntimeTrace(events);
});

test("managed sidecar dispatches an authenticated Pi run", async () => {
  const provider = createServer((_request, response) => {
    sendFixtureSse(response, [
      {
        id: "chatcmpl-managed-sidecar-pi",
        object: "chat.completion.chunk",
        created: 1,
        model: "managed-sidecar-pi",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Managed Pi sidecar passed." },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-managed-sidecar-pi",
        object: "chat.completion.chunk",
        created: 1,
        model: "managed-sidecar-pi",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
    ]);
  });
  await new Promise((accept) => provider.listen(0, "127.0.0.1", accept));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress !== "string");
  let status;
  try {
    status = await startConversationRuntime();
    const token = readFileSync(status.token_path, "utf8").trim();
    const response = await fetch(`${status.base_url}/v1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        run_id: "run-managed-sidecar-pi",
        session_id: "session-managed-sidecar-pi",
        base_url: `http://127.0.0.1:${providerAddress.port}/v1`,
        model: "managed-sidecar-pi",
        role: "primary",
        messages: [{ role: "user", content: "Use Pi." }],
        tools: [],
        runtime_backend: "pi",
      }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event), ["message", "delta", "usage"]);
    assert.ok(events.every((event) => event.runtime_id === "pi-agent-session"));
    validateRuntimeTrace(events);
  } finally {
    await stopConversationRuntime().catch(() => {});
    await new Promise((accept) => provider.close(accept));
  }
});

test("packaged immutable suite passes hashes and canonical trace gates", () => {
  const report = runConversationConformance();
  assert.equal(report.passed, true);
  assert.deepEqual(report.inputs.map((input) => input.id), ["basic-chat"]);
  assert.equal(report.gates.length, 5);
  assert.deepEqual(
    report.gates.map((gate) => gate.id),
    [
      "offline-image",
      "supervisor-takeover",
      "malformed-tool-call",
      "long-chat-restart",
      "cancellation",
    ],
  );
});

test("remote model endpoints fail closed unless both gates are enabled", async () => {
  const events = [];
  await assert.rejects(
    () =>
      runVercelConversation(
        {
          run_id: "run-remote",
          session_id: "session-remote",
          base_url: "https://example.invalid/v1",
          model: "remote",
          role: "primary",
          messages: [{ role: "user", content: "no upload" }],
        },
        (event) => events.push(event),
      ),
    /remote runtime is disabled/,
  );
  assert.deepEqual(events, []);
});
