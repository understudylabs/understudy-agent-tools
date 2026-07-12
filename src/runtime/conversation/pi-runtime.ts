import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

import {
  PI_RUNTIME_ID,
  RuntimeEventWriter,
  parseRuntimeRequest,
  requireLocalToolExecutorUrl,
  requireSafeProviderUrl,
  safeErrorMessage,
  validateAttachmentBytes,
  type EmitRuntimeEvent,
  type RuntimeInputMessage,
  type RuntimeRunRequest,
} from "./contract.js";

function runtimeHome(): string {
  return resolve(
    process.env.UNDERSTUDY_CONVERSATION_RUNTIME_HOME ??
      join(homedir(), ".understudy", "runtime", "conversation"),
  );
}

function sessionComponent(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function modelFor(request: RuntimeRunRequest, baseUrl: URL) {
  return {
    id: request.model,
    name: request.model,
    api: "openai-completions" as const,
    provider: "understudy-runtime",
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: request.max_output_tokens,
  };
}

function usageData(
  message: {
    usage?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cacheRead?: number;
      totalTokens?: number;
    };
  },
  request: RuntimeRunRequest,
): Record<string, unknown> {
  const usage = message.usage ?? {};
  const input = Number.isFinite(usage.input) ? usage.input! : 0;
  const output = Number.isFinite(usage.output) ? usage.output! : 0;
  const total = Number.isFinite(usage.totalTokens) ? usage.totalTokens! : input + output;
  const complete =
    Number.isFinite(usage.input) &&
    Number.isFinite(usage.output) &&
    Number.isFinite(usage.totalTokens);
  return {
    role: request.role,
    model: request.model,
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: Number.isFinite(usage.reasoning) ? usage.reasoning : 0,
    cached_input_tokens: Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0,
    total_tokens: Math.max(total, input + output),
    source: complete ? "provider" : "unavailable",
    complete,
  };
}

function textContent(message: RuntimeInputMessage): string {
  if (message.role === "tool") return "";
  return message.content;
}

function imageContent(message: RuntimeInputMessage): Array<{
  type: "image";
  data: string;
  mimeType: string;
}> {
  if (message.role !== "user") return [];
  return (message.attachments ?? []).map((attachment) => {
    validateAttachmentBytes(attachment);
    const prefix = `data:${attachment.media_type};base64,`;
    return {
      type: "image" as const,
      data: attachment.data_url.slice(prefix.length),
      mimeType: attachment.media_type,
    };
  });
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function seedHistory(
  manager: SessionManager,
  request: RuntimeRunRequest,
  messages: RuntimeInputMessage[],
): void {
  if (manager.getEntries().length > 0) return;
  for (const [index, message] of messages.entries()) {
    if (index === messages.length - 1 && message.role === "user") continue;
    if (message.role === "system") continue;
    if (message.role === "user") {
      const images = imageContent(message);
      manager.appendMessage({
        role: "user",
        content: images.length
          ? [{ type: "text", text: message.content }, ...images]
          : message.content,
        timestamp: Date.now() + index,
      });
    } else if (message.role === "assistant") {
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        api: "openai-completions",
        provider: "understudy-runtime",
        model: request.model,
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: Date.now() + index,
      });
    } else if (message.role === "tool") {
      manager.appendMessage({
        role: "toolResult",
        toolCallId: message.tool_call_id,
        toolName: message.tool_name,
        content: [{ type: "text", text: JSON.stringify(message.result ?? null) }],
        details: message.result,
        isError: !message.ok,
        timestamp: Date.now() + index,
      });
    }
  }
}

