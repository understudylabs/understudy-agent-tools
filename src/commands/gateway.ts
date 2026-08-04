import { Command } from "commander";
import { createHash } from "node:crypto";
import kleur from "kleur";

import { DEFAULT_GATEWAY_URL } from "../config/defaults.js";
import { readCredentials } from "../config/credentials.js";
import { resolveAuth } from "../internal/http.js";
import { isJsonMode, runAction } from "../internal/output.js";

interface HealthOpts {
  gatewayUrl?: string;
}

interface ProbeOpts {
  provider: "anthropic" | "openai";
  model?: string;
  project?: string;
  workload?: string;
  byokEnv?: string;
  stream?: boolean;
  maxTokens?: string;
  tag?: string[];
  org?: string;
}

export function registerGatewayCommand(program: Command): void {
  const gateway = program
    .command("gateway")
    .description("Run narrow Understudy gateway health and probe checks.");

  gateway
    .command("health")
    .description("Check gateway health without provider calls.")
    .option("--gateway-url <url>", "Gateway URL override.")
    .action(async function (this: Command, opts: HealthOpts) {
      await runAction(this, () => runHealth(this, opts));
    });

  gateway
    .command("probe")
    .description("Run one explicit tiny gateway completion probe.")
    .requiredOption("--provider <anthropic|openai>", "Provider-compatible API shape to probe.")
    .option("--model <id>", "Requested model id.")
    .option("--project <slug>", "Project slug header.")
    .option("--workload <name>", "Workload name header.")
    .option("--byok-env <ENV_NAME>", "Read upstream provider key from this environment variable.")
    .option(
      "--no-stream",
      "Request a buffered (non-streaming) response. Streaming is the default: the edge cuts responses with no first byte within ~125s, so non-streaming probes can 524 on slow upstreams.",
    )
    .option("--max-tokens <n>", "Maximum output tokens.", "8")
    .option("--tag <key=value>", "Flat string tag; may be repeated.", collectTag, [])
    .option("--org <id>", "Org id to use (default: local config or only org in credentials).")
    .action(async function (this: Command, opts: ProbeOpts) {
      await runAction(this, () => runProbe(this, opts));
    });
}

async function runHealth(cmd: Command, opts: HealthOpts): Promise<void> {
  const gatewayUrl = resolveGatewayUrl(opts.gatewayUrl);
  const url = `${gatewayUrl.replace(/\/+$/, "")}/healthz`;
  const started = Date.now();
  let status = 0;
  let ok = false;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    status = res.status;
    ok = res.ok;
  } catch {
    ok = false;
  }
  const payload = { ok, gateway_url: gatewayUrl, status, latency_ms: Date.now() - started };
  if (!ok) process.exitCode = 1;
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`ok ${ok ? "yes" : "no"}\n`);
  process.stdout.write(`gateway_url ${gatewayUrl}\n`);
  process.stdout.write(`status ${status || "unreachable"}\n`);
}

