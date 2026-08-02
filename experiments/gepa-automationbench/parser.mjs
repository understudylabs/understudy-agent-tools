import { parseToolCalls as parseRecordedToolCalls } from "../../dist/automationbench-offline.js";

function cleanReasoning(text) {
  const lastClosing = text.lastIndexOf("</think>");
  if (lastClosing >= 0) return text.slice(lastClosing + "</think>".length).trim();
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function coerceParameter(raw) {
  const value = raw.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  if (value === "null") return null;
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
    try { return JSON.parse(value); } catch { /* retain raw text for non-JSON string values */ }
  }
  return value;
}

function parseXmlCall(block) {
  const functionMatch = block.match(/<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/i);
  if (!functionMatch) throw new Error("malformed Nemotron XML function call");
  const args = {};
  for (const match of functionMatch[2].matchAll(/<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gi)) {
    args[match[1]] = coerceParameter(match[2]);
  }
  return { name: functionMatch[1], arguments: args };
}

export function parseModelToolCallsDetailed(message) {
  const text = typeof message === "string" ? message : (message?.content || message?.reasoning_content);
  if (typeof text === "string") {
    const cleaned = cleanReasoning(text);
    const blocks = [...cleaned.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)];
    const selected = blocks.at(-1);
    if (selected) {
      const inner = selected[1].trim();
      const xmlCall = /<function=/i.test(inner);
      const calls = xmlCall
        ? [parseXmlCall(inner)]
        : parseRecordedToolCalls({ tool_calls: [JSON.parse(inner)] });
      return { calls, encoding: xmlCall ? "xml" : "json-text", blockCount: blocks.length, usedLastBlock: blocks.length > 1 };
    }
    if (/<tool_call\b/i.test(cleaned)) throw new Error("malformed tool_call text");
  }
  const calls = parseRecordedToolCalls(message);
  return { calls, encoding: calls.length ? "openai-native" : "none", blockCount: 0, usedLastBlock: false };
}

export function parseModelToolCalls(message) {
  return parseModelToolCallsDetailed(message).calls;
}

export function isFinishSignal(message) {
  const text = typeof message === "string" ? message : (message?.content || message?.reasoning_content);
  return typeof text === "string" && /<finish\s*\/>/i.test(cleanReasoning(text));
}
