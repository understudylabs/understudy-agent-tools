import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type JsonObject = Record<string, any>;

export type RateCardEntry = {
  input: number;
  cache_read: number;
  cache_creation: number;
  output: number;
  source: string;
  checked_at: string;
  rate_basis?: "nnls" | "blended_fallback" | "published";
  r2?: number;
};

export type RepairRateCard = {
  schema_version: "understudy.repair_rate_card.v1";
  candidate_model: string;
  models: Record<string, RateCardEntry>;
};

export type RepairCapture = {
  workload_id: string | null;
  workload_name: string | null;
  provider: string | null;
  requested_model: string | null;
  served_model: string | null;
  endpoint: string | null;
  status_code: number | null;
  latency_ms: number | null;
  captured_at: string;
  system: string;
  messages: JsonObject[];
  tools: JsonObject[];
  settings: JsonObject;
  response: JsonObject;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  token_source: "observed" | "estimated";
  request_chars: number;
  response_chars: number;
};

export type Fingerprints = {
  task_fingerprint: string;
  variant_fingerprint: string;
};

export type RepairRankOptions = {
  windowDays?: number;
  minClusterSize?: number;
  anonymize?: boolean;
  now?: Date;
  captureStats?: {
    total_read: number;
    skipped_captures: {
      total: number;
      missing_timestamp: number;
      invalid_timestamp: number;
    };
  };
  aliases?: RepairAliasMap;
  populationScale?: number;
  samplingMethod?: string;
  headroomWeights?: {
    brevity?: number;
    structured?: number;
    context?: number;
    errors?: number;
  };
};

export type RepairQueue = {
  schema_version: "understudy.repair_queue.v1";
  generated_at: string;
  window: { from: string; to: string; days: number };
  candidate_model: string;
  rate_card: { source_models: number; checked_at: string[] };
  parameters: {
    min_cluster_size: number;
    headroom_weights: { brevity: number; structured: number; context: number; errors: number };
    observed_from: string | null;
    observed_to: string | null;
    observed_days: number;
    total_captures_read: number;
    total_captures_ranked: number;
  };
  skipped_captures: {
    total: number;
    missing_timestamp: number;
    invalid_timestamp: number;
  };
  missing_rate_models: string[];
  sampling: {
    population_scale: number;
    sampled_captures: number;
    sampling_method: string;
  };
  anonymized: boolean;
  workloads: RepairWorkload[];
};

export type RepairWorkload = {
  workload: { alias: string; id_hash: string; name_hash: string };
  factors: {
    volume: number;
    repeatability: number;
    incumbent_headroom: number;
    serving_cost_delta: number;
  };
  roi_score: number;
  projected_savings_usd: {
    conservative: number | null;
    optimistic: number | null;
  };
  raw: {
    request_count: number;
    sampled_request_count: number;
    requests_per_day: number;
    distinct_task_fingerprints: number;
    top1_cluster_share: number;
    top5_cluster_share: number;
    effective_task_count: number;
    addressable_share: number;
    addressable_requests: number;
    median_output_tokens: number;
    structured_output_share: number;
    median_input_tokens: number;
    error_rate: number;
    confidence: number;
    dominant_incumbent_model: string;
    candidate_model: string;
    model_mix: Record<string, { request_count: number; cost_share: number; priced: boolean }>;
    rate_basis: Record<string, { basis: "nnls" | "blended_fallback" | "published" | "unknown"; r2: number | null }>;
    fallback_rate_models: string[];
    unpriced_request_share: number;
    unpriced_models: string[];
    no_opportunity_reason: "already_on_candidate" | "candidate_not_cheaper" | "unpriced" | null;
    incumbent_cost_30d_usd: number;
    candidate_cost_30d_usd: number;
    token_source: "observed" | "estimated" | "mixed";
    observed_token_share: number;
    estimated_request_count: number;
  };
};

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const number = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const base26 = (value: number): string => {
  let result = "";
  let current = value;
  do {
    result = String.fromCharCode(97 + (current % 26)) + result;
    current = Math.floor(current / 26) - 1;
  } while (current >= 0);
  return result;
};
const jsonish = (value: unknown): unknown => {
  let current = value;
  for (let i = 0; i < 3 && typeof current === "string"; i += 1) {
    try { current = JSON.parse(current); } catch { break; }
  }
  return current;
};

