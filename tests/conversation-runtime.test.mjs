import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import {
  executeFrozenConformanceScenario,
  runConversationAdapterConformance,
  runConversationConformance,
  validateScenarioEvidence,
} from "../dist/runtime/conversation/conformance.js";

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

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "dist", "bin.js"), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
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

test("Pi runtime deterministically interrupts a student and continues with the teacher", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await requestJson(request);
    requests.push(body);
    if (body.model === "supervisor-model") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "interrupt: Paris was placed in the wrong country.",
              },
              logprobs: {
                content: [
                  {
                    token: "interrupt",
                    logprob: -0.01,
                    top_logprobs: [
                      { token: "interrupt", logprob: -0.01 },
                      { token: "continue", logprob: -4.5 },
                    ],
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        }),
      );
      return;
    }
    if (body.model === "student-model") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-supervised-student",
          object: "chat.completion.chunk",
          created: 1,
          model: "student-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Paris is in Germany." },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      setTimeout(() => {
        if (response.destroyed) return;
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-supervised-student",
            object: "chat.completion.chunk",
            created: 1,
            model: "student-model",
            choices: [
              { index: 0, delta: { content: " This must not survive." }, finish_reason: null },
            ],
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      }, 250);
      return;
    }
    assert.equal(body.model, "teacher-model");
    sendFixtureSse(response, [
      {
        id: "chatcmpl-supervised-teacher",
        object: "chat.completion.chunk",
        created: 1,
        model: "teacher-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: " Correction: Paris is in France." },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-supervised-teacher",
        object: "chat.completion.chunk",
        created: 1,
        model: "teacher-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
      },
    ]);
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const events = [];
  try {
    await runPiConversation(
      {
        run_id: "run-managed-pi-supervision",
        session_id: "session-managed-pi-supervision",
        base_url: baseUrl,
        model: "student-model",
        role: "student",
        messages: [{ role: "user", content: "Which country contains Paris?" }],
        tools: [],
        runtime_backend: "pi",
        supervision: {
          student: { base_url: baseUrl, model: "student-model" },
          supervisor: {
            base_url: baseUrl,
            model: "supervisor-model",
            system_prompt: "Judge the partial answer and interrupt factual errors.",
            max_output_tokens: 24,
          },
          teacher: { base_url: baseUrl, model: "teacher-model" },
          boundary_chars: 10,
          max_nudges: 0,
        },
      },
      (event) => events.push(event),
    );
  } finally {
    await new Promise((accept) => server.close(accept));
  }
  assert.equal(
    events.filter((event) => event.event === "delta").map((event) => event.data.text).join(""),
    "Paris is in Germany. Correction: Paris is in France.",
  );
  assert.equal(events.some((event) => event.event === "cancellation"), false);
  const verdict = events.find((event) => event.event === "supervisor_verdict");
  const interruption = events.find((event) => event.event === "student_interruption");
  const continuation = events.find((event) => event.event === "teacher_continuation");
  assert.equal(verdict.data.verdict, "interrupt");
  assert.equal(verdict.data.probability_kind, "logprob");
  assert.equal(interruption.data.partial_text, "Paris is in Germany.");
  assert.equal(interruption.data.marker_id, verdict.data.marker_id);
  assert.equal(continuation.data.marker_id, verdict.data.marker_id);
  assert.deepEqual(
    events.filter((event) => event.event === "usage").map((event) => event.data.role),
    ["supervisor", "student", "teacher"],
  );
  assert.match(JSON.stringify(requests.at(-1).messages), /Paris is in Germany/);
  validateRuntimeTrace(events);
});

