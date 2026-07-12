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
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

import {
  PI_RUNTIME_ID,
  RuntimeEventWriter,
  parseRuntimeRequest,
  requireLocalToolExecutorUrl,
  requireSafeProviderTargetUrl,
  requireSafeProviderUrl,
  safeErrorMessage,
  validateAttachmentBytes,
  type EmitRuntimeEvent,
  type RuntimeInputMessage,
  type RuntimeProviderTarget,
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

function modelFor(
  target: RuntimeProviderTarget,
  baseUrl: URL,
  maxTokens: number,
  contextWindow: number,
) {
  return {
    id: target.model,
    name: target.model,
    api: "openai-completions" as const,
    provider: "understudy-runtime",
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(
      maxTokens,
      Math.max(1, Math.floor(contextWindow / 2)),
    ),
    compat: {
      supportsDeveloperRole: false,
      // MLX-VLM implements the OpenAI-compatible `max_tokens` field. Pi's
      // modern OpenAI default is `max_completion_tokens`, which MLX-VLM
      // currently ignores and would let compaction summaries exceed their
      // explicit budget.
      maxTokensField: "max_tokens" as const,
    },
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
  role: RuntimeRunRequest["role"],
  model: string,
): Record<string, unknown> {
  const usage = message.usage ?? {};
  const input = Number.isFinite(usage.input) ? usage.input! : 0;
  const output = Number.isFinite(usage.output) ? usage.output! : 0;
  const total = Number.isFinite(usage.totalTokens) ? usage.totalTokens! : input + output;
  const complete =
    Number.isFinite(usage.input) &&
    Number.isFinite(usage.output) &&
    Number.isFinite(usage.totalTokens) &&
    total > 0;
  return {
    role,
    model,
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

/**
 * Pi uses `reserveTokens` both as the compaction trigger headroom and as the
 * summary generation budget. Its upstream default is tuned for coding-agent
 * contexts and can make a small local model produce a summary larger than the
 * conversation it replaces. Keep the summary bounded so compaction is an
 * actual reduction even on the 1K frozen stress context, while retaining a
 * useful ceiling for normal long conversations.
 */
export function piCompactionSettings(
  contextWindowTokens: number,
  maxOutputTokens: number,
): { reserveTokens: number; keepRecentTokens: number } {
  const reserveTokens = Math.min(
    4_096,
    Math.max(
      128,
      Math.min(maxOutputTokens, Math.floor(contextWindowTokens / 8)),
    ),
  );
  return {
    reserveTokens,
    keepRecentTokens: Math.min(
      8_192,
      Math.max(256, Math.floor(reserveTokens / 2)),
    ),
  };
}

export function piPreflightCompactionRequired(
  historyTokens: number,
  pendingUserTokens: number,
  contextWindowTokens: number,
  maxOutputTokens: number,
): boolean {
  const { reserveTokens } = piCompactionSettings(
    contextWindowTokens,
    maxOutputTokens,
  );
  return historyTokens + pendingUserTokens > contextWindowTokens - reserveTokens;
}

function runtimeInputTokenEstimate(message: RuntimeInputMessage): number {
  if (message.role === "tool") {
    return Math.ceil(JSON.stringify(message.result ?? null).length / 4);
  }
  const imageTokens =
    message.role === "user" ? (message.attachments?.length ?? 0) * 1_200 : 0;
  return Math.ceil(message.content.length / 4) + imageTokens;
}

function seedHistory(
  manager: SessionManager,
  model: string,
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
        model,
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

function deterministicCompactionFixture(pi: ExtensionAPI): void {
  pi.on("session_before_compact", (event) => ({
    compaction: {
      summary: [
        "# Frozen conversation summary",
        "The desktop owns presentation and consent. The runtime owns ordered conversation events. The evidence ledger owns immutable attribution.",
        "Student partials, exact run ids, model attribution, tool activity, usage, intervention markers, image identity, and restart state remain durable.",
        "Tools execute only through the authenticated loopback bridge; malformed calls are rejected and every call has exactly one result.",
        "Compaction is a projection over immutable history, and fully offline proof requires live local text, image, tool, restart, and terminal evidence.",
      ].join("\n\n"),
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      details: { fixture: "understudy-deterministic-compaction-v1" },
    },
  }));
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
  options: {
    role?: RuntimeRunRequest["role"];
    model?: string;
    plannedAbort?: () => boolean;
    abortReason?: () => unknown;
    onTextDelta?: (delta: string) => void;
    transformTextDelta?: (delta: string, first: boolean) => string;
  } = {},
) {
  let chain = Promise.resolve();
  let terminalEmitted = false;
  let emittedTextDelta = false;
  let compactionSourceMessages = 0;
  const rawToolArguments = new Map<string, string>();
  const enqueue = (event: Parameters<RuntimeEventWriter["emit"]>[0], data: Record<string, unknown>) => {
    chain = chain.then(() => writer.emit(event, data));
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        const delta =
          options.transformTextDelta?.(update.delta, !emittedTextDelta) ?? update.delta;
        if (update.delta.length > 0) emittedTextDelta = true;
        enqueue("delta", {
          role: options.role ?? request.role,
          text: delta,
          model: options.model ?? request.model,
        });
        options.onTextDelta?.(delta);
      } else if (update.type === "thinking_delta") {
        enqueue("reasoning_delta", {
          role: options.role ?? request.role,
          text: update.delta,
          model: options.model ?? request.model,
        });
      } else if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
        const toolCall = update.partial.content[update.contentIndex];
        if (toolCall?.type === "toolCall") {
          const previous = rawToolArguments.get(toolCall.id) ?? "";
          rawToolArguments.set(
            toolCall.id,
            update.type === "toolcall_delta" ? previous + update.delta : previous,
          );
        }
      } else if (update.type === "toolcall_end") {
        if (!rawToolArguments.get(update.toolCall.id)) {
          rawToolArguments.set(update.toolCall.id, JSON.stringify(update.toolCall.arguments));
        }
      }
    } else if (event.type === "tool_execution_start") {
      const rawArguments = rawToolArguments.get(event.toolCallId) ?? JSON.stringify(event.args);
      let parseError: string | undefined;
      try {
        JSON.parse(rawArguments);
      } catch (error) {
        parseError = safeErrorMessage(error);
      }
      enqueue("tool_call", {
        call_id: event.toolCallId,
        name: event.toolName,
        raw_arguments: rawArguments,
        ...(parseError ? { parse_error: parseError } : { parsed_arguments: event.args }),
      });
    } else if (event.type === "tool_execution_end") {
      enqueue("tool_result", {
        call_id: event.toolCallId,
        name: event.toolName,
        ok: !event.isError,
        result: event.result,
      });
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      enqueue(
        "usage",
        usageData(
          event.message,
          options.role ?? request.role,
          options.model ?? request.model,
        ),
      );
      if (event.message.stopReason === "aborted" && !options.plannedAbort?.()) {
        terminalEmitted = true;
        enqueue("cancellation", {
          stage: "model_stream",
          reason: safeErrorMessage(
            options.abortReason?.() ?? event.message.errorMessage ?? "aborted",
          ),
        });
      } else if (
        event.message.stopReason === "error" &&
        !isContextOverflowMessage(event.message.errorMessage)
      ) {
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
      const runtimeEstimatedAfter = Math.max(
        0,
        event.result.estimatedTokensAfter ?? Math.ceil(event.result.summary.length / 4),
      );
      const canonicalEstimatedAfter = session.messages.reduce(
        (total, message) => total + estimateTokens(message),
        0,
      );
      const after = Math.min(before, Math.max(0, canonicalEstimatedAfter));
      enqueue("compaction_boundary", {
        source_message_count: Math.max(compactionSourceMessages, retained),
        retained_message_count: retained,
        estimated_tokens_before: before,
        estimated_tokens_after: after,
        runtime_estimated_tokens_after: runtimeEstimatedAfter,
        summary_sha256: createHash("sha256").update(event.result.summary).digest("hex"),
      });
    }
  });
  return {
    unsubscribe,
    enqueue,
    flush: () => chain,
    terminalEmitted: () => terminalEmitted,
  };
}

export function teacherContinuationBoundary(partial: string, firstDelta: string): string {
  if (!partial || !firstDelta || /\s$/.test(partial) || /^\s/.test(firstDelta)) return "";
  if (/^[,.;:!?)}\]]/.test(firstDelta)) return "";
  return " ";
}

