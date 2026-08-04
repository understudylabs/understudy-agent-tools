import { createHash } from "node:crypto";

export const FIREWORKS_CANARY_SCHEMA = "understudy.fireworks_canary_receipt.v1" as const;

export type FireworksCanaryReceipt = {
  schema_version: typeof FIREWORKS_CANARY_SCHEMA;
  provider: "fireworks";
  model_id: string;
  deployment_id: string;
  request_id: string | null;
  status: number | null;
  ok: boolean;
  latency_ms: number;
  error_class: string | null;
  error_code: string | null;
  error_hash: string | null;
  retry_after: string | null;
  rate_limit_headers: Record<string, string>;
  deployment_state: string | null;
  cold_start: boolean | null;
};

export type CanaryFetch = (input: string, init?: RequestInit) => Promise<Response>;

const ERROR_HEADERS = ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];
const STATE_HEADERS = ["x-fireworks-deployment-state", "x-deployment-state", "x-cold-start"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function header(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value.slice(0, 256);
  }
  return null;
}

function errorClass(status: number | null): string | null {
  if (status === null) return "transport_error";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_5xx";
  if (status >= 400) return "http_4xx";
  return null;
}

/** Execute one explicitly approved canary. The request body is never retained or logged. */
export async function runFireworksCanary(input: {
  url: string;
  modelId: string;
  deploymentId: string;
  body: unknown;
  requestHeaders?: Record<string, string>;
  approved: boolean;
  fetchImpl?: CanaryFetch;
  now?: () => number;
}): Promise<FireworksCanaryReceipt> {
  if (!input.approved) throw new Error("fireworks canary refused: explicit approval is required");
  if (!input.modelId.trim() || !input.deploymentId.trim()) throw new Error("fireworks canary refused: model and deployment identity are required");
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const started = now();
  let response: Response | null = null;
  let transportError: unknown = null;
  try {
    response = await fetchImpl(input.url, {
      method: "POST",
      headers: { ...input.requestHeaders, "content-type": "application/json" },
      body: JSON.stringify(input.body),
    });
  } catch (error) {
    transportError = error;
  }
  const latencyMs = Math.max(0, now() - started);
  const status = response?.status ?? null;
  let errorCode: string | null = null;
  let errorFingerprint = transportError instanceof Error ? transportError.name : status === null ? "transport_failure" : `HTTP ${status}`;
  if (response && !response.ok) {
    try {
      const errorBody = await response.clone().json() as Record<string, unknown>;
      const nested = typeof errorBody.error === "object" && errorBody.error !== null
        ? errorBody.error as Record<string, unknown> : errorBody;
      const candidate = nested.code ?? nested.type ?? errorBody.code ?? errorBody.type;
      if (typeof candidate === "string" && candidate.length > 0) errorCode = candidate.slice(0, 128);
      errorFingerprint = JSON.stringify({ status, code: errorCode, body: errorBody });
    } catch {
      try { errorFingerprint = `${status}:${await response.clone().text()}`; } catch { /* status-only fallback */ }
    }
  }
  const state = response ? header(response.headers, STATE_HEADERS) : null;
  const coldHeader = response ? header(response.headers, ["x-cold-start"]) : null;
  return {
    schema_version: FIREWORKS_CANARY_SCHEMA, provider: "fireworks", model_id: input.modelId,
    deployment_id: input.deploymentId, request_id: response ? header(response.headers, ["x-request-id", "request-id", "x-fireworks-request-id"]) : null,
    status, ok: Boolean(response?.ok), latency_ms: latencyMs, error_class: response?.ok ? null : errorClass(status),
    error_code: response?.ok ? null : errorCode, error_hash: response?.ok ? null : hash(errorFingerprint), retry_after: response ? header(response.headers, ["retry-after"]) : null,
    rate_limit_headers: response ? Object.fromEntries(ERROR_HEADERS.map((name) => [name, response!.headers.get(name)]).filter(([, value]) => value !== null)) as Record<string, string> : {},
    deployment_state: state, cold_start: coldHeader === null ? null : /^(1|true|yes)$/i.test(coldHeader),
  };
}
