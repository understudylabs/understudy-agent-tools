import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { assertCustomerScope, resolveAuth } from "../internal/http.js";

export const TIEBREAKER_MODEL = "glm-5.2";
export const TIEBREAKER_SCHEMA = "understudy.supervision.tiebreaker_analysis.v1";
export const TIEBREAKER_FEEDBACK_SCHEMA = "understudy.supervision.tiebreaker_feedback.v1";
export const TIEBREAKER_PROMPT_PATH = fileURLToPath(
  new URL("../../runtime-assets/supervision-tiebreaker-system.txt", import.meta.url),
);

const MAX_COMPLETION_TOKENS = 512;
const REQUEST_TIMEOUT_MS = 90_000;
const STALE_LOCK_MS = 5 * 60_000;
const MAX_REQUEST_CHARS = 8_000;
const MAX_SMALL_OUTPUT_CHARS = 12_000;
const MAX_REASON_CHARS = 2_000;
const MAX_TOOL_RESULT_CHARS = 2_000;
const MAX_TOOL_RESULTS = 8;

export const TIEBREAKER_PROVIDERS = {
  lilac: {
    servedModel: "zai-org/glm-5.2",
    requestOverrides: { chat_template_kwargs: { thinking: false, enable_thinking: false } },
  },
  fireworks: {
    servedModel: "accounts/fireworks/models/glm-5p2",
    requestOverrides: { reasoning_effort: "none" },
  },
} as const;

export type TiebreakerProvider = keyof typeof TIEBREAKER_PROVIDERS;
export type TiebreakerAction = "continue" | "nudge" | "interrupt" | "stop" | "unclear";
export type TiebreakerAssessment = "agree" | "disagree" | "unclear";
export type SupervisorReasonQuality =
  | "grounded"
  | "partly_grounded"
  | "unsupported"
  | "missing"
  | "unclear";

const ToolResultSchema = z.object({
  name: z.string(),
  result: z.string(),
  result_ok: z.boolean(),
});

export const RemoteReviewInputSchema = z.object({
  marker_id: z.string().min(1),
  stage: z.enum(["nudge", "take_over"]),
  user_request: z.string(),
  small_model: z.string(),
  small_output: z.string(),
  reason: z.string(),
  reason_source: z.string(),
  tool_rounds_before_decision: z.number().int().nonnegative(),
  max_tool_rounds: z.number().int().positive(),
  tool_results: z.array(ToolResultSchema),
});

export type RemoteReviewInput = z.infer<typeof RemoteReviewInputSchema>;

export interface TiebreakerRoute {
  provider: TiebreakerProvider;
  project: string;
  workload: string;
  orgId?: string;
}

export interface RemoteReviewEvidence {
  user_request: string;
  small_model: string;
  small_output_at_decision: string;
  tool_rounds_before_decision: number;
  max_tool_rounds: number;
  tool_results_before_decision: Array<{ name: string; ok: boolean; result: string }>;
  recorded_supervisor_action: "nudge" | "interrupt";
  recorded_supervisor_reason: string;
  supervisor_reason_source: string;
}

export interface TiebreakerAnalysis {
  schema_version: typeof TIEBREAKER_SCHEMA;
  marker_id: string;
  evidence_sha256: string;
  analysis_sha256: string;
  prompt_sha256: string;
  model: typeof TIEBREAKER_MODEL;
  provider: TiebreakerProvider;
  expected_served_model: string;
  served_model: string | null;
  gateway_mode: string | null;
  gateway_route: string | null;
  effective_model: string | null;
  route_project: string;
  route_workload: string;
  status: "ok" | "error";
  recommended_action: TiebreakerAction | null;
  assessment: TiebreakerAssessment | null;
  confidence: number | null;
  reason: string | null;
  reason_quality: SupervisorReasonQuality | null;
  error: string | null;
  latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  evidence: RemoteReviewEvidence;
  created_at: string;
  cache_hit: boolean;
  user_helpful: boolean | null;
  remote_call_performed: boolean;
  upload_performed: false;
}

export interface AnalyzeTiebreakerOptions {
  input: unknown;
  route: TiebreakerRoute;
  confirmRemote: boolean;
  force?: boolean;
  fetchImpl?: typeof fetch;
  root?: string;
}

interface ParsedDecision {
  recommended_action: TiebreakerAction;
  confidence: number;
  reason: string;
  supervisor_reason_quality: SupervisorReasonQuality;
}