async function createPiRuntimeSession(options: {
  request: RuntimeRunRequest;
  target: RuntimeProviderTarget;
  root: string;
  messages: RuntimeInputMessage[];
  persistent: boolean;
  maxTokens?: number;
  toolsEnabled?: boolean;
}) {
  const { request, target, root, messages, persistent } = options;
  const providerUrl = requireSafeProviderTargetUrl(target, request.allow_remote);
  const cwd = join(root, "cwd");
  const sessionDir = join(root, "sessions");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  if (persistent) mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  const selectedModel = modelFor(
    target,
    providerUrl,
    options.maxTokens ?? request.max_output_tokens,
    request.provider_context_window_tokens ?? request.context_window_tokens,
  );
  const compaction = piCompactionSettings(
    request.context_window_tokens,
    request.max_output_tokens,
  );
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
        ...compaction,
      },
      retry: { enabled: false, maxRetries: 0 },
      images: { autoResize: false, blockImages: false },
      quietStartup: true,
    },
    { projectTrusted: false },
  );
  const systemPrompt =
    messages
      .filter((message) => message.role === "system")
      .map(textContent)
      .filter(Boolean)
      .join("\n\n") ||
    "You are the Understudy conversation runtime. Use only explicitly provided tools.";
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: join(root, "agent"),
    settingsManager,
    extensionFactories: request.conformance_deterministic_compaction
      ? [{ name: "understudy-deterministic-compaction", factory: deterministicCompactionFixture }]
      : [],
    noExtensions: !request.conformance_deterministic_compaction,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await resourceLoader.reload();
  const sessionManager = persistent
    ? SessionManager.continueRecent(cwd, sessionDir)
    : SessionManager.inMemory(cwd);
  seedHistory(sessionManager, target.model, messages);
  const tools = options.toolsEnabled === false ? [] : buildTools(request);
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
  return { session };
}

