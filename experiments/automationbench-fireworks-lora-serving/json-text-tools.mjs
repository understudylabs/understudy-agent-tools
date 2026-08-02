import { fireworksCallModel } from "./fireworks-client.mjs";

export const JSON_TEXT_FORMAT_INSTRUCTION = [
  "Use only these fixture tools:",
  "api_search arguments JSON schema:",
  "{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"},\"top_k\":{\"type\":\"number\"}},\"required\":[\"query\"],\"additionalProperties\":false}",
  "api_fetch arguments JSON schema:",
  "{\"type\":\"object\",\"properties\":{\"method\":{\"type\":\"string\"},\"url\":{\"type\":\"string\"},\"body\":{\"type\":\"object\"}},\"required\":[\"method\",\"url\"],\"additionalProperties\":false}",
  "Reply with exactly one fenced ```json block and nothing else.",
  "For a tool call, the JSON object must be {\"tool\":\"api_search\"|\"api_fetch\",\"arguments\":{...}}.",
  "When the task is complete, reply with {\"tool\":\"done\"}.",
].join("\n");

function balancedObjects(text) {
  const candidates = [];
  for (let start = text.length - 1; start >= 0; start -= 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") quoted = false;
        continue;
      }
      if (character === "\"") quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function extractLastJson(text) {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (fenced.length > 0) return fenced.at(-1)[1].trim();
  const candidates = balancedObjects(text);
  return candidates.find((candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.tool === "string";
    } catch {
      return false;
    }
  }) ?? candidates[0];
}

export function parseJsonTextMessage(content) {
  const raw = typeof content === "string" ? content : "";
  const source = extractLastJson(raw);
  if (!source) {
    return {
      assistant: { role: "assistant", content: raw },
      malformed: true,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return {
      assistant: { role: "assistant", content: raw },
      malformed: true,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.tool !== "string") {
    return {
      assistant: { role: "assistant", content: raw },
      malformed: true,
    };
  }
  if (parsed.tool === "done") {
    return { assistant: { role: "assistant", content: raw }, malformed: false };
  }
  if (!["api_search", "api_fetch"].includes(parsed.tool)
    || !parsed.arguments
    || typeof parsed.arguments !== "object"
    || Array.isArray(parsed.arguments)) {
    return {
      assistant: { role: "assistant", content: raw },
      malformed: true,
    };
  }
  return {
    assistant: {
      role: "assistant",
      content: raw,
      tool_calls: [{
        id: "json-text-1",
        type: "function",
        function: {
          name: parsed.tool,
          arguments: JSON.stringify(parsed.arguments),
        },
      }],
    },
    malformed: false,
  };
}

function instructedMessages(messages) {
  const index = messages.findIndex((message) => message.role === "system");
  if (index < 0) return [{ role: "system", content: JSON_TEXT_FORMAT_INSTRUCTION }, ...messages];
  return messages.map((message, messageIndex) => messageIndex === index
    ? {
        ...message,
        content: `${JSON_TEXT_FORMAT_INSTRUCTION}\n\n${message.content}\n\n${JSON_TEXT_FORMAT_INSTRUCTION}`,
      }
    : message);
}

export function jsonTextCallModel({ model, baseUrl, maxTokens = 1024, temperature = 0, timeoutMs }) {
  const baseCallModel = fireworksCallModel({
    model,
    baseUrl,
    maxTokens,
    temperature,
    timeoutMs,
    toolChoice: "none",
  });
  const callModel = async (messages, tools) => {
    const raw = await baseCallModel(instructedMessages(messages), tools);
    const parsed = parseJsonTextMessage(raw.content);
    return { ...parsed.assistant, malformed: parsed.malformed };
  };
  callModel.model = model;
  callModel.usage = baseCallModel.usage;
  callModel.receipts = baseCallModel.receipts;
  return callModel;
}
