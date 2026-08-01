import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

export type Provider = "anthropic" | "fireworks";
export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string };
export type PriceTable = { inputUsdPerMillion: number; outputUsdPerMillion: number };
export type TokenUsage = { prompt: number; completion: number };

export type TransportRequest = {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: 0;
};

export type TransportResponse = {
  content: string;
  usage: TokenUsage;
  status: number;
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
  maxTokens?: number;
  maxSteps?: number;
  transport?: Transport;
};

function instruction(): string {
  return [
    "Reply with exactly one JSON object per turn and no prose.",
    'For a tool call use {"tool":"api_search","arguments":{...}} or {"tool":"api_fetch","arguments":{...}}.',
    'To finish use {"tool":"finish"}.',
  ].join(" ");
}

function parseAction(content: string): { tool: string; arguments: Record<string, unknown> } | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const value = JSON.parse(trimmed) as unknown;
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
    : "https://api.fireworks.ai/inference/v1/chat/completions";
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
  } else {
    const key = process.env.FIREWORKS_API_KEY;
    if (!key) throw new Error("FIREWORKS_API_KEY is not set");
    headers.authorization = `Bearer ${key}`;
    body = { model: request.model, messages: request.messages, temperature: 0, max_tokens: request.maxTokens, stream: false };
  }
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const value = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = value.error && typeof value.error === "object" ? JSON.stringify(value.error) : `HTTP ${response.status}`;
    throw Object.assign(new Error(error), { status: response.status });
  }
  const usage = (value.usage && typeof value.usage === "object" ? value.usage : {}) as Record<string, unknown>;
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const content = request.provider === "anthropic"
    ? (((Array.isArray(value.content) ? value.content[0] : null) as Record<string, unknown> | null)?.text ?? "")
    : (((value.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined)?.content ?? "");
  return { content: String(content), usage: { prompt, completion }, status: response.status };
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
  const maxSteps = options.maxSteps ?? 8;
  const maxTokens = options.maxTokens ?? 256;
  const taskIds = options.adapter.taskIds({ split: options.split, frozenHoldoutSha256: options.frozenHoldoutSha256 });
  if (options.receiptsPath) mkdirSync(dirname(options.receiptsPath), { recursive: true });
  for (const taskId of taskIds) {
    const episode = options.adapter.start(taskId);
    const messages: ChatMessage[] = episode.messages.map((message) => ({ ...message }));
    messages[0] = { role: "system", content: `${messages[0]?.content ?? ""}\n\n${instruction()}` };
    let finalContent = "";
    let parseFailures = 0;
    let transportError: Error | null = null;
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalUsd = 0;
    let totalLatency = 0;
    for (let step = 0; step < maxSteps; step += 1) {
      const started = performance.now();
      let response: TransportResponse;
      try {
        response = await callWithRetry({ provider: options.provider, model: options.model, messages, maxTokens, temperature: 0 }, transport);
      } catch (error) {
        transportError = error instanceof Error ? error : new Error(String(error));
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
      })}\n`);
      finalContent = response.content;
      if (episode.isFinalContent?.(response.content)) break;
      const action = parseAction(response.content);
      if (!action) {
        parseFailures += 1;
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      if (action.tool === "finish") break;
      if (action.tool !== "api_search" && action.tool !== "api_fetch") {
        parseFailures += 1;
        break;
      }
      const applied = episode.applyToolCall(action.tool, action.arguments);
      messages.push({ role: "tool", content: JSON.stringify(applied.result) });
      if (applied.done) break;
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
      route: options.provider === "anthropic" ? "anthropic-api" : "fireworks-openai-compat",
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