type SupervisionConfig = NonNullable<RuntimeRunRequest["supervision"]>;
const SUPERVISOR_RESPONSE_PROTOCOL = [
  "You supervise a smaller model's partial answer.",
  "Do not answer or continue the user's task yourself.",
  "Return exactly one line beginning with one of these uppercase verdicts:",
  "CONTINUE",
  "INTERRUPT: <brief reason>",
  "STOP",
  "NUDGE: <brief reason>",
  "The first token must be the verdict. INTERRUPT and NUDGE require a reason.",
].join("\n");
type SupervisorDecision = {
  verdict: "continue" | "interrupt" | "stop" | "nudge";
  reason?: string;
  probabilities?: Record<string, number>;
  raw?: string;
  error?: string;
  usage: Record<string, unknown>;
};

function unavailableSupervisorUsage(model: string): Record<string, unknown> {
  return {
    role: "supervisor",
    model,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_input_tokens: 0,
    total_tokens: 0,
    source: "unavailable",
    complete: false,
  };
}

function characterCount(value: string): number {
  return [...value].length;
}

function isContextOverflowMessage(value: string | undefined): boolean {
  return Boolean(
    value &&
      /(context.{0,24}(length|window|limit)|maximum context|too many tokens|token limit)/i.test(
        value,
      ),
  );
}

function supervisionBoundaryDue(
  partial: string,
  checkedChars: number,
  boundaryChars: number,
): boolean {
  if (characterCount(partial) - checkedChars < boundaryChars) return false;
  const trimmed = partial.trimEnd();
  return partial.endsWith("\n") || /[.!?]$/.test(trimmed);
}

function openAiMessage(message: RuntimeInputMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.tool_call_id,
      name: message.tool_name,
      content: JSON.stringify(message.result ?? null),
    };
  }
  if (message.role === "user" && message.attachments?.length) {
    return {
      role: message.role,
      content: [
        { type: "text", text: message.content },
        ...message.attachments.map((attachment) => ({
          type: "image_url",
          image_url: { url: attachment.data_url },
        })),
      ],
    };
  }
  return { role: message.role, content: message.content };
}