function buildTools(request: RuntimeRunRequest) {
  if (!request.tools?.length) return [];
  const executorUrl = requireLocalToolExecutorUrl(request);
  return request.tools.map((definition) =>
    defineTool({
      name: definition.name,
      label: definition.name,
      description: definition.description ?? definition.name,
      parameters: Type.Unsafe(definition.input_schema),
      async execute(toolCallId, parameters, signal) {
        if (!executorUrl) throw new Error("local tool executor is unavailable");
        const response = await fetch(executorUrl, {
          method: "POST",
          signal,
          headers: {
            authorization: `Bearer ${process.env.UNDERSTUDY_RUNTIME_TOOL_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            run_id: request.run_id,
            session_id: request.session_id,
            tool_call_id: toolCallId,
            name: definition.name,
            arguments: parameters,
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
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload.result ?? null) }],
          details: payload.result ?? null,
        };
      },
    }),
  );
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

function attachCanonicalAdapter(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  request: RuntimeRunRequest,
  writer: RuntimeEventWriter,
) {
  let chain = Promise.resolve();
  let terminalEmitted = false;
  let compactionSourceMessages = 0;
  const enqueue = (event: Parameters<RuntimeEventWriter["emit"]>[0], data: Record<string, unknown>) => {
    chain = chain.then(() => writer.emit(event, data));
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        enqueue("delta", { role: request.role, text: update.delta, model: request.model });
      } else if (update.type === "thinking_delta") {
        enqueue("reasoning_delta", {
          role: request.role,
          text: update.delta,
          model: request.model,
        });
      }
    } else if (event.type === "tool_execution_start") {
      enqueue("tool_call", {
        call_id: event.toolCallId,
        name: event.toolName,
        raw_arguments: JSON.stringify(event.args),
        parsed_arguments: event.args,
      });
    } else if (event.type === "tool_execution_end") {
      enqueue("tool_result", {
        call_id: event.toolCallId,
        name: event.toolName,
        ok: !event.isError,
        result: event.result,
      });
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      enqueue("usage", usageData(event.message, request));
      if (event.message.stopReason === "aborted") {
        terminalEmitted = true;
        enqueue("cancellation", {
          stage: "model_stream",
          reason: event.message.errorMessage || "aborted",
        });
      } else if (event.message.stopReason === "error") {
        terminalEmitted = true;
        enqueue("error", {
          stage: "model_stream",
          code: "pi_agent_session_error",
          message: event.message.errorMessage || "Pi AgentSession error",
          recoverable: false,
        });
      }
    } else if (event.type === "compaction_start") {
      compactionSourceMessages = session.messages.length;
    } else if (event.type === "compaction_end" && event.result) {
      const retained = session.messages.length;
      const before = Math.max(0, event.result.tokensBefore);
      const after = Math.min(
        before,
        Math.max(
          0,
          event.result.estimatedTokensAfter ?? Math.ceil(event.result.summary.length / 4),
        ),
      );
      enqueue("compaction_boundary", {
        source_message_count: Math.max(compactionSourceMessages, retained),
        retained_message_count: retained,
        estimated_tokens_before: before,
        estimated_tokens_after: after,
        summary_sha256: createHash("sha256").update(event.result.summary).digest("hex"),
      });
    }
  });
  return {
    unsubscribe,
    flush: () => chain,
    terminalEmitted: () => terminalEmitted,
  };
}

export async function runPiConversation(
  rawRequest: unknown,
  emit: EmitRuntimeEvent,
  abortSignal?: AbortSignal,
): Promise<void> {
  const request = parseRuntimeRequest(rawRequest);
  const providerUrl = requireSafeProviderUrl(request);
  const writer = new RuntimeEventWriter(request, emit, PI_RUNTIME_ID);
  const root = join(runtimeHome(), "pi-sessions", sessionComponent(request.session_id));
  const cwd = join(root, "cwd");
  const sessionDir = join(root, "sessions");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  const selectedModel = modelFor(request, providerUrl);
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(
    selectedModel.provider,
    process.env.UNDERSTUDY_RUNTIME_API_KEY ?? "local-runtime",
  );
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory(
    {
      compaction: {
        enabled: true,
        reserveTokens: Math.min(16_384, request.max_output_tokens + 4_096),
        keepRecentTokens: 8_192,
      },
      retry: { enabled: false, maxRetries: 0 },
      images: { autoResize: false, blockImages: false },
      quietStartup: true,
    },
    { projectTrusted: false },
  );
  const systemPrompt = request.messages
    .filter((message) => message.role === "system")
    .map(textContent)
    .filter(Boolean)
    .join("\n\n") || "You are the Understudy conversation runtime. Use only explicitly provided tools.";
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.continueRecent(cwd, sessionDir);
  seedHistory(sessionManager, request, request.messages);
  const tools = buildTools(request);
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(root, "agent"),
    model: selectedModel,
    thinkingLevel: "off",
    tools: tools.map((tool) => tool.name),
    noTools: "all",
    customTools: tools,
    resourceLoader,
    sessionManager,
    settingsManager,
    authStorage,
    modelRegistry,
  });
  const adapter = attachCanonicalAdapter(session, request, writer);
  const latest = [...request.messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!latest || latest.role !== "user") {
    adapter.unsubscribe();
    session.dispose();
    throw new Error("Pi runtime requires a user message");
  }
  await emitInputEvidence(request, writer);
  const abort = () => void session.abort();
  abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    await session.prompt(latest.content, {
      images: imageContent(latest),
      expandPromptTemplates: false,
    });
  } catch (error) {
    if (!adapter.terminalEmitted()) {
      await writer.emit(
        abortSignal?.aborted ? "cancellation" : "error",
        abortSignal?.aborted
          ? { stage: "model_stream", reason: safeErrorMessage(abortSignal.reason ?? error) }
          : {
              stage: "model_stream",
              code: "pi_runtime_exception",
              message: safeErrorMessage(error),
              recoverable: false,
            },
      );
    }
  } finally {
    await adapter.flush();
    abortSignal?.removeEventListener("abort", abort);
    adapter.unsubscribe();
    session.dispose();
  }
}
