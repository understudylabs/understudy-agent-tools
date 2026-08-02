// Experiment notes, receipts, and reproduction commands: ./README.md

import { fireworksCallModel } from "./fireworks-client.mjs";

function coerceParameter(value) {
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && (typeof parsed === "object" || typeof parsed === "number" || typeof parsed === "boolean")
      ? parsed
      : trimmed;
  } catch {
    return trimmed;
  }
}

function malformedCall(index) {
  return {
    id: `malformed-${index + 1}`,
    type: "function",
    function: { name: "", arguments: "{}" },
  };
}

function parseToolBlock(block, index) {
  const functionMatch = /^([\s\S]*?)<function=([^>\s]+)>([\s\S]*)<\/function>\s*$/i.exec(block.trim());
  if (!functionMatch) return malformedCall(index);
  const [, prefix, name, parameterText] = functionMatch;
  if (prefix.trim()) return malformedCall(index);
  const parameters = {};
  const parameterPattern = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/gi;
  let match;
  while ((match = parameterPattern.exec(parameterText)) !== null) {
    const parameterName = match[1];
    if (Object.hasOwn(parameters, parameterName)) return malformedCall(index);
    parameters[parameterName] = coerceParameter(match[2]);
  }
  if (parameterText.replace(/<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/gi, "").trim()) {
    return malformedCall(index);
  }
  if (
    Object.hasOwn(parameters, "body")
    && (!parameters.body || typeof parameters.body !== "object" || Array.isArray(parameters.body))
  ) {
    return malformedCall(index);
  }
  return {
    id: `nemotron-${index + 1}`,
    type: "function",
    function: { name, arguments: JSON.stringify(parameters) },
  };
}

export function parseNemotronTextMessage(message) {
  const text = typeof message?.content === "string" ? message.content : "";
  const withoutThinking = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "");
  const blocks = [];
  const blockPattern = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = blockPattern.exec(withoutThinking)) !== null) blocks.push({ start: match.index, end: blockPattern.lastIndex, body: match[1] });
  const unterminatedStart = withoutThinking.search(/<tool_call>/i);
  if (unterminatedStart >= 0 && !blocks.some((block) => block.start === unterminatedStart)) {
    blocks.push({ start: unterminatedStart, end: withoutThinking.length, body: withoutThinking.slice(unterminatedStart + "<tool_call>".length) });
  }
  const toolCalls = blocks.map((block, index) => parseToolBlock(block.body, index));
  let content = withoutThinking;
  for (const block of [...blocks].sort((left, right) => right.start - left.start)) {
    content = `${content.slice(0, block.start)}${content.slice(block.end)}`;
  }
  const assistant = { role: "assistant", content: content.trim() };
  if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
  return assistant;
}

export function nemotronCallModel({
  model,
  baseUrl,
  maxTokens = 3000,
  temperature = 0,
  timeoutMs,
}) {
  let truncations = 0;
  const baseCallModel = fireworksCallModel({
    model,
    baseUrl,
    maxTokens,
    temperature,
    timeoutMs,
    toolChoice: "none",
  });
  const callModel = async (messages, tools) => {
    const requestContext = {};
    const raw = await baseCallModel(messages, tools, requestContext);
    const assistant = parseNemotronTextMessage(raw);
    if (requestContext.finishReason === "length" && !assistant.tool_calls) truncations += 1;
    return assistant;
  };
  callModel.model = model;
  callModel.usage = baseCallModel.usage;
  callModel.receipts = baseCallModel.receipts;
  Object.defineProperty(callModel, "truncations", { get: () => truncations });
  return callModel;
}
