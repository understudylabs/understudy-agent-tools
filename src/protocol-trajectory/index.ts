import { createHash } from "node:crypto";

export type JsonSchema = boolean | { [key: string]: unknown };

export type CanonicalTextPart = { type: "text"; text: string };
export type CanonicalToolCallPart = {
  type: "tool_call";
  id: string;
  name: string;
  arguments: unknown;
  raw_arguments?: string;
};
export type CanonicalToolResultPart = {
  type: "tool_result";
  call_id: string;
  name?: string;
  content: unknown;
  is_error: boolean;
};
export type CanonicalPart = CanonicalTextPart | CanonicalToolCallPart | CanonicalToolResultPart;

export type CanonicalTurn = {
  role: "user" | "assistant" | "tool";
  parts: CanonicalPart[];
};

export type CanonicalToolDefinition = {
  name: string;
  description?: string;
  input_schema: JsonSchema;
};

export type CanonicalTrajectory = {
  schema_version: "understudy.tool_trajectory.v1";
  system: CanonicalPart[];
  messages: CanonicalTurn[];
  tools: CanonicalToolDefinition[];
};

export type CanonicalAssistantResponse = {
  role: "assistant";
  parts: Array<CanonicalTextPart | CanonicalToolCallPart>;
  stop_reason: "tool_calls" | "end_turn" | "length" | "content_filter" | "other" | null;
};