interface GatewayResult {
  raw: string;
  promptTokens: number | null;
  completionTokens: number | null;
  servedModel: string | null;
  gatewayMode: string | null;
  gatewayRoute: string | null;
  effectiveModel: string | null;
}

const ROUTE_NAME = /^[a-z0-9_-]{1,63}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncateChars(value: string, cap: number): string {
  return [...value].slice(0, cap).join("");
}

function safeError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return (
    raw
      .replace(/\bsk[-_][A-Za-z0-9_-]{6,}\b/g, "[redacted]")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 1_000) || "unknown error"
  );
}

export function validateTiebreakerRoute(route: TiebreakerRoute): TiebreakerRoute {
  if (!(route.provider in TIEBREAKER_PROVIDERS)) {
    throw new Error("provider must be lilac or fireworks");
  }
  for (const [label, value] of [["project", route.project], ["workload", route.workload]] as const) {
    if (!ROUTE_NAME.test(value)) {
      throw new Error(`${label} must be 1-63 lowercase alphanumeric, underscore, or hyphen characters`);
    }
  }
  return route;
}

export function buildRemoteReviewEvidence(inputValue: unknown): RemoteReviewEvidence {
  const input = RemoteReviewInputSchema.parse(inputValue);
  return {
    user_request: truncateChars(input.user_request, MAX_REQUEST_CHARS),
    small_model: truncateChars(input.small_model, 500),
    small_output_at_decision: truncateChars(input.small_output, MAX_SMALL_OUTPUT_CHARS),
    tool_rounds_before_decision: input.tool_rounds_before_decision,
    max_tool_rounds: input.max_tool_rounds,
    tool_results_before_decision: input.tool_results.slice(0, MAX_TOOL_RESULTS).map((tool) => ({
      name: truncateChars(tool.name, 200),
      ok: tool.result_ok,
      result: truncateChars(tool.result, MAX_TOOL_RESULT_CHARS),
    })),
    recorded_supervisor_action: input.stage === "take_over" ? "interrupt" : "nudge",
    recorded_supervisor_reason: truncateChars(input.reason, MAX_REASON_CHARS),
    supervisor_reason_source: truncateChars(input.reason_source, 200),
  };
}

export function tiebreakerAssessment(
  recordedAction: "nudge" | "interrupt",
  recommendedAction: TiebreakerAction,
): TiebreakerAssessment {
  if (recommendedAction === "unclear") return "unclear";
  return recordedAction === recommendedAction ? "agree" : "disagree";
}

export function parseTiebreakerDecision(raw: string): ParsedDecision {
  const trimmed = raw.trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end < start) {
      throw new Error("GLM response did not contain a JSON object");
    }
    value = JSON.parse(trimmed.slice(start, end + 1));
  }
  const parsed = z.object({
    recommended_action: z.enum(["continue", "nudge", "interrupt", "stop", "unclear"]),
    confidence: z.coerce.number(),
    reason: z.string().trim().min(1),
    supervisor_reason_quality: z.enum([
      "grounded", "partly_grounded", "unsupported", "missing", "unclear",
    ]),
  }).parse(value);
  return {
    ...parsed,
    confidence: Math.max(0, Math.min(1, parsed.confidence)),
    reason: truncateChars(parsed.reason, 400),
  };
}

function analysisRoot(explicit?: string): string {
  return resolve(
    explicit ?? process.env.UNDERSTUDY_TIEBREAKER_ROOT
      ?? join(homedir(), ".understudy", "supervision-tiebreaker"),
  );
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function writePrivateImmutable(path: string, content: string): void {
  ensurePrivateDirectory(dirname(path));
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== content) {
      throw new Error(`refusing to replace immutable tiebreaker evidence: ${path}`);
    }
    return;
  }
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temporary, 0o600);
  try {
    linkSync(temporary, path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" || readFileSync(path, "utf8") !== content) throw cause;
  } finally {
    unlinkSync(temporary);
  }
}

function lockOwnerAlive(path: string): boolean | null {
  const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM" ? true : false;
  }
}

