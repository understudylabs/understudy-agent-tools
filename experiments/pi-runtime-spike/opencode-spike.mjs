import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { basicChatPrompt } from "./shared-input.mjs";

const requests = [];
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  requests.push(JSON.parse(raw));
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [
    {
      id: "chatcmpl-opencode",
      object: "chat.completion.chunk",
      created: 1,
      model: "opencode-local",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "OpenCode local fixture passed." },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-opencode",
      object: "chat.completion.chunk",
      created: 1,
      model: "opencode-local",
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

const root = mkdtempSync(join(tmpdir(), "understudy-opencode-spike-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
const config = {
  $schema: "https://opencode.ai/config.json",
  model: "fixture/opencode-local",
  provider: {
    fixture: {
      npm: "@ai-sdk/openai-compatible",
      name: "Understudy local fixture",
      options: {
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "local-fixture-key",
      },
      models: {
        "opencode-local": {
          name: "OpenCode local fixture",
          limit: { context: 32_768, output: 8_192 },
        },
      },
    },
  },
  permission: { "*": "deny" },
  agent: {
    understudy: {
      description: "Understudy provider-neutral conversation runtime spike",
      mode: "primary",
      model: "fixture/opencode-local",
      prompt: "You are the Understudy conversation runtime. Answer ordinary chat directly.",
      permission: { "*": "deny" },
    },
  },
};

try {
  const child = spawn(
    process.env.OPENCODE_BIN || "opencode",
    [
      "run",
      basicChatPrompt,
      "--agent",
      "understudy",
      "--model",
      "fixture/opencode-local",
      "--format",
      "json",
      "--pure",
      "--dir",
      cwd,
    ],
    {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise((accept) => child.once("close", accept));
  assert.equal(exitCode, 0, stderr || stdout);
  if (process.env.OPENCODE_DEBUG === "1") {
    process.stderr.write(`${JSON.stringify({ requests, stdout, stderr }, null, 2)}\n`);
  }
  assert.ok(requests.length >= 1);
  const request = requests.find((candidate) =>
    candidate.messages?.some(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("Understudy conversation runtime"),
    ),
  );
  assert.ok(request, "OpenCode did not send the user prompt to the local fixture");
  const systemMessages = request.messages.filter((message) => message.role === "system");
  assert.ok(systemMessages.length > 0);
  process.stdout.write(
    `${JSON.stringify(
      {
        contender: "opencode@1.17.15",
        passed: true,
        model_request_count: requests.length,
        auxiliary_model_request_count: requests.length - 1,
        requested_tool_count: request.tools?.length ?? 0,
        injected_environment_context: systemMessages.some((message) =>
          message.content.includes("Working directory:"),
        ),
        custom_prompt_present: systemMessages.some((message) =>
          message.content.includes("Understudy conversation runtime"),
        ),
        event_types: stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line).type),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await new Promise((accept) => server.close(accept));
  rmSync(root, { recursive: true, force: true });
}
