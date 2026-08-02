import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

export type Provider = "anthropic" | "fireworks" | "tinker";
export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string };
export type PriceTable = { inputUsdPerMillion: number; outputUsdPerMillion: number };
export type TokenUsage = { prompt: number; completion: number };

export type TransportRequest = {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: 0;
  reasoningEffort?: "low";
  samplerUrl?: string;
};

export type TransportResponse = {
  content: string;
  usage: TokenUsage;
  status: number;
  rawPayload?: unknown;
};

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export class BudgetLedger {
  readonly budgetUsd: number;
  private spent = 0;
  private calls = 0;
  private promptTokens = 0;
  private completionTokens = 0;

  constructor(budgetUsd: number) {
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error("budget must be a nonnegative finite number");
    this.budgetUsd = budgetUsd;
  }

  reserve(prompt: number, completion: number, price: PriceTable): number {
    const usd = (prompt * price.inputUsdPerMillion + completion * price.outputUsdPerMillion) / 1_000_000;
    if (this.spent + usd > this.budgetUsd + 1e-12) {
      throw new Error(`budget exceeded: attempted $${usd.toFixed(8)} with $${this.remainingUsd().toFixed(8)} remaining`);
    }
    this.spent += usd;
    this.calls += 1;
    this.promptTokens += prompt;
    this.completionTokens += completion;
    return usd;
  }

  remainingUsd(): number { return Math.max(0, this.budgetUsd - this.spent); }
  summary(): { calls: number; promptTokens: number; completionTokens: number; usd: number; budgetUsd: number } {
    return { calls: this.calls, promptTokens: this.promptTokens, completionTokens: this.completionTokens, usd: this.spent, budgetUsd: this.budgetUsd };
  }
}

export type ModelEpisode = {
  taskId: string;
  split: string;
  benchmarkId: string;
  messages: ChatMessage[];
  applyToolCall: (tool: string, args: Record<string, unknown>) => { result: unknown; done: boolean };
  score: (finalContent: string, parseFailures: number) => { score: number | null; status: "ok" | "error"; subscores: Record<string, number> };
  isFinalContent?: (content: string) => boolean;
  contentHashes: { env_sha256: string; verifier_sha256: string };
};

export type ModelTaskAdapter = {
  taskIds(options: { split: string; frozenHoldoutSha256?: string }): string[];
  start(taskId: string): ModelEpisode;
  splitSha256(split: string): string;
  harnessSha256?: string;
};

export type ModelRunOptions = {
  adapter: ModelTaskAdapter;
  split: string;
  frozenHoldoutSha256?: string;
  runId: string;
  model: string;
  provider: Provider;
  price: PriceTable;
  budget: BudgetLedger;
  receiptsPath?: string;
  debugTranscriptsPath?: string;
  maxTokens?: number;
  maxSteps?: number;
  instructionOverride?: string;
  tinkerSamplerUrl?: string;
  transport?: Transport;
};

function instruction(): string {
  return [
    "Available tools: api_search searches the in-memory app catalog with arguments {query}; api_fetch reads or writes an in-memory endpoint with arguments {method,url,body}.",
    "api_fetch arguments must contain method, url, and body (use {} when no body is needed).",
    'Worked example (irrelevant to this task): {"tool":"api_fetch","arguments":{"method":"GET","url":"/example","body":{}}}.',
    "Reply with exactly one JSON object per turn and no prose.",
    'For a tool call use {"tool":"api_search","arguments":{...}} or {"tool":"api_fetch","arguments":{...}}.',
    'To finish use {"tool":"finish"}.',
  ].join(" ");
}

export function parseAction(content: string): { tool: string; arguments: Record<string, unknown> } | null {
  const extract = (input: string): string | null => {
    const start = input.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < input.length; index += 1) {
      const character = input[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) return input.slice(start, index + 1);
    }
    return null;
  };
  try {
    const value = JSON.parse(extract(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()) ?? "") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const tool = typeof record.tool === "string" ? record.tool : null;
    if (!tool) return null;
    const args = record.arguments;
    return { tool, arguments: args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {} };
  } catch {
    return null;
  }
}

