#!/usr/bin/env node
import { createServer } from "node:http";

const DEFAULT_PORT = 17890;
const DEFAULT_MAIN_BASE_URL = "http://127.0.0.1:8091/v1";
const DEFAULT_FAST_BASE_URL = "http://127.0.0.1:8092/v1";
const DEFAULT_MAIN_MODEL = "gemma-4-26b-a4b-it-qat-mlx-vlm-understudy";
const DEFAULT_FAST_MODEL = "gemma-4-e2b-it-qat-mlx-vlm-understudy";

function usage() {
  return `Usage:
  node scripts/automationbench-fusion-proxy.mjs [--port 17890]

Environment:
  FUSION_MAIN_BASE_URL      default ${DEFAULT_MAIN_BASE_URL}
  FUSION_FAST_BASE_URL      default ${DEFAULT_FAST_BASE_URL}
  FUSION_GATEWAY_BASE_URL   optional OpenAI-compatible gateway /v1
  FUSION_GATEWAY_API_KEY    optional gateway key
  FUSION_MAIN_MODEL         default ${DEFAULT_MAIN_MODEL}
  FUSION_FAST_MODEL         default ${DEFAULT_FAST_MODEL}
  FUSION_SIDECAR_WAIT_MS    default 2500

Models exposed:
  understudy-fusion-main
  understudy-fusion-fast
  understudy-fusion-sidekick-main
  understudy-fusion-sidekick-gateway
  understudy-fusion-sidekick-advisory-main
  understudy-fusion-sidekick-advisory-gateway
`;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function config() {
  const gatewayBase = process.env.FUSION_GATEWAY_BASE_URL?.replace(/\/$/, "");
  return {
    mainBaseUrl: (process.env.FUSION_MAIN_BASE_URL ?? DEFAULT_MAIN_BASE_URL).replace(/\/$/, ""),
    fastBaseUrl: (process.env.FUSION_FAST_BASE_URL ?? DEFAULT_FAST_BASE_URL).replace(/\/$/, ""),
    gatewayBaseUrl: gatewayBase,
    gatewayApiKey: process.env.FUSION_GATEWAY_API_KEY,
    mainModel: process.env.FUSION_MAIN_MODEL ?? DEFAULT_MAIN_MODEL,
    fastModel: process.env.FUSION_FAST_MODEL ?? DEFAULT_FAST_MODEL,
    sidecarWaitMs: Number(process.env.FUSION_SIDECAR_WAIT_MS ?? 2500),
  };
}

function modelSpec(requestedModel, cfg) {
  switch (requestedModel) {
    case "understudy-fusion-fast":
      return {
        baseUrl: cfg.fastBaseUrl,
        model: cfg.fastModel,
        apiKey: null,
        sidekick: false,
        route: "fast",
      };
    case "understudy-fusion-sidekick-main":
      return {
        baseUrl: cfg.mainBaseUrl,
        model: cfg.mainModel,
        apiKey: null,
        sidekickMode: "background",
        route: "main",
      };
    case "understudy-fusion-sidekick-gateway":
      if (!cfg.gatewayBaseUrl || !cfg.gatewayApiKey) {
        throw new Error("FUSION_GATEWAY_BASE_URL and FUSION_GATEWAY_API_KEY are required for gateway Fusion");
      }
      return {
        baseUrl: cfg.gatewayBaseUrl,
        model: "glm-5.2",
        apiKey: cfg.gatewayApiKey,
        sidekickMode: "background",
        route: "gateway",
      };
    case "understudy-fusion-sidekick-advisory-main":
      return {
        baseUrl: cfg.mainBaseUrl,
        model: cfg.mainModel,
        apiKey: null,
        sidekickMode: "advisory",
        route: "main",
      };
    case "understudy-fusion-sidekick-advisory-gateway":
      if (!cfg.gatewayBaseUrl || !cfg.gatewayApiKey) {
        throw new Error("FUSION_GATEWAY_BASE_URL and FUSION_GATEWAY_API_KEY are required for gateway Fusion");
      }
      return {
        baseUrl: cfg.gatewayBaseUrl,
        model: "glm-5.2",
        apiKey: cfg.gatewayApiKey,
        sidekickMode: "advisory",
        route: "gateway",
      };
    case "understudy-fusion-main":
    default:
      return {
        baseUrl: cfg.mainBaseUrl,
        model: cfg.mainModel,
        apiKey: null,
        sidekickMode: "off",
        route: "main",
      };
  }
}

function compactText(value, max = 6000) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

function sidekickPrompt(messages) {
  const recent = messages
    .slice(-8)
    .map((message) => {
      const role = message.role ?? "unknown";
      const toolName = message.name ? ` ${message.name}` : "";
      return `${role}${toolName}: ${compactText(message.content, 1200)}`;
    })
    .join("\n\n");
  return `You are the Understudy sidekick for an AutomationBench business workflow.
Review the recent conversation and return concise advisory context for the main model.
Focus on mechanical/search/verification help: what data was found, what tool family likely matters, and what final-state assertion must be satisfied.
Do not make final decisions. Do not invent tool outputs. If uncertain, say ESCALATE_TO_MAIN with one short reason.

Recent conversation:
${recent}`;
}

async function callChat({ baseUrl, apiKey, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`${response.status}: ${text}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function sidekickAdvice(cfg, messages) {
  const body = {
    model: cfg.fastModel,
    messages: [
      { role: "system", content: "Return only compact advisory notes for a main agent." },
      { role: "user", content: sidekickPrompt(messages) },
    ],
    max_tokens: 256,
    temperature: 0,
  };
  const response = await callChat({
    baseUrl: cfg.fastBaseUrl,
    apiKey: null,
    body,
    timeoutMs: cfg.sidecarWaitMs,
  });
  return response.choices?.[0]?.message?.content?.trim() ?? "";
}

function injectAdvice(messages, advice) {
  if (!advice) return messages;
  const advisory = {
    role: "system",
    content: `Background sidekick advisory context. Treat this as non-authoritative; the main model owns final actions and judgment.\n${advice}`,
  };
  const firstNonSystem = messages.findIndex((message) => message.role !== "system");
  if (firstNonSystem <= 0) return [advisory, ...messages];
  return [...messages.slice(0, firstNonSystem), advisory, ...messages.slice(firstNonSystem)];
}

async function chatCompletions(reqBody) {
  const cfg = config();
  const requestedModel = reqBody.model ?? "understudy-fusion-main";
  const spec = modelSpec(requestedModel, cfg);
  let messages = Array.isArray(reqBody.messages) ? reqBody.messages : [];
  let sidekick = { used: false, mode: spec.sidekickMode, pending: false, error: null, advice_chars: 0 };
  let backgroundSidekick = null;
  if (spec.sidekickMode === "advisory") {
    try {
      const advice = await sidekickAdvice(cfg, messages);
      sidekick = { used: Boolean(advice), mode: spec.sidekickMode, pending: false, error: null, advice_chars: advice.length };
      messages = injectAdvice(messages, advice);
    } catch (error) {
      sidekick = { used: false, mode: spec.sidekickMode, pending: false, error: error.message, advice_chars: 0 };
    }
  } else if (spec.sidekickMode === "background") {
    let settled = false;
    let result = sidekick;
    backgroundSidekick = sidekickAdvice(cfg, messages)
      .then((advice) => {
        result = { used: Boolean(advice), mode: spec.sidekickMode, pending: false, error: null, advice_chars: advice.length };
        settled = true;
        return result;
      })
      .catch((error) => {
        result = { used: false, mode: spec.sidekickMode, pending: false, error: error.message, advice_chars: 0 };
        settled = true;
        return result;
      });
    backgroundSidekick.snapshot = () =>
      settled ? result : { used: false, mode: spec.sidekickMode, pending: true, error: null, advice_chars: 0 };
  }
  const upstreamBody = {
    ...reqBody,
    model: spec.model,
    messages,
    stream: false,
  };
  const response = await callChat({
    baseUrl: spec.baseUrl,
    apiKey: spec.apiKey,
    body: upstreamBody,
    timeoutMs: 180000,
  });
  if (backgroundSidekick) {
    sidekick = backgroundSidekick.snapshot();
  }
  response.model = requestedModel;
  response.understudy_fusion = {
    route: spec.route,
    upstream_model: spec.model,
    sidekick_mode: spec.sidekickMode,
    sidekick,
  };
  return response;
}

async function handler(req, res) {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return jsonResponse(res, 200, { ok: true });
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      return jsonResponse(res, 200, {
        object: "list",
        data: [
          { id: "understudy-fusion-main", object: "model" },
          { id: "understudy-fusion-fast", object: "model" },
          { id: "understudy-fusion-sidekick-main", object: "model" },
          { id: "understudy-fusion-sidekick-gateway", object: "model" },
          { id: "understudy-fusion-sidekick-advisory-main", object: "model" },
          { id: "understudy-fusion-sidekick-advisory-gateway", object: "model" },
        ],
      });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      return jsonResponse(res, 200, await chatCompletions(await readJsonBody(req)));
    }
    return jsonResponse(res, 404, { error: { message: "not found" } });
  } catch (error) {
    return jsonResponse(res, 500, { error: { message: error.message } });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(usage());
    return;
  }
  const port = Number(argValue(args, "--port") ?? process.env.FUSION_PROXY_PORT ?? DEFAULT_PORT);
  createServer((req, res) => {
    handler(req, res);
  }).listen(port, "127.0.0.1", () => {
    console.error(`understudy AutomationBench Fusion proxy listening on http://127.0.0.1:${port}/v1`);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
