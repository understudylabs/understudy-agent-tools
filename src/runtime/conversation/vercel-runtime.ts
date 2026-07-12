import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  dynamicTool,
  jsonSchema,
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
} from "ai";

import {
  RuntimeEventWriter,
  VERCEL_RUNTIME_ID,
  type EmitRuntimeEvent,
  type RuntimeInputMessage,
  type RuntimeRunRequest,
  parseRuntimeRequest,
  requireLocalToolExecutorUrl,
  requireSafeProviderUrl,
  safeErrorMessage,
  validateAttachmentBytes,
} from "./contract.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}
function toModelMessage(message: RuntimeInputMessage): ModelMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: message.tool_call_id,
          toolName: message.tool_name,
          output: message.ok
            ? { type: "json", value: jsonValue(message.result) }
            : { type: "error-json", value: jsonValue(message.result) },
        },
      ],
    };
  }
  if (message.role === "user" && message.attachments?.length) {
    return {
      role: "user",
      content: [
        { type: "text", text: message.content },
        ...message.attachments.map((attachment) => ({
          type: "file" as const,
          data: validateAttachmentBytes(attachment),
          mediaType: attachment.media_type,
          filename: attachment.filename,
        })),
      ],
    };
  }
  return { role: message.role, content: message.content };
}