function sourceFiles(input: string): string[] {
  const path = resolve(input);
  if (!existsSync(path)) throw new Error(`Capture source does not exist: ${path}`);
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? sourceFiles(child) :
      /\.(json|jsonl|ndjson)$/i.test(entry.name) ? [child] : [];
  }).sort();
}

function rows(path: string): JsonObject[] {
  const raw = readFileSync(path, "utf8");
  if (path.toLowerCase().endsWith(".json")) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(object);
    const value = object(parsed);
    return Array.isArray(value.captures) ? value.captures.map(object) : Array.isArray(value.data) ? value.data.map(object) : [value];
  }
  return raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => object(JSON.parse(line)));
}

function responseProjection(raw: unknown): JsonObject {
  const parsed = jsonish(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return object(parsed);
  if (typeof raw === "string" && /^\s*data:/m.test(raw)) {
    const usage: JsonObject = {};
    const toolCalls: JsonObject[] = [];
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const frame = object(JSON.parse(data));
        const frameUsage = object(frame.usage ?? object(frame.message).usage);
        Object.assign(usage, frameUsage);
        const choices = Array.isArray(frame.choices) ? frame.choices : [];
        for (const choice of choices) {
          const calls = object(object(choice).delta).tool_calls;
          if (Array.isArray(calls)) toolCalls.push(...calls.map(object));
        }
      } catch {
        // Ignore non-JSON SSE comments and provider keep-alive frames.
      }
    }
    return { text: raw, usage, tool_calls: toolCalls };
  }
  return { text: text(raw) };
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => text(object(part).text) || text(object(part).content)).join("");
}

function responseText(response: JsonObject): string {
  return text(response.text) || contentText(response.content) || contentText(response.output_text) ||
    (Array.isArray(response.choices) ? response.choices.map((choice) => contentText(object(object(choice).message).content)).join("") : "");
}

function hasStructuredResponse(response: JsonObject): boolean {
  if (Array.isArray(response.tool_calls) && response.tool_calls.length > 0) return true;
  if (response.stop_reason === "tool_use") return true;
  if (Array.isArray(response.content) && response.content.some((part) => object(part).type === "tool_use")) return true;
  return Array.isArray(response.choices) && response.choices.some((choice) => {
    const message = object(object(choice).message);
    return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  });
}

function usageFrom(envelope: JsonObject, request: JsonObject, response: JsonObject): { input: number | null; output: number | null; read: number; creation: number } {
  const usage = object(envelope.usage ?? request.usage ?? response.usage);
  const input = number(usage.input_tokens ?? usage.prompt_tokens ?? envelope.input_tokens ?? envelope.prompt_tokens);
  const output = number(usage.output_tokens ?? usage.completion_tokens ?? envelope.output_tokens ?? envelope.completion_tokens);
  return {
    input,
    output,
    read: number(usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? envelope.cache_read_input_tokens) ?? 0,
    creation: number(usage.cache_creation_input_tokens ?? envelope.cache_creation_input_tokens) ?? 0,
  };
}

export type RepairCaptureBatch = {
  captures: RepairCapture[];
  total_read: number;
  skipped_captures: {
    total: number;
    missing_timestamp: number;
    invalid_timestamp: number;
  };
};

export function readRepairCaptures(input: string): RepairCapture[] {
  return readRepairCaptureBatch(input).captures;
}

