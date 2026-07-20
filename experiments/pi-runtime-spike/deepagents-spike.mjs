import assert from "node:assert/strict";
import { createServer } from "node:http";

import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";

import { basicChatPrompt } from "./shared-input.mjs";

const requests = [];
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  const body = JSON.parse(raw);
  requests.push(body);
  if (body.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-deepagents",
        object: "chat.completion",
        created: 1,
        model: "deepagents-local",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Deep Agents local fixture passed." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [
    {
      id: "chatcmpl-deepagents",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepagents-local",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Deep Agents local fixture passed." },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-deepagents",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepagents-local",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
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

try {
  const model = new ChatOpenAI({
    model: "deepagents-local",
    apiKey: "local-fixture-key",
    maxRetries: 0,
    configuration: { baseURL: `http://127.0.0.1:${address.port}/v1` },
  });
  const agent = createDeepAgent({
    model,
    systemPrompt: "You are the Understudy conversation runtime. Answer ordinary chat directly.",
    tools: [],
  });
  const result = await agent.invoke({
    messages: [{ role: "user", content: basicChatPrompt }],
  });
  const last = result.messages.at(-1);
  assert.equal(last?.content, "Deep Agents local fixture passed.");
  assert.equal(requests.length, 1);
  const request = requests[0];
  const systemMessages = request.messages.filter((message) => message.role === "system");
  assert.ok(systemMessages.length > 0);
  const systemText = systemMessages
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.filter((part) => part.type === "text").map((part) => part.text),
    )
    .join("\n\n");
  assert.match(systemText, /Understudy conversation runtime/);
  assert.match(systemText, /You are a Deep Agent/);
  assert.ok(request.tools.length > 0);
  if (process.env.DEEPAGENTS_DEBUG === "1") {
    process.stderr.write(`${JSON.stringify({ request, result }, null, 2)}\n`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        contender: "deepagents@1.10.7",
        passed: true,
        model_request_count: requests.length,
        requested_tool_names: request.tools.map((tool) => tool.function.name),
        system_prompt_chars: systemText.length,
        injected_deep_agent_policy: systemText.includes("You are a Deep Agent"),
        custom_prompt_present: systemText.includes("Understudy conversation runtime"),
        usage: last?.usage_metadata,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await new Promise((accept) => server.close(accept));
}
