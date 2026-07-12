import { readFileSync } from "node:fs";

import { parseRuntimeInputFixture } from "../../dist/runtime/conversation/contract.js";

export const basicChatFixture = parseRuntimeInputFixture(
  JSON.parse(
    readFileSync(
      new URL(
        "../../schemas/conversation-runtime-conformance/inputs/basic-chat.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

export const basicChatPrompt = basicChatFixture.messages.find(
  (message) => message.role === "user",
)?.content;

if (typeof basicChatPrompt !== "string" || basicChatPrompt.length === 0) {
  throw new Error("basic-chat fixture has no user prompt");
}
