import assert from "node:assert/strict";
import { createServer } from "node:http";

import { validateRuntimeTrace } from "../../dist/runtime/conversation/contract.js";
import { runVercelConversation } from "../../dist/runtime/conversation/vercel-runtime.js";
import { basicChatFixture } from "./shared-input.mjs";

const requests = [];
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  requests.push(JSON.parse(raw));
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [
    {
      id: "chatcmpl-vercel",
      object: "chat.completion.chunk",
      created: 1,
      model: "vercel-local",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Vercel local fixture passed." },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-vercel",
      object: "chat.completion.chunk",
      created: 1,
      model: "vercel-local",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    {
      id: "chatcmpl-vercel",
      object: "chat.completion.chunk",
      created: 1,
      model: "vercel-local",
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
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
      run_id: "run-vercel-basic-chat",
      session_id: "session-vercel-basic-chat",
      base_url: `http://127.0.0.1:${address.port}/v1`,
      model: "vercel-local",
      role: basicChatFixture.role,
      messages: basicChatFixture.messages,
      tools: basicChatFixture.tools,
    },
    (event) => events.push(event),
  );
  validateRuntimeTrace(events);
  assert.equal(requests.length, 1);
  const request = requests[0];
  process.stdout.write(
    `${JSON.stringify(
      {
        contender: "ai@6.0.224",
        passed: true,
        model_request_count: requests.length,
        requested_tool_count: request.tools?.length ?? 0,
        injected_system_message_count: request.messages.filter(
          (message) => message.role === "system",
        ).length,
        canonical_events: events.map((event) => event.event),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await new Promise((accept) => server.close(accept));
}