export function readRepairCaptureBatch(input: string): RepairCaptureBatch {
  const skipped_captures = { total: 0, missing_timestamp: 0, invalid_timestamp: 0 };
  const captures = sourceFiles(input).flatMap((path) => rows(path).map((envelope): RepairCapture | null => {
    const normalized = envelope.schema_version === "understudy.normalized_capture.v1";
    const scope = object(envelope.scope);
    const routing = object(envelope.routing);
    const transport = object(envelope.transport);
    const request = object(jsonish(normalized ? envelope.request : envelope.customer_request_body ?? envelope.request_body ?? envelope.request));
    const response = responseProjection(normalized ? envelope.response : envelope.response_body ?? envelope.customer_response_body ?? envelope.response);
    const messages = Array.isArray(request.messages) ? request.messages.map(object) : [];
    const tools = Array.isArray(request.tools) ? request.tools.map(object) : [];
    const system = text(request.system);
    const captured_at = text(normalized ? envelope.captured_at : envelope.ts ?? envelope.created_at ?? envelope.uploaded);
    if (!captured_at) {
      skipped_captures.total += 1;
      skipped_captures.missing_timestamp += 1;
      return null;
    }
    if (Number.isNaN(Date.parse(captured_at))) {
      skipped_captures.total += 1;
      skipped_captures.invalid_timestamp += 1;
      return null;
    }
    const requestBody = JSON.stringify(request);
    const responseBody = JSON.stringify(response);
    const usage = usageFrom(envelope, request, response);
    const tokenSource = usage.input !== null && usage.output !== null ? "observed" : "estimated";
    return {
      workload_id: normalized ? text(scope.workload_id) || null : text(envelope.workload_id ?? envelope.placement_id) || null,
      workload_name: normalized ? text(scope.workload_name) || null : text(envelope.workload_name) || null,
      provider: normalized ? text(routing.provider) || null : text(envelope.provider) || null,
      requested_model: normalized ? text(routing.requested_model) || null : text(envelope.requested_model ?? request.model) || null,
      served_model: normalized ? text(routing.upstream_model) || null : text(envelope.upstream_model ?? envelope.served_model ?? envelope.model) || null,
      endpoint: normalized ? text(transport.endpoint) || null : text(envelope.endpoint) || null,
      status_code: number(normalized ? transport.status_code : envelope.status_code),
      latency_ms: number(normalized ? transport.latency_ms : envelope.latency_ms),
      captured_at,
      system,
      messages,
      tools,
      settings: object(request.settings ?? Object.fromEntries(Object.entries(request).filter(([key]) => !["system", "messages", "tools"].includes(key)))),
      response,
      input_tokens: usage.input ?? Math.ceil(requestBody.length / 4),
      output_tokens: usage.output ?? Math.ceil(responseBody.length / 4),
      cache_read_input_tokens: usage.read,
      cache_creation_input_tokens: usage.creation,
      token_source: tokenSource,
      request_chars: requestBody.length,
      response_chars: responseBody.length,
    };
  }).filter((capture): capture is RepairCapture => capture !== null));
  return {
    captures,
    total_read: captures.length + skipped_captures.total,
    skipped_captures,
  };
}