async function defaultTransport(request: TransportRequest): Promise<TransportResponse> {
  const url = request.provider === "anthropic"
    ? "https://api.anthropic.com/v1/messages"
    : request.provider === "fireworks"
      ? "https://api.fireworks.ai/inference/v1/chat/completions"
      : `${request.samplerUrl ?? process.env.TINKER_SAMPLER_URL ?? "http://127.0.0.1:8790"}/sample`;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  let body: Record<string, unknown>;
  if (request.provider === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    body = {
      model: request.model,
      system,
      messages: request.messages
        .filter((message) => message.role !== "system")
        .map((message) => message.role === "tool"
          ? { role: "user", content: `Tool result: ${message.content}` }
          : { role: message.role, content: message.content }),
      temperature: 0,
      max_tokens: request.maxTokens,
    };
  } else if (request.provider === "fireworks") {
    const key = process.env.FIREWORKS_API_KEY;
    if (!key) throw new Error("FIREWORKS_API_KEY is not set");
    headers.authorization = `Bearer ${key}`;
    body = {
      model: request.model,
      messages: request.messages.map((message) => message.role === "tool"
        ? { role: "user", content: `Tool result: ${message.content}` }
        : message),
      temperature: 0,
      max_tokens: request.maxTokens,
      stream: false,
      ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
      ...(request.model.includes("gpt-oss") ? { response_format: { type: "json_object" } } : {}),
    };
  } else {
    body = {
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    };
  }
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const responseText = await response.text();
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    // Preserve the body snippet in the transport error below.
  }
  if (!response.ok) {
    const error = value.error && typeof value.error === "object" ? JSON.stringify(value.error) : responseText.slice(0, 400);
    throw Object.assign(new Error(error || `HTTP ${response.status}`), { status: response.status, bodySnippet: responseText.slice(0, 400) });
  }
  const usage = (value.usage && typeof value.usage === "object" ? value.usage : {}) as Record<string, unknown>;
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.prompt ?? 0);
  const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.completion ?? 0);
  const content = request.provider === "anthropic"
    ? (((Array.isArray(value.content) ? value.content[0] : null) as Record<string, unknown> | null)?.text ?? "")
    : request.provider === "fireworks"
      ? (((value.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined)?.content ?? "")
      : (value.content ?? "");
  return { content: String(content), usage: { prompt, completion }, status: response.status, rawPayload: value };
}

function isRetryable(error: unknown): boolean {
  const status = Number((error as { status?: number })?.status ?? 0);
  return status === 429 || status >= 500;
}

