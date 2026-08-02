import type { ParsedAssistant, ToolCall } from "./contract.js";

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonLayers(value: unknown): unknown {
  let current = value;
  for (let index = 0; index < 3 && typeof current === "string"; index += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }
  return current;
}

function normalizedToolCall(value: unknown): ToolCall | null {
  const call = asObject(value);
  const fn = asObject(call.function);
  const name = call.name ?? fn.name;
  if (typeof name !== "string" || !name) return null;
  const input = jsonLayers(call.input ?? call.arguments ?? fn.arguments ?? {});
  return {
    id: typeof call.id === "string" ? call.id : typeof call.tool_call_id === "string" ? call.tool_call_id : null,
    type: "function",
    function: {
      name,
      arguments: typeof input === "string" ? input : JSON.stringify(input),
    },
  };
}

export function parseOpenAiNativeMessage(value: unknown): ParsedAssistant {
  const body = asObject(value);
  const message = asObject(body.message);
  const direct = Object.keys(message).length > 0
    ? message
    : Array.isArray(body.choices) ? {} : body;
  const choice = Array.isArray(body.choices) ? asObject(body.choices[0]) : {};
  const choiceMessage = asObject(choice.message);
  // Precedence is direct message, then the first chat-completion choice.
  // Top-level tool_calls are only used when neither envelope supplies them.
  const candidate = Object.keys(direct).length > 0 ? direct : choiceMessage;
  const toolValues = Array.isArray(direct.tool_calls)
    ? direct.tool_calls
    : Array.isArray(choiceMessage.tool_calls)
      ? choiceMessage.tool_calls
      : Array.isArray(body.tool_calls) ? body.tool_calls : [];
  const toolCalls = toolValues.map(normalizedToolCall);
  const malformed = toolCalls.some((call) => call === null);
  return {
    role: "assistant",
    content: typeof candidate.content === "string" ? candidate.content : "",
    tool_calls: toolCalls.filter((call): call is ToolCall => call !== null),
    ...(malformed ? { malformed: true } : {}),
  };
}

function coerceParameter(value: string): unknown {
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

function malformedCall(index: number): ToolCall {
  return {
    id: `malformed-${index + 1}`,
    type: "function",
    function: { name: "", arguments: "{}" },
  };
}

function parseNemotronToolBlock(block: string, index: number): ToolCall {
  const functionMatch = /^([\s\S]*?)<function=([^>\s]+)>([\s\S]*)<\/function>\s*$/i.exec(block.trim());
  if (!functionMatch) return malformedCall(index);
  const [, prefix, name, parameterText] = functionMatch;
  if (prefix.trim()) return malformedCall(index);
  const parameters: Record<string, unknown> = {};
  const parameterPattern = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = parameterPattern.exec(parameterText)) !== null) {
    const parameterName = match[1];
    if (Object.hasOwn(parameters, parameterName)) return malformedCall(index);
    parameters[parameterName] = coerceParameter(match[2]);
  }
  if (parameterText.replace(/<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/gi, "").trim()) {
    return malformedCall(index);
  }
  if (Object.hasOwn(parameters, "body")
    && (!parameters.body || typeof parameters.body !== "object" || Array.isArray(parameters.body))) {
    return malformedCall(index);
  }
  return {
    id: `nemotron-${index + 1}`,
    type: "function",
    function: { name, arguments: JSON.stringify(parameters) },
  };
}

export function parseNemotronTextMessage(message: unknown): ParsedAssistant {
  const text = typeof (message as { content?: unknown })?.content === "string"
    ? (message as { content: string }).content
    : typeof message === "string" ? message : "";
  const withoutThinking = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "");
  const blocks: Array<{ start: number; end: number; body: string }> = [];
  const blockPattern = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(withoutThinking)) !== null) {
    blocks.push({ start: match.index, end: blockPattern.lastIndex, body: match[1] });
  }
  const unterminatedStart = withoutThinking.search(/<tool_call>/i);
  if (unterminatedStart >= 0 && !blocks.some((block) => block.start === unterminatedStart)) {
    blocks.push({
      start: unterminatedStart,
      end: withoutThinking.length,
      body: withoutThinking.slice(unterminatedStart + "<tool_call>".length),
    });
  }
  const toolCalls = blocks.map((block, index) => parseNemotronToolBlock(block.body, index));
  let content = withoutThinking;
  for (const block of [...blocks].sort((left, right) => right.start - left.start)) {
    content = `${content.slice(0, block.start)}${content.slice(block.end)}`;
  }
  const assistant: ParsedAssistant = { role: "assistant", content: content.trim(), tool_calls: toolCalls };
  if (toolCalls.some((call) => !call.function.name)) assistant.malformed = true;
  return assistant;
}

export function parseAssistantMessage(protocol: "nemotron-text" | "openai-native" | "json-text", value: unknown): ParsedAssistant {
  if (protocol === "nemotron-text") return parseNemotronTextMessage(value);
  if (protocol === "openai-native") return parseOpenAiNativeMessage(value);
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  try {
    return parseOpenAiNativeMessage(JSON.parse(raw));
  } catch {
    return { role: "assistant", content: raw, tool_calls: [], malformed: true };
  }
}
