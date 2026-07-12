import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  conversationRuntimeStatus,
  installConversationRuntime,
  startConversationRuntime,
  stopConversationRuntime,
} from "../dist/runtime/conversation/lifecycle.js";
import { runVercelConversation } from "../dist/runtime/conversation/vercel-runtime.js";
import { validateRuntimeTrace } from "../dist/runtime/conversation/contract.js";
import { runConversationConformance } from "../dist/runtime/conversation/conformance.js";

const runtimeHome = mkdtempSync(join(tmpdir(), "understudy-conversation-runtime-"));

before(() => {
  process.env.UNDERSTUDY_CONVERSATION_RUNTIME_HOME = runtimeHome;
});
after(async () => {
  await stopConversationRuntime().catch(() => {});
  rmSync(runtimeHome, { recursive: true, force: true });
  delete process.env.UNDERSTUDY_CONVERSATION_RUNTIME_HOME;
});

test("CLI lifecycle installs, starts, diagnoses, and stops the packaged sidecar", async () => {
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

  const probed = await conversationRuntimeStatus();
  assert.equal(probed.healthy, true);

  const stopped = await stopConversationRuntime();
  assert.equal(stopped.running, false);
  assert.equal(stopped.healthy, false);
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
            delta: { role: "assistant", content: "hello back" },
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
        messages: [{ role: "user", content: "hello" }],
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

test("packaged immutable suite passes hashes and canonical trace gates", () => {
  const report = runConversationConformance();
  assert.equal(report.passed, true);
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