function chatCompletionsUrl(baseUrl: URL): URL {
  const path = baseUrl.pathname.replace(/\/$/, "");
  if (path.endsWith("/chat/completions")) return baseUrl;
  baseUrl.pathname = `${path}/chat/completions`.replace(/^\/\//, "/");
  return baseUrl;
}

function verdictLogprobs(payload: unknown): Record<string, number> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const top = (
    payload as {
      choices?: Array<{
        logprobs?: { content?: Array<{ top_logprobs?: Array<{ token?: string; logprob?: number }> }> };
      }>;
    }
  ).choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
  if (!Array.isArray(top)) return undefined;
  const distribution: Record<string, number> = {};
  for (const verdict of ["continue", "interrupt", "stop", "nudge"] as const) {
    const matches = top
      .filter(
        (entry) =>
          typeof entry.token === "string" &&
          typeof entry.logprob === "number" &&
          verdict.startsWith(entry.token.trim().toLowerCase()),
      )
      .map((entry) => entry.logprob as number);
    if (matches.length) distribution[verdict] = Math.max(...matches);
  }
  return Object.keys(distribution).length ? distribution : undefined;
}

function parseSupervisorDecision(raw: string): SupervisorDecision {
  const afterThinking = raw.includes("</think>")
    ? raw.slice(raw.lastIndexOf("</think>") + "</think>".length)
    : raw;
  const trimmed = afterThinking.trim();
  const match = trimmed.match(/^\W*(continue|interrupt|stop|nudge)\b[\s:,-]*(.*)$/i);
  if (!match) {
    return {
      verdict: "continue",
      raw: raw.slice(0, 500),
      error: "supervisor output did not start with a supported verdict",
      usage: {},
    };
  }
  const verdict = match[1].toLowerCase() as SupervisorDecision["verdict"];
  const detail = match[2].trim();
  if ((verdict === "interrupt" || verdict === "nudge") && !detail) {
    return {
      verdict: "continue",
      raw: raw.slice(0, 500),
      error: `${verdict} verdict omitted its required reason`,
      usage: {},
    };
  }
  return {
    verdict,
    reason: detail || undefined,
    raw: raw.slice(0, 500),
    usage: {},
  };
}

async function checkSupervisor(
  request: RuntimeRunRequest,
  config: SupervisionConfig,
  messages: RuntimeInputMessage[],
  partial: string,
  signal?: AbortSignal,
): Promise<SupervisorDecision> {
  const targetUrl = requireSafeProviderTargetUrl(config.supervisor, request.allow_remote);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.UNDERSTUDY_RUNTIME_API_KEY) {
    headers.authorization = `Bearer ${process.env.UNDERSTUDY_RUNTIME_API_KEY}`;
  }
  try {
    const response = await fetch(chatCompletionsUrl(targetUrl), {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify({
        model: config.supervisor.model,
        messages: [
          {
            role: "system",
            content: `${SUPERVISOR_RESPONSE_PROTOCOL}\n\nEvaluation policy:\n${config.supervisor.system_prompt}`,
          },
          ...messages.filter((message) => message.role !== "system").map(openAiMessage),
          {
            role: "user",
            content: `[smaller model's partial answer so far]\n${partial}\n\nReturn the verdict now.`,
          },
        ],
        stream: false,
        max_tokens: config.supervisor.max_output_tokens,
        temperature: 0,
        logprobs: true,
        top_logprobs: 5,
      }),
    });
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    if (!response.ok) {
      throw new Error(`supervisor returned HTTP ${response.status}`);
    }
    const raw = payload.choices?.[0]?.message?.content ?? "";
    const parsed = parseSupervisorDecision(raw);
    const input = payload.usage?.prompt_tokens;
    const output = payload.usage?.completion_tokens;
    const total = payload.usage?.total_tokens;
    const complete = [input, output, total].every(Number.isFinite);
    return {
      ...parsed,
      probabilities: verdictLogprobs(payload),
      usage: complete
        ? {
            role: "supervisor",
            model: config.supervisor.model,
            input_tokens: input,
            output_tokens: output,
            reasoning_tokens: 0,
            cached_input_tokens: 0,
            total_tokens: Math.max(total!, input! + output!),
            source: "provider",
            complete: true,
          }
        : unavailableSupervisorUsage(config.supervisor.model),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      verdict: "continue",
      error: safeErrorMessage(error),
      usage: unavailableSupervisorUsage(config.supervisor.model),
    };
  }
}