async function runProbe(cmd: Command, opts: ProbeOpts): Promise<void> {
  if (opts.provider !== "anthropic" && opts.provider !== "openai") {
    throw new Error("Expected --provider anthropic|openai.");
  }
  const auth = resolveAuth(opts.org);
  const endpoint = opts.provider === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const url = `${auth.gatewayUrl.replace(/\/+$/, "")}${endpoint}`;
  const maxTokens = parseMaxTokens(opts.maxTokens);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (opts.provider === "anthropic") {
    headers["x-api-key"] = auth.token;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${auth.token}`;
  }
  if (opts.project) headers["x-understudy-project"] = opts.project;
  if (opts.workload) headers["x-understudy-workload"] = opts.workload;
  const tags = parseTags(opts.tag ?? []);
  if (Object.keys(tags).length > 0) {
    headers["x-understudy-tags"] = JSON.stringify(tags);
  }
  if (opts.byokEnv) {
    const upstreamKey = process.env[opts.byokEnv];
    if (!upstreamKey) {
      throw new Error(`Environment variable ${opts.byokEnv} is not set.`);
    }
    headers["x-understudy-upstream-key"] = upstreamKey;
  }

  const body = opts.provider === "anthropic"
    ? {
        model: opts.model ?? "claude-3-5-haiku-latest",
        max_tokens: maxTokens,
        stream: Boolean(opts.stream),
        messages: [{ role: "user", content: "Reply with the single word ok." }],
      }
    : openAIProbeBody(opts.model ?? "gpt-4o-mini", maxTokens, Boolean(opts.stream));

  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - started;
  const text = await res.text();
  const requestId = res.headers.get("x-understudy-request-id");
  const diagnostics = responseDiagnostics(res, text);
  const payload = {
    ok: res.ok,
    status: res.status,
    provider: opts.provider,
    endpoint,
    requested_model: opts.model ?? body.model,
    request_id: requestId,
    latency_ms: latencyMs,
    project: opts.project ?? null,
    workload: opts.workload ?? null,
    byok: Boolean(opts.byokEnv),
    response_kind: opts.stream ? "stream" : responseKind(text),
    ...diagnostics,
  };
  if (!res.ok) process.exitCode = 1;
  if (isJsonMode(cmd)) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`status ${res.status}\n`);
  process.stdout.write(`provider ${opts.provider}\n`);
  process.stdout.write(`endpoint ${endpoint}\n`);
  process.stdout.write(`requested_model ${payload.requested_model}\n`);
  process.stdout.write(`project ${payload.project ?? "(none)"}\n`);
  process.stdout.write(`workload ${payload.workload ?? "(none)"}\n`);
  process.stdout.write(`request_id ${requestId ?? "(none)"}\n`);
  process.stdout.write(`latency_ms ${latencyMs}\n`);
  process.stdout.write(`${res.ok ? kleur.green("response received") : kleur.red("response failed")}\n`);
}

function responseDiagnostics(res: Response, text: string): Record<string, string | null> {
  let errorType: string | null = null;
  let errorCode: string | null = null;
  if (!res.ok) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const error = parsed.error && typeof parsed.error === "object"
        ? parsed.error as Record<string, unknown>
        : parsed;
      errorType = safeScalar(error.type);
      errorCode = safeScalar(error.code);
    } catch {
      // The response hash still distinguishes non-JSON upstream failures.
    }
  }
  return {
    response_sha256: createHash("sha256").update(text).digest("hex"),
    error_type: errorType,
    error_code: errorCode,
    retry_after: headerFirst(res.headers, ["retry-after"]),
    rate_limit_limit: headerFirst(res.headers, ["x-ratelimit-limit-requests", "x-ratelimit-limit"]),
    rate_limit_remaining: headerFirst(res.headers, ["x-ratelimit-remaining-requests", "x-ratelimit-remaining"]),
    rate_limit_reset: headerFirst(res.headers, ["x-ratelimit-reset-requests", "x-ratelimit-reset"]),
    upstream_request_id: headerFirst(res.headers, ["x-fireworks-request-id", "x-request-id"]),
    deployment_id: headerFirst(res.headers, ["x-understudy-deployment-id", "x-fireworks-deployment-id"]),
    deployment_state: headerFirst(res.headers, ["x-understudy-deployment-state", "x-fireworks-deployment-state"]),
    cold_start: headerFirst(res.headers, ["x-understudy-cold-start", "x-fireworks-cold-start"]),
  };
}

function safeScalar(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value).slice(0, 128) : null;
}

function headerFirst(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value.slice(0, 256);
  }
  return null;
}

function openAIProbeBody(model: string, maxTokens: number, stream: boolean): Record<string, unknown> {
  const tokenLimit = model.startsWith("gpt-5")
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
  return {
    model,
    ...tokenLimit,
    stream,
    messages: [{ role: "user", content: "Reply with the single word ok." }],
  };
}

function resolveGatewayUrl(override?: string): string {
  if (override) return override;
  const credentials = readCredentials();
  return credentials?.gateway_url ?? process.env.UNDERSTUDY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
}

function parseMaxTokens(value: string | undefined): number {
  const parsed = Number(value ?? "8");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 64) {
    throw new Error(`Expected --max-tokens between 1 and 64, got: ${value}`);
  }
  return parsed;
}

function collectTag(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseTags(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of values) {
    const index = entry.indexOf("=");
    if (index <= 0) {
      throw new Error(`Expected --tag key=value, got: ${entry}`);
    }
    const key = entry.slice(0, index);
    const value = entry.slice(index + 1);
    if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(key)) {
      throw new Error(`Invalid tag key: ${key}`);
    }
    out[key] = value;
  }
  return out;
}

function responseKind(text: string): "json" | "stream" {
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return "stream";
  }
}