const mask = (value: string): string => value
  .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
  .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
  .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, "<date>")
  .replace(/(["'“”]).{3,200}?\1/g, "<quoted>")
  .replace(/\b[A-Za-z0-9+/]{24,}={0,2}\b/g, "<blob>")
  .replace(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g, "<num>");

export function maskRepairText(value: string): string { return mask(value); }

function roleSkeleton(messages: JsonObject[]): string {
  const roles: string[] = [];
  for (const message of messages) {
    const role = text(message.role) || "unknown";
    if (roles.at(-1) !== role) roles.push(role);
  }
  return roles.join(">");
}

function roleSet(messages: JsonObject[]): string[] {
  return [...new Set(messages.map((message) => text(message.role) || "unknown"))].sort();
}

function settingShape(settings: JsonObject): JsonObject {
  const max = number(settings.max_tokens ?? settings.max_completion_tokens);
  const temperature = number(settings.temperature);
  const responseFormat = object(settings.response_format);
  const jsonSchema = object(responseFormat.json_schema);
  return {
    has_tools: false,
    tool_choice: typeof settings.tool_choice === "string" ? settings.tool_choice : object(settings.tool_choice).type ?? null,
    response_format: responseFormat.type ?? null,
    json_schema_name: text(jsonSchema.name) || null,
    max_tokens_bucket: max === null ? null : max <= 256 ? "small" : max <= 2048 ? "medium" : "large",
    temperature_bucket: temperature === null ? null : temperature === 0 ? "zero" : temperature <= 0.7 ? "low" : "high",
  };
}

export function repairFingerprints(capture: RepairCapture): Fingerprints {
  const workloadKey = capture.workload_id || capture.workload_name || "unknown";
  const setting = settingShape(capture.settings);
  setting.has_tools = capture.tools.length > 0;
  const task = {
    workload: workloadKey,
    endpoint: capture.endpoint,
    system: mask(capture.system).slice(0, 4096),
    tools: [...new Set(capture.tools.map((tool) => text(tool.name) || text(object(tool.function).name)))].sort(),
    roles: roleSet(capture.messages),
    shape: setting,
  };
  const taskFingerprint = sha(task).slice(0, 32);
  const firstUser = capture.messages.find((message) => message.role === "user");
  const userText = mask(contentText(firstUser?.content));
  const tokens = [...new Set(userText.toLowerCase().split(/[^a-z0-9<>]+/).filter((token) => token.length > 2))];
  const shingles = tokens.slice(0, 40).map((token, index) => `${tokens[index - 1] ?? "^"}:${token}`).slice(0, 32);
  return {
    task_fingerprint: taskFingerprint,
    variant_fingerprint: sha({ taskFingerprint, role_skeleton: roleSkeleton(capture.messages), shingles }).slice(0, 32),
  };
}

function rateCard(value: unknown): RepairRateCard {
  const card = object(value) as Partial<RepairRateCard>;
  if (card.schema_version !== "understudy.repair_rate_card.v1" || typeof card.candidate_model !== "string" || !card.models) {
    throw new Error("rate card must use understudy.repair_rate_card.v1 with candidate_model and models");
  }
  for (const [model, entry] of Object.entries(card.models)) {
    const row = entry as RateCardEntry;
    for (const key of ["input", "cache_read", "cache_creation", "output"] as const) {
      if (!Number.isFinite(row[key]) || row[key] < 0) throw new Error(`rate card model ${model} has invalid ${key} price`);
    }
    if (!row.source || !row.checked_at) throw new Error(`rate card model ${model} requires source and checked_at`);
  }
  if (!card.models[card.candidate_model]) throw new Error(`rate card is missing candidate model ${card.candidate_model}`);
  return card as RepairRateCard;
}

export function readRepairRateCard(path: string): RepairRateCard { return rateCard(JSON.parse(readFileSync(resolve(path), "utf8"))); }

function median(values: number[]): number { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]; }
function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function modelOf(capture: RepairCapture): string { return capture.served_model || capture.requested_model || "unknown"; }
function workloadKey(capture: RepairCapture): string { return capture.workload_id || capture.workload_name || "unknown"; }

export type RepairAliasMap = Map<string, string>;

export function deriveRepairAliases(captures: RepairCapture[]): RepairAliasMap {
  const keys = [...new Set(captures.map(workloadKey))].sort((a, b) => sha(a).localeCompare(sha(b)));
  return new Map(keys.map((key, index) => [key, `workload-${base26(index)}`]));
}

export function filterRepairCapturesToWindow(captures: RepairCapture[], now: Date, days: number): RepairCapture[] {
  const fromMs = now.valueOf() - days * 86_400_000;
  return captures.filter((capture) => {
    const timestamp = Date.parse(capture.captured_at);
    return !Number.isNaN(timestamp) && timestamp >= fromMs && timestamp <= now.valueOf();
  });
}

export function rankRepairTargets(captures: RepairCapture[], card: RepairRateCard, options: RepairRankOptions = {}): RepairQueue {
  const now = options.now ?? new Date();
  const days = options.windowDays ?? 30;
  const minClusterSize = options.minClusterSize ?? 20;
  const populationScale = options.populationScale ?? 1;
  if (!Number.isFinite(populationScale) || populationScale < 1) {
    throw new Error("population scale must be a finite number greater than or equal to 1");
  }
  const samplingMethod = options.samplingMethod ?? (populationScale > 1 ? "uniform sample; caller-supplied stratification" : "none");
  const fromMs = now.valueOf() - days * 86_400_000;
  const inWindow = filterRepairCapturesToWindow(captures, now, days);
  const timestamps = inWindow.map((capture) => Date.parse(capture.captured_at)).filter(Number.isFinite);
  const actualDays = Math.max(1 / 24, Math.min(days, timestamps.length > 1 ? (Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000 : days));
  const groups = new Map<string, RepairCapture[]>();
  for (const capture of inWindow) {
    const key = workloadKey(capture);
    const list = groups.get(key) ?? [];
    list.push(capture);
    groups.set(key, list);
  }
  const aliasMap = options.aliases ?? deriveRepairAliases(inWindow);
  const anonymized = options.anonymize ?? true;
  const workloads: RepairWorkload[] = [];
  const missingRateModels = new Set<string>();
  const maxCount = Math.max(1, ...[...groups.values()].map((rowsForWorkload) => rowsForWorkload.length));
  for (const [key, workloadCaptures] of groups) {
    const fingerprintRows = workloadCaptures.map((capture) => ({ capture, fingerprints: repairFingerprints(capture) }));
    const taskCounts = new Map<string, number>();
    for (const row of fingerprintRows) taskCounts.set(row.fingerprints.task_fingerprint, (taskCounts.get(row.fingerprints.task_fingerprint) ?? 0) + 1);
    const shares = [...taskCounts.values()].map((count) => count / workloadCaptures.length).sort((a, b) => b - a);
    const hhi = shares.reduce((sum, share) => sum + share * share, 0);
    const addressableRequests = [...taskCounts.values()].filter((count) => count >= minClusterSize).reduce((sum, count) => sum + count, 0);
    const inputTokens = workloadCaptures.map((capture) => capture.input_tokens ?? 0);
    const outputTokens = workloadCaptures.map((capture) => capture.output_tokens ?? 0);
    const structured = workloadCaptures.filter((capture) => hasStructuredResponse(capture.response) || capture.response.type === "json" || responseText(capture.response).trim().startsWith("{")).length;
    const errors = workloadCaptures.filter((capture) => (capture.status_code ?? 200) >= 400).length;
    const candidateRate = card.models[card.candidate_model];
    const modelTotals = new Map<string, { requests: number; input: number; output: number; read: number; creation: number; cost: number; priced: boolean }>();
    for (const capture of workloadCaptures) {
      const model = modelOf(capture);
      const total = modelTotals.get(model) ?? { requests: 0, input: 0, output: 0, read: 0, creation: 0, cost: 0, priced: Boolean(card.models[model]) };
      total.requests += 1;
      total.input += capture.input_tokens ?? 0;
      total.output += capture.output_tokens ?? 0;
      total.read += capture.cache_read_input_tokens;
      total.creation += capture.cache_creation_input_tokens;
      const rate = card.models[model];
      if (rate) total.cost += (capture.input_tokens ?? 0) * rate.input + capture.cache_read_input_tokens * rate.cache_read + capture.cache_creation_input_tokens * rate.cache_creation + (capture.output_tokens ?? 0) * rate.output;
      else missingRateModels.add(model);
      modelTotals.set(model, total);
    }
    const incumbentCost = [...modelTotals.values()].reduce((sum, total) => sum + total.cost, 0) / 1_000_000;
    const allInput = inputTokens.reduce((sum, value) => sum + value, 0);
    const allOutput = outputTokens.reduce((sum, value) => sum + value, 0);
    const allRead = workloadCaptures.reduce((sum, capture) => sum + capture.cache_read_input_tokens, 0);
    const allCreation = workloadCaptures.reduce((sum, capture) => sum + capture.cache_creation_input_tokens, 0);
    const candidateCost = (allInput * candidateRate.input + allRead * candidateRate.cache_read + allCreation * candidateRate.cache_creation + allOutput * candidateRate.output) / 1_000_000;
    const unpricedModels = [...modelTotals.entries()].filter(([, total]) => !total.priced).map(([model]) => model).sort();
    const unpricedRequests = [...modelTotals.entries()].filter(([, total]) => !total.priced).reduce((sum, [, total]) => sum + total.requests, 0);
    const modelMix = Object.fromEntries([...modelTotals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, total]) => [model, {
      request_count: total.requests * populationScale,
      cost_share: incumbentCost > 0 && total.priced ? (total.cost / 1_000_000) / incumbentCost : 0,
      priced: total.priced,
    }]));
    const rateBasis = Object.fromEntries([...modelTotals.keys()].sort().map((model) => {
      const entry = card.models[model];
      return [model, {
        basis: (entry?.rate_basis ?? "unknown") as "nnls" | "blended_fallback" | "published" | "unknown",
        r2: typeof entry?.r2 === "number" ? entry.r2 : null,
      }];
    }));
    const fallbackRateModels = [...modelTotals.keys()].filter((model) => card.models[model]?.rate_basis === "blended_fallback").sort();
    const dominantIncumbentModel = [...modelTotals.entries()].filter(([, total]) => total.priced).sort(([, a], [, b]) => b.cost - a.cost)[0]?.[0] ?? "unknown";
    const volume = Math.log1p(workloadCaptures.length) / Math.log1p(maxCount);
    const repeatability = hhi;
    const medianOutput = median(outputTokens);
    const medianInput = median(inputTokens);
    const brevity = 1 - clamp(medianOutput / 1024);
    const contextPenalty = 1 - clamp(medianInput / 16_000);
    const errorPenalty = 1 - errors / workloadCaptures.length;
    const weights = { brevity: 0.35, structured: 0.35, context: 0.2, errors: 0.1, ...options.headroomWeights };
    const weightTotal = weights.brevity + weights.structured + weights.context + weights.errors || 1;
    const headroom = clamp((weights.brevity * brevity + weights.structured * (structured / workloadCaptures.length) + weights.context * contextPenalty + weights.errors * errorPenalty) / weightTotal);
    const delta = unpricedModels.length === 0 && incumbentCost > 0 ? clamp(1 - candidateCost / incumbentCost) : 0;
    const noOpportunityReason = unpricedModels.length > 0
      ? "unpriced"
      : delta <= 0
        ? (modelTotals.size === 1 && modelTotals.has(card.candidate_model) ? "already_on_candidate" : "candidate_not_cheaper")
        : null;
    const roi = volume * repeatability * headroom * delta;
    const dailyIncumbent = incumbentCost / actualDays;
    const savings30 = unpricedModels.length === 0 ? Math.max(0, (dailyIncumbent - candidateCost / actualDays) * 30 * populationScale) : null;
    const alias = aliasMap.get(key) ?? "workload-unknown";
    workloads.push({
      workload: { alias: anonymized ? alias : key, id_hash: sha(key).slice(0, 16), name_hash: sha(workloadCaptures[0].workload_name ?? "").slice(0, 16) },
      factors: { volume, repeatability, incumbent_headroom: headroom, serving_cost_delta: delta },
      roi_score: roi,
      projected_savings_usd: { conservative: savings30 === null ? null : savings30 * (addressableRequests / workloadCaptures.length), optimistic: savings30 },
      raw: {
        request_count: workloadCaptures.length * populationScale,
        sampled_request_count: workloadCaptures.length,
        requests_per_day: workloadCaptures.length * populationScale / actualDays,
        distinct_task_fingerprints: taskCounts.size,
        top1_cluster_share: shares[0] ?? 0,
        top5_cluster_share: shares.slice(0, 5).reduce((sum, share) => sum + share, 0),
        effective_task_count: hhi > 0 ? 1 / hhi : 0,
        addressable_share: addressableRequests / workloadCaptures.length,
        addressable_requests: addressableRequests * populationScale,
        median_output_tokens: medianOutput,
        structured_output_share: structured / workloadCaptures.length,
        median_input_tokens: medianInput,
        error_rate: errors / workloadCaptures.length,
        confidence: clamp(Math.sqrt(workloadCaptures.length / 20)),
        dominant_incumbent_model: dominantIncumbentModel,
        candidate_model: card.candidate_model,
        model_mix: modelMix,
        rate_basis: rateBasis,
        fallback_rate_models: fallbackRateModels,
        unpriced_request_share: unpricedRequests / workloadCaptures.length,
        unpriced_models: unpricedModels,
        no_opportunity_reason: noOpportunityReason,
        incumbent_cost_30d_usd: dailyIncumbent * populationScale * 30,
        candidate_cost_30d_usd: (candidateCost / actualDays) * populationScale * 30,
        token_source: workloadCaptures.every((capture) => capture.token_source === "observed")
          ? "observed"
          : workloadCaptures.every((capture) => capture.token_source === "estimated")
            ? "estimated"
            : "mixed",
        observed_token_share: workloadCaptures.filter((capture) => capture.token_source === "observed").length / workloadCaptures.length,
        estimated_request_count: workloadCaptures.filter((capture) => capture.token_source === "estimated").length * populationScale,
      },
    });
  }
  workloads.sort((a, b) => b.roi_score - a.roi_score);
  return {
    schema_version: "understudy.repair_queue.v1",
    generated_at: now.toISOString(),
    window: { from: new Date(fromMs).toISOString(), to: now.toISOString(), days },
    candidate_model: card.candidate_model,
    rate_card: { source_models: Object.keys(card.models).length, checked_at: [...new Set(Object.values(card.models).map((entry) => entry.checked_at))].sort() },
    anonymized,
    parameters: {
      min_cluster_size: minClusterSize,
      headroom_weights: { brevity: 0.35, structured: 0.35, context: 0.2, errors: 0.1, ...options.headroomWeights },
      observed_from: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
      observed_to: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
      observed_days: timestamps.length > 1 ? (Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000 : 0,
      total_captures_read: options.captureStats?.total_read ?? captures.length,
      total_captures_ranked: inWindow.length,
    },
    skipped_captures: options.captureStats?.skipped_captures ?? { total: 0, missing_timestamp: 0, invalid_timestamp: 0 },
    missing_rate_models: [...missingRateModels].sort(),
    sampling: {
      population_scale: populationScale,
      sampled_captures: inWindow.length,
      sampling_method: samplingMethod,
    },
    workloads,
  };
}

export function renderRepairReport(queue: RepairQueue): string {
  const formatCount = (value: number): string => Math.round(value).toLocaleString();
  const rowTable = (rows: RepairWorkload[], title: string): string[] => {
    const lines = [
      title,
      "",
      "| Rank | Workload | ROI | Conservative savings / 30d | Optimistic savings / 30d | Volume | Repeatability | Headroom prior | Cost delta | Confidence | Token source | No opportunity | Fallback rates |",
      "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
    ];
    rows.forEach((row, index) => {
      const conservative = row.projected_savings_usd.conservative === null ? "— (incomplete pricing)" : `$${row.projected_savings_usd.conservative.toFixed(2)}`;
      const optimistic = row.projected_savings_usd.optimistic === null ? "— (incomplete pricing)" : `$${row.projected_savings_usd.optimistic.toFixed(2)}`;
      const pricingFlag = row.raw.unpriced_request_share > 0 ? " ⚠" : "";
      const confidenceFlag = row.raw.confidence < 0.5 ? " ⚠" : "";
      const fallbackFlag = row.raw.fallback_rate_models.length ? " ⚠" : "";
      const fallbackRates = row.raw.fallback_rate_models.map((model) => `${model} R²=${row.raw.rate_basis[model].r2?.toFixed(6) ?? "—"}`).join(", ") || "—";
      lines.push(`| ${index + 1} | ${row.workload.alias}${pricingFlag}${confidenceFlag}${fallbackFlag} | ${row.roi_score.toFixed(4)} | ${conservative} | ${optimistic} | ${formatCount(row.raw.request_count)} | ${row.factors.repeatability.toFixed(3)} | ${row.factors.incumbent_headroom.toFixed(3)} | ${row.factors.serving_cost_delta.toFixed(3)} | ${row.raw.confidence.toFixed(3)} | ${row.raw.token_source} (${(row.raw.observed_token_share * 100).toFixed(1)}% observed) | ${row.raw.no_opportunity_reason ?? "—"} | ${fallbackRates} |`);
    });
    return lines;
  };
  const savingsRows = [...queue.workloads].sort((a, b) => (b.projected_savings_usd.optimistic ?? -1) - (a.projected_savings_usd.optimistic ?? -1));
  const lines = [
    "# Repair target queue",
    "",
    `Generated ${queue.generated_at}; ${queue.window.days}-day requested window; candidate model \`${queue.candidate_model}\`.`,
    `Population quantities are projected from a ${(100 / queue.sampling.population_scale).toFixed(3)}% uniform sample (population scale ${queue.sampling.population_scale.toFixed(3)}); share-based factors remain sample statistics.`,
    `Sampling method: ${queue.sampling.sampling_method}; ${queue.sampling.sampled_captures.toLocaleString()} sampled captures, implied population ${Math.round(queue.sampling.sampled_captures * queue.sampling.population_scale).toLocaleString()} captures.`,
    `Effective observed window: ${queue.parameters.observed_from ?? "none"} to ${queue.parameters.observed_to ?? "none"} (${queue.parameters.observed_days.toFixed(3)} days).`,
    `Rate card provenance: evidence-derived observed upstream billing; checked ${queue.rate_card.checked_at.join(", ") || "date unavailable"}.`,
    "",
    "## How to read this",
    "",
    "Headroom is a heuristic prior, not measured quality. Savings are projections from the observed N-day window at the supplied rate-card prices. Conservative savings cover only addressable repeated-task clusters; optimistic savings cover all traffic. Rows with incomplete pricing show no savings number.",
    "",
  ];
  lines.push(...rowTable(queue.workloads, "## Ranked by ROI score"), "", ...rowTable(savingsRows, "## Ranked by projected optimistic savings"));
  if (queue.missing_rate_models.length) lines.push("", `⚠ Missing rate-card entries: ${queue.missing_rate_models.join(", ")}. Savings are withheld for affected rows.`);
  if (queue.workloads.some((row) => row.raw.fallback_rate_models.length)) {
    lines.push("", "⚠ Some rows depend on blended-fallback rate-card entries. Their incumbent dollars are less reliable than rows using clean NNLS rates.");
  }
  lines.push("", "Scores are aggregates only. ROI is the product of volume, repeatability, incumbent-headroom heuristic prior, and serving-cost delta. Savings are projections, not billing statements.");
  return `${lines.join("\n")}\n`;
}

export function writeRepairOutputs(queue: RepairQueue, outputDir: string): { json: string; markdown: string } {
  mkdirSync(resolve(outputDir), { recursive: true, mode: 0o700 });
  const json = join(resolve(outputDir), "repair-queue.json");
  const markdown = join(resolve(outputDir), "repair-queue.md");
  writeFileSync(json, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(markdown, renderRepairReport(queue), { mode: 0o600 });
  return { json, markdown };
}

export function writeRepairAliasMap(captures: RepairCapture[], outputDir: string, aliasMap: RepairAliasMap): string {
  const path = join(resolve(outputDir), "workload-aliases.json");
  const mapping = Object.fromEntries([...aliasMap.entries()].map(([key, alias]) => [
    alias,
    { workload_id: captures.find((capture) => workloadKey(capture) === key)?.workload_id ?? null, workload_name: captures.find((capture) => workloadKey(capture) === key)?.workload_name ?? null },
  ]));
  mkdirSync(resolve(outputDir), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(mapping, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function repairRateCardTemplate(path: string): string {
  const output = resolve(path);
  mkdirSync(resolve(output, ".."), { recursive: true, mode: 0o700 });
  const template: RepairRateCard = {
    schema_version: "understudy.repair_rate_card.v1",
    candidate_model: "<candidate-model-id>",
    models: {
      "<incumbent-model-id>": { input: 0, cache_read: 0, cache_creation: 0, output: 0, source: "Reviewed dated price source; replace all zero placeholders.", checked_at: "<YYYY-MM-DD>" },
      "<candidate-model-id>": { input: 0, cache_read: 0, cache_creation: 0, output: 0, source: "Reviewed dated price source; replace all zero placeholders.", checked_at: "<YYYY-MM-DD>" },
    },
  };
  writeFileSync(output, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
  return output;
}