function verdictEventData(
  decision: SupervisorDecision,
  boundaryOrdinal: number,
  afterChars: number,
  markerId?: string,
): Record<string, unknown> {
  return {
    verdict: decision.verdict,
    source: "model",
    marker_id: markerId,
    reason: decision.reason,
    probabilities: decision.probabilities,
    probability_kind: decision.probabilities ? "logprob" : undefined,
    boundary_ordinal: boundaryOrdinal,
    after_chars: afterChars,
    raw: decision.raw,
    error: decision.error,
  };
}

async function runSupervisedStudentSegment(options: {
  request: RuntimeRunRequest;
  config: SupervisionConfig;
  writer: RuntimeEventWriter;
  root: string;
  messages: RuntimeInputMessage[];
  segmentOrdinal: number;
  markerOrdinal: number;
  boundaryOrdinal: number;
  allowNudge: boolean;
  abortSignal?: AbortSignal;
}): Promise<{
  partial: string;
  decision: SupervisorDecision;
  markerId?: string;
  nextBoundaryOrdinal: number;
  terminal: boolean;
}> {
  const { request, config, writer, messages, abortSignal } = options;
  const { session } = await createPiRuntimeSession({
    request,
    target: config.student,
    root: join(options.root, `student-${options.segmentOrdinal}`),
    messages,
    persistent: false,
  });
  let partial = "";
  let checkedChars = 0;
  let boundaryOrdinal = options.boundaryOrdinal;
  let decision: SupervisorDecision | undefined;
  let markerId: string | undefined;
  let plannedAbort = false;
  let checkInFlight: Promise<void> | undefined;
  const adapter = attachCanonicalAdapter(session, request, writer, {
    role: "student",
    model: config.student.model,
    plannedAbort: () => plannedAbort,
    abortReason: () => abortSignal?.reason,
    onTextDelta(delta) {
      partial += delta;
      if (
        decision ||
        checkInFlight ||
        abortSignal?.aborted ||
        !supervisionBoundaryDue(partial, checkedChars, config.boundary_chars)
      ) {
        return;
      }
      const snapshot = partial;
      const afterChars = characterCount(snapshot);
      checkedChars = afterChars;
      const thisBoundary = boundaryOrdinal++;
      checkInFlight = checkSupervisor(request, config, messages, snapshot, abortSignal)
        .then((result) => {
          if (abortSignal?.aborted) return;
          if (result.verdict === "nudge" && !options.allowNudge) {
            result = {
              verdict: "continue",
              error: "nudge budget exhausted; degraded to continue",
              usage: result.usage,
            };
          }
          const intervention = result.verdict === "interrupt" || result.verdict === "nudge";
          const currentMarker = intervention
            ? `${request.run_id}:intervention:${options.markerOrdinal}`
            : undefined;
          adapter.enqueue(
            "supervisor_verdict",
            verdictEventData(result, thisBoundary, afterChars, currentMarker),
          );
          adapter.enqueue("usage", result.usage);
          if (result.verdict !== "continue") {
            decision = result;
            markerId = currentMarker;
            plannedAbort = true;
            void session.abort();
          }
        })
        .catch((error) => {
          // A user Stop aborts the student stream and an in-flight supervisor
          // request together. The canonical cancellation is emitted below;
          // never let the supervisor fetch rejection escape to the sidecar's
          // generic runtime_dispatch error boundary.
          if (!abortSignal?.aborted) {
            decision = {
              verdict: "continue",
              error: safeErrorMessage(error),
              usage: unavailableSupervisorUsage(config.supervisor.model),
            };
          }
        })
        .finally(() => {
          checkInFlight = undefined;
        });
    },
  });
  const latest = [...messages].reverse().find((message) => message.role === "user");
  if (!latest || latest.role !== "user") {
    adapter.unsubscribe();
    session.dispose();
    throw new Error("supervised Pi segment requires a user message");
  }
  const abort = () => void session.abort();
  abortSignal?.addEventListener("abort", abort, { once: true });
  let promptError: unknown;
  try {
    await session.prompt(latest.content, {
      images: imageContent(latest),
      expandPromptTemplates: false,
    });
  } catch (error) {
    promptError = error;
  }
  if (checkInFlight) await checkInFlight;
  await adapter.flush();
  if (abortSignal?.aborted && !adapter.terminalEmitted()) {
    await writer.emit("cancellation", {
      stage: "student_stream",
      reason: safeErrorMessage(abortSignal.reason ?? promptError ?? "aborted"),
    });
  } else if (promptError && !decision && !adapter.terminalEmitted()) {
    await writer.emit("error", {
      stage: "student_stream",
      code: "pi_student_exception",
      message: safeErrorMessage(promptError),
      recoverable: false,
    });
  }
  if (!decision && !abortSignal?.aborted && !promptError) {
    const afterChars = characterCount(partial);
    if (afterChars !== checkedChars || boundaryOrdinal === options.boundaryOrdinal) {
      let finalDecision: SupervisorDecision;
      try {
        finalDecision = await checkSupervisor(request, config, messages, partial, abortSignal);
      } catch (error) {
        if (!abortSignal?.aborted) throw error;
        await writer.emit("cancellation", {
          stage: "supervisor_check",
          reason: safeErrorMessage(abortSignal.reason ?? error),
        });
        abortSignal.removeEventListener("abort", abort);
        adapter.unsubscribe();
        session.dispose();
        return {
          partial,
          decision: {
            verdict: "continue",
            usage: unavailableSupervisorUsage(config.supervisor.model),
          },
          nextBoundaryOrdinal: boundaryOrdinal,
          terminal: true,
        };
      }
      if (finalDecision.verdict === "nudge" && !options.allowNudge) {
        finalDecision = {
          verdict: "continue",
          error: "nudge budget exhausted; degraded to continue",
          usage: finalDecision.usage,
        };
      }
      const intervention =
        finalDecision.verdict === "interrupt" || finalDecision.verdict === "nudge";
      markerId = intervention
        ? `${request.run_id}:intervention:${options.markerOrdinal}`
        : undefined;
      await writer.emit(
        "supervisor_verdict",
        verdictEventData(finalDecision, boundaryOrdinal++, afterChars, markerId),
      );
      await writer.emit("usage", finalDecision.usage);
      decision = finalDecision;
    }
  }
  abortSignal?.removeEventListener("abort", abort);
  adapter.unsubscribe();
  session.dispose();
  return {
    partial,
    decision:
      decision ?? {
        verdict: "continue",
        usage: unavailableSupervisorUsage(config.supervisor.model),
      },
    markerId,
    nextBoundaryOrdinal: boundaryOrdinal,
    terminal: Boolean(
      abortSignal?.aborted || (!decision && promptError) || adapter.terminalEmitted(),
    ),
  };
}