test("Pi supervision turns a user abort during a judge check into canonical cancellation", async () => {
  const server = createServer(async (request, response) => {
    const body = await requestJson(request);
    if (body.model === "supervisor-model") {
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "continue" } }],
            usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
          }),
        );
      }, 500);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-supervised-cancel",
        object: "chat.completion.chunk",
        created: 1,
        model: "student-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "partial under review ".repeat(20) },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    setTimeout(() => {
      if (!response.destroyed) response.end("data: [DONE]\n\n");
    }, 1_000);
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const controller = new AbortController();
  const events = [];
  let cancelScheduled = false;
  try {
    await runPiConversation(
      {
        run_id: "run-supervised-user-cancel",
        session_id: "session-supervised-user-cancel",
        base_url: baseUrl,
        model: "student-model",
        role: "student",
        messages: [{ role: "user", content: "Generate until stopped." }],
        tools: [],
        runtime_backend: "pi",
        supervision: {
          student: { base_url: baseUrl, model: "student-model" },
          supervisor: {
            base_url: baseUrl,
            model: "supervisor-model",
            system_prompt: "Judge the partial answer.",
            max_output_tokens: 24,
          },
          teacher: { base_url: baseUrl, model: "teacher-model" },
          boundary_chars: 50,
          max_nudges: 0,
        },
      },
      (event) => {
        events.push(event);
        if (event.event === "delta" && !cancelScheduled) {
          cancelScheduled = true;
          setTimeout(() => controller.abort("supervised_user_cancel"), 25);
        }
      },
      controller.signal,
    );
  } finally {
    await new Promise((accept) => server.close(accept));
  }
  assert.ok(events.some((event) => event.event === "delta"));
  assert.equal(events.some((event) => event.event === "error"), false);
  assert.equal(events.at(-1).event, "cancellation");
  assert.equal(events.at(-1).data.reason, "supervised_user_cancel");
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
  assert.equal(events.at(-1).data.reason, "deterministic_test_cancel");
  validateRuntimeTrace(events);
});