function acquireEvidenceLock(path: string): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      if (process.platform !== "win32") chmodSync(path, 0o600);
      return;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      let staleByAge: boolean;
      let ownerAlive: boolean | null;
      try {
        staleByAge = Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS;
        ownerAlive = lockOwnerAlive(path);
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw inspectionError;
      }
      if (attempt === 0 && (staleByAge || ownerAlive === false)) {
        try { unlinkSync(path); } catch { /* another process may have reclaimed it */ }
        continue;
      }
      throw new Error("this evidence is already being reviewed; try again shortly");
    }
  }
  throw new Error("could not acquire the remote review lock");
}

function latestAnalysis(root: string, evidenceSha256: string): TiebreakerAnalysis | null {
  if (!HEX_SHA256.test(evidenceSha256)) throw new Error("evidence_sha256 is malformed");
  const directory = join(root, "analyses", evidenceSha256);
  if (!existsSync(directory)) return null;
  const rows = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as TiebreakerAnalysis)
    .filter((row) => row.schema_version === TIEBREAKER_SCHEMA && row.evidence_sha256 === evidenceSha256)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  return rows[0] ?? null;
}

function latestFeedback(root: string, evidenceSha256: string): boolean | null {
  const directory = join(root, "feedback", evidenceSha256);
  if (!existsSync(directory)) return null;
  const rows = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as {
      created_at?: string;
      helpful?: boolean;
    })
    .filter((row): row is { created_at: string; helpful: boolean } =>
      typeof row.created_at === "string" && typeof row.helpful === "boolean")
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  return rows[0]?.helpful ?? null;
}

function withLocalState(row: TiebreakerAnalysis, root: string, cacheHit: boolean): TiebreakerAnalysis {
  return {
    ...row,
    cache_hit: cacheHit,
    user_helpful: latestFeedback(root, row.evidence_sha256),
  };
}

function usageCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function callGateway(
  evidence: RemoteReviewEvidence,
  route: TiebreakerRoute,
  fetchImpl: typeof fetch,
  systemPrompt: string,
): Promise<GatewayResult> {
  const auth = resolveAuth(route.orgId);
  const url = `${auth.gatewayUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  assertCustomerScope(url);
  const provider = TIEBREAKER_PROVIDERS[route.provider];
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.token}`,
      "content-type": "application/json",
      accept: "application/json",
      "x-understudy-project": route.project,
      "x-understudy-workload": route.workload,
    },
    body: JSON.stringify({
      model: TIEBREAKER_MODEL,
      stream: false,
      temperature: 0,
      response_format: { type: "json_object" },
      max_tokens: MAX_COMPLETION_TOKENS,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(evidence) },
      ],
      ...provider.requestOverrides,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`gateway returned ${response.status}: ${truncateChars(body, 400)}`);
  }
  const value = JSON.parse(body) as Record<string, unknown>;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const usage = value.usage as Record<string, unknown> | undefined;
  return {
    raw: typeof first?.message?.content === "string" ? first.message.content.trim() : "",
    promptTokens: usageCount(usage?.prompt_tokens ?? usage?.input_tokens),
    completionTokens: usageCount(usage?.completion_tokens ?? usage?.output_tokens),
    servedModel: typeof value.model === "string" ? value.model : null,
    gatewayMode: response.headers.get("x-understudy-mode"),
    gatewayRoute: response.headers.get("x-understudy-route"),
    effectiveModel: response.headers.get("x-understudy-effective-model"),
  };
}

function persistedAnalysis(row: Omit<TiebreakerAnalysis, "analysis_sha256">): TiebreakerAnalysis {
  const analysisSha256 = sha256(JSON.stringify(row));
  return { ...row, analysis_sha256: analysisSha256 };
}