function buildTools(request: RuntimeRunRequest): ToolSet | undefined {
  if (!request.tools?.length) return undefined;
  const executorUrl = requireLocalToolExecutorUrl(request);
  return Object.fromEntries(
    request.tools.map((definition) => [
      definition.name,
      dynamicTool({
        description: definition.description,
        inputSchema: jsonSchema(definition.input_schema),
        execute: async (input, { toolCallId, abortSignal }) => {
              if (!executorUrl) {
                throw new Error("local tool executor is unavailable");
              }
              const response = await fetch(executorUrl, {
                method: "POST",
                signal: abortSignal,
                headers: {
                  authorization: `Bearer ${process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  run_id: request.run_id,
                  session_id: request.session_id,
                  tool_call_id: toolCallId,
                  name: definition.name,
                  arguments: input,
                }),
              });
              const payload = (await response.json()) as {
                ok?: boolean;
                result?: unknown;
                error?: string;
              };
              if (!response.ok || payload.ok !== true) {
                throw new Error(payload.error || `tool executor returned ${response.status}`);
              }
              return payload.result ?? null;
            },
      }),
    ]),
  );
}

function usageData(
  request: RuntimeRunRequest,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
  },
): Record<string, unknown> {
  const complete =
    usage.inputTokens != null &&
    usage.outputTokens != null &&
    usage.totalTokens != null;
  return {
    role: request.role,
    model: request.model,
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    reasoning_tokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    cached_input_tokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    total_tokens:
      usage.totalTokens ??
      (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    source: complete ? "provider" : "unavailable",
    complete,
  };
}

async function emitInputEvidence(
  request: RuntimeRunRequest,
  writer: RuntimeEventWriter,
): Promise<void> {
  if (!request.emit_input) return;
  const latest = [...request.messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!latest || latest.role !== "user") return;
  for (const attachment of latest.attachments ?? []) {
    const bytes = validateAttachmentBytes(attachment);
    await writer.emit("image_attachment", {
      attachment_id: attachment.id,
      filename: attachment.filename,
      media_type: attachment.media_type,
      byte_count: bytes.byteLength,
    });
  }
  await writer.emit("message", { role: "user", text: latest.content, model: null });
}

export async function runVercelConversation(
  rawRequest: unknown,
  emit: EmitRuntimeEvent,
  abortSignal?: AbortSignal,
): Promise<void> {
  const request = parseRuntimeRequest(rawRequest);
  const providerUrl = requireSafeProviderUrl(request);
  const writer = new RuntimeEventWriter(request, emit, VERCEL_RUNTIME_ID);
  const provider = createOpenAICompatible({
    name: "understudy-runtime",
    baseURL: providerUrl.toString().replace(/\/$/, ""),
    apiKey: process.env.UNDERSTUDY_RUNTIME_API_KEY,
    includeUsage: true,
  });
  const pendingInputs = new Map<string, { name: string; raw: string }>();
  const emittedCalls = new Set<string>();
  const resolvedCalls = new Set<string>();
  const flushPendingToolFailures = async (error: unknown): Promise<void> => {
    for (const [callId, pending] of pendingInputs) {
      if (resolvedCalls.has(callId)) continue;
      if (!emittedCalls.has(callId)) {
        emittedCalls.add(callId);
        await writer.emit("tool_call", {
          call_id: callId,
          name: pending.name,
          raw_arguments: pending.raw,
          parse_error: safeErrorMessage(error),
        });
      }
      await writer.emit("tool_result", {
        call_id: callId,
        name: pending.name,
        ok: false,
        result: { error: "tool call did not complete" },
      });
      resolvedCalls.add(callId);
    }
  };

  await emitInputEvidence(request, writer);
  try {
    const result = streamText({
      model: provider(request.model),
      messages: request.messages.map(toModelMessage),
      tools: buildTools(request),
      maxOutputTokens: request.max_output_tokens,
      stopWhen: stepCountIs(Math.max(1, request.max_tool_rounds + 1)),
      abortSignal,
      maxRetries: 0,
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          await writer.emit("delta", {
            role: request.role,
            text: part.text,
            model: request.model,
          });
          break;
        case "reasoning-delta":
          await writer.emit("reasoning_delta", {
            role: request.role,
            text: part.text,
            model: request.model,
          });
          break;
        case "tool-input-start":
          pendingInputs.set(part.id, { name: part.toolName, raw: "" });
          break;
        case "tool-input-delta": {
          const pending = pendingInputs.get(part.id);
          if (pending) pending.raw += part.delta;
          break;
        }
        case "tool-call": {
          const pending = pendingInputs.get(part.toolCallId);
          emittedCalls.add(part.toolCallId);
          await writer.emit("tool_call", {
            call_id: part.toolCallId,
            name: part.toolName,
            raw_arguments: pending?.raw || JSON.stringify(part.input ?? {}),
            parsed_arguments: part.input ?? null,
            ...(part.invalid
              ? { parse_error: safeErrorMessage(part.error ?? "invalid tool input") }
              : {}),
          });
          break;
        }
        case "tool-result":
          await writer.emit("tool_result", {
            call_id: part.toolCallId,
            name: part.toolName,
            ok: true,
            result: part.output,
          });
          resolvedCalls.add(part.toolCallId);
          break;
        case "tool-error":
          await writer.emit("tool_result", {
            call_id: part.toolCallId,
            name: part.toolName,
            ok: false,
            result: { error: safeErrorMessage(part.error) },
          });
          resolvedCalls.add(part.toolCallId);
          break;
        case "abort":
          await flushPendingToolFailures(part.reason || "aborted");
          await writer.emit("cancellation", {
            stage: "model_stream",
            reason: part.reason || "aborted",
          });
          return;
        case "error":
          await flushPendingToolFailures(part.error);
          await writer.emit("error", {
            stage: "model_stream",
            code: "provider_stream_error",
            message: safeErrorMessage(part.error),
            recoverable: false,
          });
          return;
        case "finish":
          await writer.emit("usage", usageData(request, part.totalUsage));
          break;
      }
    }
  } catch (error) {
    const aborted = abortSignal?.aborted;
    await flushPendingToolFailures(abortSignal?.reason ?? error);
    await writer.emit(
      aborted ? "cancellation" : "error",
      aborted
        ? { stage: "model_stream", reason: safeErrorMessage(abortSignal.reason ?? error) }
        : {
            stage: "model_stream",
            code: "runtime_exception",
            message: safeErrorMessage(error),
            recoverable: false,
          },
    );
  }
}