async function runTeacherContinuation(options: {
  request: RuntimeRunRequest;
  config: SupervisionConfig;
  writer: RuntimeEventWriter;
  root: string;
  partial: string;
  markerId: string;
  reason: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const prompt =
    "The partial assistant answer above was written by a smaller model that has been interrupted. " +
    "Continue it seamlessly from the exact point it stopped. Correct the problem identified by the " +
    "supervisor without repeating, rephrasing, or summarizing text already written.";
  const messages: RuntimeInputMessage[] = [
    ...options.request.messages,
    { role: "assistant", content: options.partial },
    { role: "user", content: prompt },
  ];
  await options.writer.emit("teacher_continuation", {
    marker_id: options.markerId,
    reason: options.reason,
    teacher_model: options.config.teacher.model,
    from_partial_chars: characterCount(options.partial),
  });
  const { session } = await createPiRuntimeSession({
    request: options.request,
    target: options.config.teacher,
    root: join(options.root, "teacher"),
    messages,
    persistent: false,
    toolsEnabled: false,
  });
  const adapter = attachCanonicalAdapter(session, options.request, options.writer, {
    role: "teacher",
    model: options.config.teacher.model,
    abortReason: () => options.abortSignal?.reason,
    transformTextDelta: (delta, first) =>
      first ? `${teacherContinuationBoundary(options.partial, delta)}${delta}` : delta,
  });
  const abort = () => void session.abort();
  options.abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    await session.prompt(prompt, { expandPromptTemplates: false });
  } catch (error) {
    if (!adapter.terminalEmitted()) {
      await options.writer.emit(
        options.abortSignal?.aborted ? "cancellation" : "error",
        options.abortSignal?.aborted
          ? { stage: "teacher_stream", reason: safeErrorMessage(options.abortSignal.reason ?? error) }
          : {
              stage: "teacher_stream",
              code: "pi_teacher_exception",
              message: safeErrorMessage(error),
              recoverable: false,
            },
      );
    }
  } finally {
    await adapter.flush();
    options.abortSignal?.removeEventListener("abort", abort);
    adapter.unsubscribe();
    session.dispose();
  }
}