export async function analyzeTiebreaker(
  options: AnalyzeTiebreakerOptions,
): Promise<TiebreakerAnalysis> {
  if (!options.confirmRemote) {
    throw new Error(
      "remote review requires --confirm-remote after disclosing the exact pre-intervention evidence and destination route",
    );
  }
  const route = validateTiebreakerRoute(options.route);
  const input = RemoteReviewInputSchema.parse(options.input);
  const evidence = buildRemoteReviewEvidence(input);
  const provider = TIEBREAKER_PROVIDERS[route.provider];
  const systemPrompt = readFileSync(TIEBREAKER_PROMPT_PATH, "utf8");
  const promptSha256 = sha256(systemPrompt);
  const evidenceSha256 = sha256(JSON.stringify({
    evidence,
    route: {
      provider: route.provider,
      project: route.project,
      workload: route.workload,
      expected_served_model: provider.servedModel,
    },
    prompt_sha256: promptSha256,
  }));
  const root = analysisRoot(options.root);
  if (!options.force) {
    const cached = latestAnalysis(root, evidenceSha256);
    if (cached) return withLocalState(cached, root, true);
  }

  const lockDirectory = join(root, "locks");
  ensurePrivateDirectory(lockDirectory);
  const lockPath = join(lockDirectory, `${evidenceSha256}.lock`);
  try {
    acquireEvidenceLock(lockPath);
  } catch (cause) {
    const cached = latestAnalysis(root, evidenceSha256);
    if (cached) return withLocalState(cached, root, true);
    throw cause;
  }

  try {
    const started = Date.now();
    let result: GatewayResult | null = null;
    let parsed: ParsedDecision | null = null;
    let error: string | null = null;
    try {
      result = await callGateway(evidence, route, options.fetchImpl ?? fetch, systemPrompt);
      if (result.servedModel !== provider.servedModel) {
        throw new Error(
          `served-model mismatch: expected ${provider.servedModel}, got ${result.servedModel ?? "missing"}`,
        );
      }
      if (!result.raw) throw new Error("GLM returned an empty analysis");
      parsed = parseTiebreakerDecision(result.raw);
    } catch (cause) {
      error = safeError(cause);
    }

    const base: Omit<TiebreakerAnalysis, "analysis_sha256"> = {
      schema_version: TIEBREAKER_SCHEMA,
      marker_id: input.marker_id,
      evidence_sha256: evidenceSha256,
      prompt_sha256: promptSha256,
      model: TIEBREAKER_MODEL,
      provider: route.provider,
      expected_served_model: provider.servedModel,
      served_model: result?.servedModel ?? null,
      gateway_mode: result?.gatewayMode ?? null,
      gateway_route: result?.gatewayRoute ?? null,
      effective_model: result?.effectiveModel ?? null,
      route_project: route.project,
      route_workload: route.workload,
      status: parsed ? "ok" : "error",
      recommended_action: parsed?.recommended_action ?? null,
      assessment: parsed
        ? tiebreakerAssessment(evidence.recorded_supervisor_action, parsed.recommended_action)
        : null,
      confidence: parsed?.confidence ?? null,
      reason: parsed?.reason ?? null,
      reason_quality: parsed?.supervisor_reason_quality ?? null,
      error,
      latency_ms: Date.now() - started,
      prompt_tokens: result?.promptTokens ?? null,
      completion_tokens: result?.completionTokens ?? null,
      evidence,
      created_at: new Date().toISOString(),
      cache_hit: false,
      user_helpful: null,
      remote_call_performed: true,
      upload_performed: false,
    };
    const row = persistedAnalysis(base);
    const path = join(root, "analyses", evidenceSha256, `${row.analysis_sha256}.json`);
    writePrivateImmutable(path, `${JSON.stringify(row, null, 2)}\n`);
    return withLocalState(row, root, false);
  } finally {
    try { unlinkSync(lockPath); } catch { /* best effort */ }
  }
}

export function recordTiebreakerFeedback(options: {
  evidenceSha256: string;
  model: string;
  helpful: boolean;
  root?: string;
}): TiebreakerAnalysis {
  if (!HEX_SHA256.test(options.evidenceSha256)) throw new Error("evidence_sha256 is malformed");
  if (options.model !== TIEBREAKER_MODEL) {
    throw new Error(`unsupported tiebreaker model: ${options.model}`);
  }
  const root = analysisRoot(options.root);
  const analysis = latestAnalysis(root, options.evidenceSha256);
  if (!analysis) throw new Error("cannot judge a missing GLM analysis");
  const event = {
    schema_version: TIEBREAKER_FEEDBACK_SCHEMA,
    marker_id: analysis.marker_id,
    evidence_sha256: options.evidenceSha256,
    analysis_sha256: analysis.analysis_sha256,
    model: options.model,
    helpful: options.helpful,
    created_at: new Date().toISOString(),
  };
  const content = `${JSON.stringify(event, null, 2)}\n`;
  const eventSha256 = sha256(content);
  writePrivateImmutable(
    join(root, "feedback", options.evidenceSha256, `${event.created_at.replaceAll(":", "-")}-${eventSha256}.json`),
    content,
  );
  return withLocalState(analysis, root, true);
}