test("managed sidecar DELETE cancels the exact Pi run and preserves its partial", async () => {
  const provider = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-sidecar-cancel",
        object: "chat.completion.chunk",
        created: 1,
        model: "sidecar-cancel-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "partial from exact run" },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    setTimeout(() => {
      if (response.destroyed) return;
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-sidecar-cancel",
          object: "chat.completion.chunk",
          created: 1,
          model: "sidecar-cancel-model",
          choices: [
            { index: 0, delta: { content: " must not arrive" }, finish_reason: null },
          ],
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    }, 500);
  });
  await new Promise((accept) => provider.listen(0, "127.0.0.1", accept));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress !== "string");
  const runId = "run-sidecar-delete-cancel";
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
        run_id: runId,
        session_id: "session-sidecar-delete-cancel",
        base_url: `http://127.0.0.1:${providerAddress.port}/v1`,
        model: "sidecar-cancel-model",
        role: "primary",
        messages: [{ role: "user", content: "Start and wait." }],
        tools: [],
        runtime_backend: "pi",
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buffered = "";
    while (!events.some((event) => event.event === "delta")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      buffered += decoder.decode(chunk.value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) events.push(JSON.parse(line));
    }

    const cancelled = await fetch(
      `${status.base_url}/v1/runs/${encodeURIComponent(runId)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { status: "cancelling", run_id: runId });

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) events.push(JSON.parse(line));
    }
    buffered += decoder.decode();
    if (buffered.trim()) events.push(JSON.parse(buffered));

    assert.equal(
      events.filter((event) => event.event === "delta").map((event) => event.data.text).join(""),
      "partial from exact run",
    );
    assert.equal(events.at(-1).event, "cancellation");
    assert.equal(events.at(-1).data.reason, "cancelled_by_client");
    validateRuntimeTrace(events);
  } finally {
    await stopConversationRuntime().catch(() => {});
    await new Promise((accept) => provider.close(accept));
  }
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

test("Pi and Vercel execute the identical frozen conformance inputs", async () => {
  const toolToken = "conformance-tool-token-".padEnd(64, "c");
  process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN = toolToken;
  const providerRequests = [];
  const toolRequests = [];
  const malformedCallsByModel = new Map();
  const longCallsByModel = new Map();
  const restartRequestsByModel = new Map();
  const traces = new Map();
  const provider = createServer(async (request, response) => {
    const body = await requestJson(request);
    if (request.url === "/tool") {
      assert.equal(request.headers.authorization, `Bearer ${toolToken}`);
      toolRequests.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: { status: "healthy", local: true } }));
      return;
    }

    assert.equal(request.url, "/v1/chat/completions");
    providerRequests.push(body);
    const serialized = JSON.stringify(body.messages);
    if (body.model.endsWith("supervisor-takeover-judge")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "interrupt: Paris was placed in the wrong country.",
              },
              logprobs: {
                content: [
                  {
                    token: "interrupt",
                    logprob: -0.01,
                    top_logprobs: [
                      { token: "interrupt", logprob: -0.01 },
                      { token: "continue", logprob: -4.5 },
                    ],
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        }),
      );
      return;
    }
    if (body.model.endsWith("supervisor-takeover-student")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-conformance-supervised-student",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Paris is in Germany." },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      setTimeout(() => {
        if (response.destroyed) return;
        response.end("data: [DONE]\n\n");
      }, 250);
      return;
    }
    if (body.model.endsWith("supervisor-takeover-teacher")) {
      sendFixtureSse(response, [
        {
          id: "chatcmpl-conformance-supervised-teacher",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: " Correction: Paris is in France." },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl-conformance-supervised-teacher",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
        },
      ]);
      return;
    }
    if (serialized.includes("Begin a detailed response")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-conformance-cancel",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "partial frozen output" },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      setTimeout(() => {
        if (response.destroyed) return;
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-conformance-cancel",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              { index: 0, delta: { content: " late output" }, finish_reason: null },
            ],
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      }, 250);
      return;
    }

    if (serialized.includes("malformed arguments must never execute")) {
      const malformedCall = (malformedCallsByModel.get(body.model) ?? 0) + 1;
      malformedCallsByModel.set(body.model, malformedCall);
      if (malformedCall > 1) {
        sendFixtureSse(response, [
          {
            id: "chatcmpl-conformance-malformed-final",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: "The malformed request was rejected without execution.",
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-conformance-malformed-final",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
          },
        ]);
      } else {
        sendFixtureSse(response, [
          {
            id: "chatcmpl-conformance-malformed",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-conformance-malformed",
                      type: "function",
                      function: { name: "status", arguments: "{bad" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-conformance-malformed",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
          },
        ]);
      }
      return;
    }

    if (
      body.model.includes("long-chat-compaction") ||
      serialized.includes("Architecture note seven")
    ) {
      const longCall = (longCallsByModel.get(body.model) ?? 0) + 1;
      longCallsByModel.set(body.model, longCall);
      if (longCall === 1) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "maximum context length exceeded",
              type: "invalid_request_error",
              code: "context_length_exceeded",
            },
          }),
        );
        return;
      }
      sendFixtureSse(response, [
        {
          id: `chatcmpl-conformance-long-${longCall}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content:
                  longCall === 2
                    ? "The desktop owns presentation and consent; the runtime owns ordered events; the evidence ledger owns attribution."
                    : "The owners are the desktop, runtime, and evidence ledger.",
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: `chatcmpl-conformance-long-${longCall}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 300, completion_tokens: 15, total_tokens: 315 },
        },
      ]);
      return;
    }

    if (serialized.includes("durable fact")) {
      const requests = restartRequestsByModel.get(body.model) ?? [];
      requests.push(body);
      restartRequestsByModel.set(body.model, requests);
      const first = requests.length === 1;
      sendFixtureSse(response, [
        {
          id: `chatcmpl-conformance-restart-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: first ? "The durable fact is seven." : "The fact remains seven.",
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: `chatcmpl-conformance-restart-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: first ? 6 : 12, completion_tokens: 5, total_tokens: first ? 11 : 17 },
        },
      ]);
      return;
    }

    if (serialized.includes("Read the local runtime status")) {
      if (serialized.includes("healthy")) {
        sendFixtureSse(response, [
          {
            id: "chatcmpl-conformance-tool-final",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "The local runtime is healthy." },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-conformance-tool-final",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
          },
        ]);
      } else {
        sendFixtureSse(response, [
          {
            id: "chatcmpl-conformance-tool",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-conformance-status",
                      type: "function",
                      function: { name: "status", arguments: '{"query":"runtime"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-conformance-tool",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
          },
        ]);
      }
      return;
    }

    const isImage = serialized.includes("Describe the attached one-pixel image");
    if (isImage) assert.match(serialized, /data:image\/png;base64,/);
    sendFixtureSse(response, [
      {
        id: `chatcmpl-conformance-${isImage ? "image" : "basic"}`,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: isImage ? "The local image is one pixel." : "The local fixture passed.",
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: `chatcmpl-conformance-${isImage ? "image" : "basic"}`,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      },
    ]);
  });
  await new Promise((accept) => provider.listen(0, "127.0.0.1", accept));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const toolUrl = `http://127.0.0.1:${address.port}/tool`;

  const adapter = (id, runtimeBackend, run, capabilities = []) => ({
    id,
    capabilities,
    async run(input) {
      const events = await executeFrozenConformanceScenario(input, run, {
        backend: runtimeBackend,
        base_url: baseUrl,
        model: `conformance-${id}-${input.fixture_id}`,
        invocation_id: id,
        scenario_timeout_ms: 5_000,
        tool_executor_url: toolUrl,
        student: {
          base_url: baseUrl,
          model: `conformance-${id}-supervisor-takeover-student`,
        },
        supervisor: {
          base_url: baseUrl,
          model: `conformance-${id}-supervisor-takeover-judge`,
        },
        teacher: {
          base_url: baseUrl,
          model: `conformance-${id}-supervisor-takeover-teacher`,
        },
      });
      traces.set(`${id}:${input.fixture_id}`, events);
      return events;
    },
  });

  try {
    const reports = [];
    for (const candidate of [
      adapter("pi", "pi", runPiConversation, ["compaction", "restart", "supervision"]),
      adapter("vercel", "vercel", runVercelConversation),
    ]) {
      reports.push(await runConversationAdapterConformance(candidate));
    }
    assert.deepEqual(reports.map((report) => report.adapter_id), ["pi", "vercel"]);
    assert.ok(reports.every((report) => report.passed), JSON.stringify(reports, null, 2));
    assert.ok(
      reports.every(
        (report) =>
          report.scenarios.map((scenario) => scenario.id).join(",") ===
          "basic-chat,offline-image,tool-round,malformed-tool-call,supervisor-takeover,long-chat-compaction,restart-resume,cancellation",
      ),
    );
    assert.ok(
      reports.every(
        (report) =>
          report.scenarios.find((scenario) => scenario.id === "cancellation")?.status ===
          "passed",
      ),
    );
    const cancellationSummary = reports[0].scenarios.find(
      (scenario) => scenario.id === "cancellation",
    );
    assert.deepEqual(cancellationSummary?.observed_events, [
      "message",
      "delta",
      "usage",
      "cancellation",
    ]);
    assert.deepEqual(cancellationSummary?.observed_event_counts, {
      message: 1,
      delta: 1,
      usage: 1,
      cancellation: 1,
    });
    assert.equal(toolRequests.length, 2);
    assert.ok(
      providerRequests
        .filter((request) => !request.model.endsWith("supervisor-takeover-judge"))
        .every((request) => request.stream === true),
    );
    assert.ok(
      providerRequests.some(
        (request) =>
          request.model.endsWith("supervisor-takeover-judge") && request.stream === false,
      ),
    );
    assert.equal(reports[0].eligible_for_promotion, true);
    assert.equal(reports[1].complete, false);
    assert.equal(
      reports[1].scenarios.find((scenario) => scenario.id === "long-chat-compaction")?.status,
      "not_applicable",
    );
    assert.equal(
      reports[1].scenarios.find((scenario) => scenario.id === "restart-resume")?.status,
      "not_applicable",
    );
    assert.equal(
      reports[1].scenarios.find((scenario) => scenario.id === "supervisor-takeover")?.status,
      "not_applicable",
    );
    const longChat = traces.get("pi:long-chat-compaction");
    assert.ok(longChat);
    assert.equal(longChat.some((event) => event.event === "error"), false);
    const boundary = longChat.find((event) => event.event === "compaction_boundary");
    assert.ok(boundary);
    assert.ok(boundary.data.source_message_count >= boundary.data.retained_message_count);
    assert.ok(boundary.data.estimated_tokens_before > boundary.data.estimated_tokens_after);
    assert.match(boundary.data.summary_sha256, /^[0-9a-f]{64}$/);
    assert.ok((longCallsByModel.get("conformance-pi-long-chat-compaction") ?? 0) >= 3);
    assert.equal(
      longChat
        .filter((event) => event.event === "delta")
        .map((event) => event.data.text)
        .join(""),
      "The owners are the desktop, runtime, and evidence ledger.",
    );
    const longUsages = longChat.filter((event) => event.event === "usage");
    assert.equal(longUsages[0].data.source, "unavailable");
    assert.equal(longUsages[0].data.complete, false);
    const longUsage = longUsages.at(-1);
    assert.ok(longUsage);
    assert.equal(longUsage.data.source, "provider");
    assert.equal(longUsage.data.complete, true);
    const restartRequests = restartRequestsByModel.get("conformance-pi-restart-resume");
    assert.equal(restartRequests?.length, 2);
    assert.match(JSON.stringify(restartRequests[1].messages), /durable fact is seven/i);
    assert.match(JSON.stringify(restartRequests[1].messages), /runtime restarts/i);
    const takeover = traces.get("pi:supervisor-takeover");
    assert.ok(takeover);
    assert.equal(
      takeover
        .filter((event) => event.event === "delta")
        .map((event) => event.data.text)
        .join(""),
      "Paris is in Germany. Correction: Paris is in France.",
    );
    const verdict = takeover.find((event) => event.event === "supervisor_verdict");
    const interruption = takeover.find((event) => event.event === "student_interruption");
    const continuation = takeover.find((event) => event.event === "teacher_continuation");
    assert.equal(verdict.data.verdict, "interrupt");
    assert.equal(verdict.data.probability_kind, "logprob");
    assert.equal(interruption.data.marker_id, verdict.data.marker_id);
    assert.equal(continuation.data.marker_id, verdict.data.marker_id);
    for (const id of ["pi", "vercel"]) {
      const malformed = traces.get(`${id}:malformed-tool-call`);
      assert.ok(malformed);
      assert.ok(
        malformed.some(
          (event) => event.event === "tool_call" && typeof event.data.parse_error === "string",
        ),
        `${id} did not preserve malformed tool parse evidence: ${JSON.stringify(malformed)}`,
      );
      assert.ok(
        malformed.some(
          (event) => event.event === "tool_result" && event.data.ok === false,
        ),
        `${id} did not preserve a failed malformed tool result: ${JSON.stringify(malformed)}`,
      );
      const cancellation = traces.get(`${id}:cancellation`);
      assert.ok(cancellation);
      assert.equal(cancellation.at(-1).event, "cancellation");
      assert.equal(cancellation.at(-1).data.reason, "frozen_conformance_cancel");
      assert.equal(
        cancellation
          .filter((event) => event.event === "delta")
          .map((event) => event.data.text)
          .join(""),
        "partial frozen output",
      );
    }

    const cli = await runCli([
      "runtime",
      "conformance",
      "--backend",
      "pi",
      "--base-url",
      baseUrl,
      "--model",
      "conformance-cli",
      "--student-model",
      "conformance-cli-supervisor-takeover-student",
      "--supervisor-model",
      "conformance-cli-supervisor-takeover-judge",
      "--teacher-model",
      "conformance-cli-supervisor-takeover-teacher",
      "--tool-executor-url",
      toolUrl,
      "--scenario-timeout-ms",
      "5000",
      "--require-complete",
      "--json",
    ]);
    assert.equal(cli.code, 0, `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`);
    const cliReport = JSON.parse(cli.stdout);
    assert.equal(cliReport.adapter_id, "pi");
    assert.equal(cliReport.complete, true);
    assert.equal(cliReport.eligible_for_promotion, true);
    assert.ok(cliReport.scenarios.every((scenario) => scenario.status === "passed"));
  } finally {
    await new Promise((accept) => provider.close(accept));
    delete process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN;
  }
});

test("frozen cancellation rejects a timeout disguised as a successful stop", () => {
  const input = JSON.parse(
    readFileSync(
      new URL(
        "../schemas/conversation-runtime-conformance/inputs/cancellation.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const events = readFileSync(
    new URL("../schemas/conversation-runtime-conformance/cancellation.jsonl", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  events.at(-1).data.reason = "frozen_conformance_cancel";
  assert.doesNotThrow(() => validateScenarioEvidence(input, events));
  events.at(-1).data.reason = "conformance_timeout_1000ms";
  assert.throws(
    () => validateScenarioEvidence(input, events),
    /cancellation reason changed.*conformance_timeout_1000ms/,
  );
});

test("packaged immutable suite passes hashes and canonical trace gates", () => {
  const report = runConversationConformance();
  assert.equal(report.passed, true);
  assert.deepEqual(report.inputs.map((input) => input.id), [
    "basic-chat",
    "offline-image",
    "tool-round",
    "malformed-tool-call",
    "supervisor-takeover",
    "long-chat-compaction",
    "restart-resume",
    "cancellation",
  ]);
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