export class ProtocolTrajectoryError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ProtocolTrajectoryError";
    this.code = code;
    this.details = details;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolTrajectoryError("invalid_shape", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolTrajectoryError("invalid_shape", `${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ProtocolTrajectoryError("invalid_shape", `${label} must be a string`);
  return value;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function canonicalToolCatalogFingerprint(tools: CanonicalToolDefinition[]): string {
  return fingerprint(normalizeTools(tools));
}

export function canonicalTrajectoryFingerprint(trajectory: CanonicalTrajectory): string {
  validateTrajectory(trajectory);
  return fingerprint({ ...trajectory, tools: normalizeTools(trajectory.tools) });
}

function decodePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) {
    throw new ProtocolTrajectoryError("external_schema_ref", `Only local JSON Schema refs are supported: ${ref}`);
  }
  let current = root;
  for (const token of ref.slice(2).split("/").map(decodePointerToken)) {
    if (current === null || typeof current !== "object" || !(token in current)) {
      throw new ProtocolTrajectoryError("missing_schema_ref", `Unresolved local JSON Schema ref: ${ref}`);
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export function dereferenceLocalJsonSchema(schema: JsonSchema): JsonSchema {
  const root = schema;
  const visit = (value: unknown, refs: Set<string>): unknown => {
    if (Array.isArray(value)) return value.map((entry) => visit(entry, refs));
    if (value === null || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    if ("$ref" in source) {
      const ref = string(source.$ref, "JSON Schema $ref");
      if (refs.has(ref)) throw new ProtocolTrajectoryError("cyclic_schema_ref", `Cyclic JSON Schema ref: ${ref}`);
      const siblings = Object.fromEntries(Object.entries(source).filter(([key]) => key !== "$ref"));
      const target = visit(resolvePointer(root, ref), new Set([...refs, ref]));
      if (Object.keys(siblings).length === 0) return target;
      if (target === null || typeof target !== "object" || Array.isArray(target)) {
        throw new ProtocolTrajectoryError("invalid_schema_ref", `Cannot merge sibling keywords into ${ref}`);
      }
      return { ...(target as Record<string, unknown>), ...(visit(siblings, refs) as Record<string, unknown>) };
    }
    return Object.fromEntries(Object.entries(source).map(([key, entry]) => [key, visit(entry, refs)]));
  };
  const result = visit(schema, new Set());
  return result as JsonSchema;
}

function normalizeTools(tools: CanonicalToolDefinition[]): CanonicalToolDefinition[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    if (!tool.name || names.has(tool.name)) {
      throw new ProtocolTrajectoryError("invalid_tool_catalog", `Tool names must be non-empty and unique: ${tool.name}`);
    }
    names.add(tool.name);
    return { ...tool, input_schema: dereferenceLocalJsonSchema(tool.input_schema) };
  });
}

export function validateTrajectory(trajectory: CanonicalTrajectory): void {
  if (trajectory.schema_version !== "understudy.tool_trajectory.v1") {
    throw new ProtocolTrajectoryError("invalid_schema_version", "Unsupported canonical trajectory schema version");
  }
  normalizeTools(trajectory.tools);
  if (trajectory.system.some((part) => part.type !== "text")) {
    throw new ProtocolTrajectoryError("invalid_system_part", "Canonical system content may contain only text parts");
  }
  const seenCalls = new Set<string>();
  let pending: string[] = [];
  for (const turn of trajectory.messages) {
    if (turn.role === "assistant") {
      if (turn.parts.some((part) => part.type === "tool_result")) throw new ProtocolTrajectoryError("invalid_turn_part", "Assistant turns cannot contain tool results");
      if (pending.length) throw new ProtocolTrajectoryError("dropped_tool_result", `Missing results for: ${pending.join(", ")}`);
      pending = turn.parts.filter((part): part is CanonicalToolCallPart => part.type === "tool_call").map((part) => {
        if (!part.id || seenCalls.has(part.id)) throw new ProtocolTrajectoryError("invalid_call_id", `Tool call id must be non-empty and unique: ${part.id}`);
        seenCalls.add(part.id);
        return part.id;
      });
    } else {
      const requiredType = turn.role === "tool" ? "tool_result" : "text";
      if (turn.parts.some((part) => part.type !== requiredType)) throw new ProtocolTrajectoryError("invalid_turn_part", `${turn.role} turns may contain only ${requiredType} parts`);
      for (const part of turn.parts) {
        if (part.type !== "tool_result") continue;
        const expected = pending.shift();
        if (!expected) throw new ProtocolTrajectoryError("orphan_tool_result", `No pending tool call for result ${part.call_id}`);
        if (part.call_id !== expected) {
          throw new ProtocolTrajectoryError("tool_result_order", `Expected result ${expected}, received ${part.call_id}`);
        }
      }
    }
  }
  if (pending.length) throw new ProtocolTrajectoryError("dropped_tool_result", `Missing results for: ${pending.join(", ")}`);
}

function parseOpenAiArguments(raw: unknown, context: string): { arguments: unknown } {
  const rawArguments = string(raw, `${context} arguments`);
  try {
    return { arguments: JSON.parse(rawArguments) };
  } catch (cause) {
    const part: CanonicalToolCallPart = { type: "tool_call", id: "", name: "", arguments: null, raw_arguments: rawArguments };
    throw new ProtocolTrajectoryError("malformed_tool_arguments", `${context} contains malformed JSON arguments`, { raw_arguments: rawArguments, canonical_part: part, cause: String(cause) });
  }
}

function decodeOpenAiToolCall(value: unknown, context: string): CanonicalToolCallPart {
  const call = record(value, context);
  const fn = record(call.function, `${context}.function`);
  try {
    return { type: "tool_call", id: string(call.id, `${context}.id`), name: string(fn.name, `${context}.function.name`), ...parseOpenAiArguments(fn.arguments, context) };
  } catch (error) {
    if (error instanceof ProtocolTrajectoryError && error.code === "malformed_tool_arguments") {
      const details = record(error.details, "malformed argument details");
      details.canonical_part = { type: "tool_call", id: call.id, name: fn.name, arguments: null, raw_arguments: details.raw_arguments };
    }
    throw error;
  }
}

function anthropicContent(value: unknown, context: string): CanonicalPart[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return array(value, context).map((entry, index) => {
    const block = record(entry, `${context}[${index}]`);
    if (block.type === "text") return { type: "text", text: string(block.text, `${context}[${index}].text`) };
    if (block.type === "tool_use") return { type: "tool_call", id: string(block.id, `${context}[${index}].id`), name: string(block.name, `${context}[${index}].name`), arguments: block.input };
    if (block.type === "tool_result") return { type: "tool_result", call_id: string(block.tool_use_id, `${context}[${index}].tool_use_id`), content: block.content, is_error: block.is_error === true };
    throw new ProtocolTrajectoryError("unsupported_content", `Unsupported Anthropic content block: ${String(block.type)}`);
  });
}

function openAiContent(message: Record<string, unknown>, context: string): CanonicalPart[] {
  const parts: CanonicalPart[] = [];
  if (typeof message.content === "string" && message.content.length) parts.push({ type: "text", text: message.content });
  if (Array.isArray(message.content)) {
    for (const [index, value] of message.content.entries()) {
      const block = record(value, `${context}.content[${index}]`);
      if (block.type !== "text") throw new ProtocolTrajectoryError("unsupported_content", `Unsupported OpenAI content part: ${String(block.type)}`);
      parts.push({ type: "text", text: string(block.text, `${context}.content[${index}].text`) });
    }
  }
  if (Array.isArray(message.tool_calls)) message.tool_calls.forEach((call, index) => parts.push(decodeOpenAiToolCall(call, `${context}.tool_calls[${index}]`)));
  return parts;
}

export function decodeAnthropicRequest(body: unknown): CanonicalTrajectory {
  const request = record(body, "Anthropic request");
  const system = request.system === undefined ? [] : anthropicContent(request.system, "system");
  const messages = array(request.messages, "messages").flatMap((value, index): CanonicalTurn[] => {
    const message = record(value, `messages[${index}]`);
    const role = string(message.role, `messages[${index}].role`);
    if (role !== "user" && role !== "assistant") throw new ProtocolTrajectoryError("invalid_role", `Unsupported Anthropic role: ${role}`);
    const parts = anthropicContent(message.content, `messages[${index}].content`);
    if (role === "assistant") return [{ role: "assistant", parts }];
    const results = parts.filter((part): part is CanonicalToolResultPart => part.type === "tool_result");
    const text = parts.filter((part): part is CanonicalTextPart => part.type === "text");
    return [
      ...(results.length ? [{ role: "tool" as const, parts: results }] : []),
      ...(text.length ? [{ role: "user" as const, parts: text }] : []),
    ];
  });
  const tools = (request.tools === undefined ? [] : array(request.tools, "tools")).map((value, index): CanonicalToolDefinition => {
    const tool = record(value, `tools[${index}]`);
    return { name: string(tool.name, `tools[${index}].name`), ...(typeof tool.description === "string" ? { description: tool.description } : {}), input_schema: dereferenceLocalJsonSchema(tool.input_schema as JsonSchema) };
  });
  const trajectory: CanonicalTrajectory = { schema_version: "understudy.tool_trajectory.v1", system, messages, tools };
  validateTrajectory(trajectory);
  return trajectory;
}

export function decodeOpenAIRequest(body: unknown): CanonicalTrajectory {
  const request = record(body, "OpenAI request");
  const system: CanonicalPart[] = [];
  const messages: CanonicalTurn[] = [];
  for (const [index, value] of array(request.messages, "messages").entries()) {
    const message = record(value, `messages[${index}]`);
    const role = string(message.role, `messages[${index}].role`);
    if (role === "system") { system.push(...openAiContent(message, `messages[${index}]`)); continue; }
    if (role === "tool") {
      const part: CanonicalToolResultPart = { type: "tool_result", call_id: string(message.tool_call_id, `messages[${index}].tool_call_id`), content: message.content, is_error: message.is_error === true };
      const previous = messages.at(-1);
      if (previous?.role === "tool") previous.parts.push(part);
      else messages.push({ role: "tool", parts: [part] });
      continue;
    }
    if (role !== "user" && role !== "assistant") throw new ProtocolTrajectoryError("invalid_role", `Unsupported OpenAI role: ${role}`);
    messages.push({ role, parts: openAiContent(message, `messages[${index}]`) });
  }
  const tools = (request.tools === undefined ? [] : array(request.tools, "tools")).map((value, index): CanonicalToolDefinition => {
    const wrapper = record(value, `tools[${index}]`);
    if (wrapper.type !== "function") throw new ProtocolTrajectoryError("invalid_tool_catalog", "Only OpenAI function tools are supported");
    const fn = record(wrapper.function, `tools[${index}].function`);
    return { name: string(fn.name, `tools[${index}].function.name`), ...(typeof fn.description === "string" ? { description: fn.description } : {}), input_schema: dereferenceLocalJsonSchema(fn.parameters as JsonSchema) };
  });
  const trajectory: CanonicalTrajectory = { schema_version: "understudy.tool_trajectory.v1", system, messages, tools };
  validateTrajectory(trajectory);
  return trajectory;
}

function anthropicBlocks(parts: CanonicalPart[]): unknown[] {
  return parts.map((part) => part.type === "text" ? { type: "text", text: part.text } : part.type === "tool_call" ? { type: "tool_use", id: part.id, name: part.name, input: part.arguments } : { type: "tool_result", tool_use_id: part.call_id, content: part.content, ...(part.is_error ? { is_error: true } : {}) });
}

export function encodeAnthropicRequest(trajectory: CanonicalTrajectory, options: Record<string, unknown> = {}): Record<string, unknown> {
  validateTrajectory(trajectory);
  return {
    ...options,
    system: anthropicBlocks(trajectory.system),
    messages: trajectory.messages.map((turn) => ({ role: turn.role === "tool" ? "user" : turn.role, content: anthropicBlocks(turn.parts) })),
    tools: normalizeTools(trajectory.tools).map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), input_schema: tool.input_schema })),
  };
}

function openAiText(parts: CanonicalPart[]): string | Array<{ type: "text"; text: string }> | null {
  const text = parts.filter((part): part is CanonicalTextPart => part.type === "text");
  if (text.length === 0) return null;
  if (text.length === 1) return text[0]!.text;
  return text.map((part) => ({ type: "text", text: part.text }));
}

export function encodeOpenAIRequest(trajectory: CanonicalTrajectory, options: Record<string, unknown> = {}): Record<string, unknown> {
  validateTrajectory(trajectory);
  const messages: unknown[] = [];
  if (trajectory.system.length) messages.push({ role: "system", content: openAiText(trajectory.system) });
  for (const turn of trajectory.messages) {
    if (turn.role === "tool") {
      for (const part of turn.parts) if (part.type === "tool_result") messages.push({ role: "tool", tool_call_id: part.call_id, ...(part.name ? { name: part.name } : {}), content: typeof part.content === "string" ? part.content : stable(part.content), ...(part.is_error ? { is_error: true } : {}) });
      continue;
    }
    const calls = turn.parts.filter((part): part is CanonicalToolCallPart => part.type === "tool_call");
    messages.push({ role: turn.role, content: openAiText(turn.parts), ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.raw_arguments ?? stable(call.arguments) } })) } : {}) });
  }
  return { ...options, messages, tools: normalizeTools(trajectory.tools).map((tool) => ({ type: "function", function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.input_schema } })) };
}

function stopReason(value: unknown): CanonicalAssistantResponse["stop_reason"] {
  if (value === null || value === undefined) return null;
  if (value === "tool_use" || value === "tool_calls") return "tool_calls";
  if (value === "end_turn" || value === "stop") return "end_turn";
  if (value === "max_tokens" || value === "length") return "length";
  if (value === "content_filter") return "content_filter";
  return "other";
}

export function decodeAnthropicResponse(body: unknown): CanonicalAssistantResponse {
  const response = record(body, "Anthropic response");
  return { role: "assistant", parts: anthropicContent(response.content, "content").map((part) => {
    if (part.type === "tool_result") throw new ProtocolTrajectoryError("invalid_response", "Assistant response cannot contain tool results");
    return part;
  }), stop_reason: stopReason(response.stop_reason) };
}

export function decodeOpenAIResponse(body: unknown): CanonicalAssistantResponse {
  const response = record(body, "OpenAI response");
  const choice = record(array(response.choices, "choices")[0], "choices[0]");
  const message = record(choice.message, "choices[0].message");
  return { role: "assistant", parts: openAiContent(message, "choices[0].message").map((part) => {
    if (part.type === "tool_result") throw new ProtocolTrajectoryError("invalid_response", "Assistant response cannot contain tool results");
    return part;
  }), stop_reason: stopReason(choice.finish_reason) };
}