async function callWithRetry(request: TransportRequest, transport: Transport): Promise<TransportResponse> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await transport(request);
    } catch (error) {
      last = error;
      if (!isRetryable(error) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function runModelRows(options: ModelRunOptions): Promise<Record<string, unknown>[]> {
  const transport = options.transport ?? defaultTransport;
  const rows: Record<string, unknown>[] = [];
  const maxSteps = options.maxSteps ?? 12;
  const maxTokens = options.maxTokens ?? 640;
  const taskIds = options.adapter.taskIds({ split: options.split, frozenHoldoutSha256: options.frozenHoldoutSha256 });
  if (options.receiptsPath) mkdirSync(dirname(options.receiptsPath), { recursive: true });
  for (const taskId of taskIds) {
    const episode = options.adapter.start(taskId);
    const messages: ChatMessage[] = episode.messages.map((message) => ({ ...message }));
    messages[0] = {
      role: "system",
      content: options.instructionOverride ?? `${messages[0]?.content ?? ""}\n\n${instruction()}`,
    };
    let finalContent = "";
    let parseFailures = 0;
    let transportError: Error | null = null;
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalUsd = 0;
    let totalLatency = 0;
    const transcript: Record<string, unknown>[] = [];
    let repairUsed = false;
    for (let step = 0; step < maxSteps; step += 1) {
      const started = performance.now();
      let response: TransportResponse;
      const requestMessages = messages.map((message) => ({ ...message }));
      try {
        response = await callWithRetry({
          provider: options.provider,
          model: options.model,
          messages: requestMessages,
          maxTokens,
          temperature: 0,
          ...(options.provider === "fireworks" && options.model.includes("gpt-oss") ? { reasoningEffort: "low" as const } : {}),
          ...(options.provider === "tinker" ? { samplerUrl: options.tinkerSamplerUrl } : {}),
        }, transport);
      } catch (error) {
        transportError = error instanceof Error ? error : new Error(String(error));
        if (options.receiptsPath) appendFileSync(options.receiptsPath, `${JSON.stringify({
          run_id: options.runId, task_id: taskId, step, model: options.model,
          tokens: { prompt: 0, completion: 0 }, usd: 0, latency_ms: Math.round(performance.now() - started),
          http_status: Number((error as { status?: number })?.status ?? 0),
          error: transportError.message.slice(0, 400),
          error_body: String((error as { bodySnippet?: string })?.bodySnippet ?? transportError.message).slice(0, 400),
        })}\n`);
        break;
      }
      const latency = Math.round(performance.now() - started);
      const usd = options.budget.reserve(response.usage.prompt, response.usage.completion, options.price);
      totalPrompt += response.usage.prompt;
      totalCompletion += response.usage.completion;
      totalUsd += usd;
      totalLatency += latency;
      if (options.receiptsPath) appendFileSync(options.receiptsPath, `${JSON.stringify({
        run_id: options.runId, task_id: taskId, step, model: options.model,
        tokens: response.usage, usd, latency_ms: latency, http_status: response.status,
        raw_reply: response.content.slice(0, 400),
        ...(response.content.length === 0 ? { raw_payload: response.rawPayload } : {}),
      })}\n`);
      transcript.push({ step, request: requestMessages, response: response.content, raw_payload: response.rawPayload, usage: response.usage, http_status: response.status });
      finalContent = response.content;
      if (episode.isFinalContent?.(response.content)) break;
      const action = parseAction(response.content);
      if (!action) {
        parseFailures += 1;
        if (!repairUsed) {
          repairUsed = true;
          messages.push({ role: "assistant", content: response.content });
          messages.push({ role: "user", content: "Your previous reply was not a single JSON object. Reply with only the JSON object and no prose." });
          continue;
        }
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      if (action.tool === "finish") break;
      if (action.tool !== "api_search" && action.tool !== "api_fetch") {
        parseFailures += 1;
        break;
      }
      const applied = episode.applyToolCall(action.tool, action.arguments);
      messages.push({
        role: "tool",
        content: options.provider === "tinker" && typeof applied.result === "string"
          ? applied.result
          : JSON.stringify(applied.result),
      });
      if (applied.done) break;
    }
    if (options.debugTranscriptsPath) {
      mkdirSync(dirname(options.debugTranscriptsPath), { recursive: true });
      appendFileSync(options.debugTranscriptsPath, `${JSON.stringify({
        run_id: options.runId, task_id: taskId, model: options.model, split: episode.split, messages, transcript,
      })}\n`);
    }
    const result = transportError
      ? { score: null, status: "error" as const, subscores: { parse_failures: parseFailures } }
      : episode.score(finalContent, parseFailures);
    rows.push({
      schema_version: "understudy.eval_result.v1",
      run_id: options.runId,
      task_id: taskId,
      split: episode.split,
      score: result.score,
      status: result.status,
      model: options.model,
      route: options.provider === "anthropic"
        ? "anthropic-api"
        : options.provider === "fireworks"
          ? "fireworks-openai-compat"
          : "tinker-sampling",
      tokens: { prompt: totalPrompt, completion: totalCompletion },
      cost: { usd: totalUsd, basis: "estimated, caller-supplied price table" },
      latency_ms: totalLatency,
      benchmark_id: episode.benchmarkId,
      subscores: result.subscores,
      provenance: {
        harness_sha256: options.adapter.harnessSha256 ?? null,
        split_sha256: options.adapter.splitSha256(episode.split),
        task_content_hashes: episode.contentHashes,
      },
    });
  }
  return rows;
}

export { defaultTransport as providerTransport };