async function runPiSupervisedConversation(
  request: RuntimeRunRequest,
  emit: EmitRuntimeEvent,
  abortSignal?: AbortSignal,
): Promise<void> {
  const config = request.supervision;
  if (!config) throw new Error("supervision configuration is required");
  requireSafeProviderTargetUrl(config.student, request.allow_remote);
  requireSafeProviderTargetUrl(config.supervisor, request.allow_remote);
  requireSafeProviderTargetUrl(config.teacher, request.allow_remote);
  const writer = new RuntimeEventWriter(request, emit, PI_RUNTIME_ID);
  const root = join(
    runtimeHome(),
    "pi-supervised",
    sessionComponent(request.session_id),
    sessionComponent(request.run_id),
  );
  await emitInputEvidence(request, writer);
  let messages = request.messages;
  let totalPartial = "";
  let markerOrdinal = 0;
  let boundaryOrdinal = 0;
  let nudges = 0;
  for (let segmentOrdinal = 0; ; segmentOrdinal += 1) {
    const segment = await runSupervisedStudentSegment({
      request,
      config,
      writer,
      root,
      messages,
      segmentOrdinal,
      markerOrdinal,
      boundaryOrdinal,
      allowNudge: nudges < config.max_nudges,
      abortSignal,
    });
    totalPartial += segment.partial;
    boundaryOrdinal = segment.nextBoundaryOrdinal;
    if (segment.terminal || segment.decision.verdict === "continue" || segment.decision.verdict === "stop") {
      return;
    }
    if (segment.decision.verdict === "nudge") {
      markerOrdinal += 1;
      nudges += 1;
      messages = [
        ...request.messages,
        { role: "assistant", content: totalPartial },
        {
          role: "user",
          content:
            `[supervisor guidance] ${segment.decision.reason} — continue from exactly where the answer stopped. ` +
            "Apply the guidance without restarting or repeating text.",
        },
      ];
      continue;
    }
    const markerId = segment.markerId;
    const reason = segment.decision.reason;
    if (!markerId || !reason) {
      throw new Error("interrupt verdict lost its marker or reason");
    }
    await writer.emit("student_interruption", {
      marker_id: markerId,
      reason,
      partial_text: totalPartial,
      after_chars: characterCount(totalPartial),
    });
    await runTeacherContinuation({
      request,
      config,
      writer,
      root,
      partial: totalPartial,
      markerId,
      reason,
      abortSignal,
    });
    return;
  }
}

export async function runPiConversation(
  rawRequest: unknown,
  emit: EmitRuntimeEvent,
  abortSignal?: AbortSignal,
): Promise<void> {
  const request = parseRuntimeRequest(rawRequest);
  if (request.supervision) {
    await runPiSupervisedConversation(request, emit, abortSignal);
    return;
  }
  requireSafeProviderUrl(request);
  const writer = new RuntimeEventWriter(request, emit, PI_RUNTIME_ID);
  const root = join(runtimeHome(), "pi-sessions", sessionComponent(request.session_id));
  const { session } = await createPiRuntimeSession({
    request,
    target: request,
    root,
    messages: request.messages,
    persistent: true,
  });
  const adapter = attachCanonicalAdapter(session, request, writer, {
    abortReason: () => abortSignal?.reason,
  });
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
    const historyTokens = session.messages.reduce(
      (total, message) => total + estimateTokens(message),
      0,
    );
    if (
      piPreflightCompactionRequired(
        historyTokens,
        runtimeInputTokenEstimate(latest),
        request.context_window_tokens,
        request.max_output_tokens,
      )
    ) {
      await session.compact(
        "Keep the checkpoint concise. Preserve exact user constraints, named facts, tool results, unresolved work, and decisions needed for the next response. Copy every named label or identifier and the sentence it names verbatim; do not shorten or paraphrase named facts. Keep each label adjacent to its fact so later references remain resolvable.",
      );
    }
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
