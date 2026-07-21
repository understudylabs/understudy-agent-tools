/**
 * Snippet builders for the Setup pane — a faithful port of the web control
 * plane's `apps/web/app/setup/byok/byok-snippets.ts` (understudy-platform
 * origin/main), with the gateway base URL parameterized so a non-default
 * `gateway_url` in credentials.json produces runnable snippets.
 *
 * Pure module (no React, no Tauri) so `node --test` can cover it.
 */

export const UNDERSTUDY_API_KEY_ENV = "UNDERSTUDY_API_KEY";

/** Must match `DEFAULT_WORKLOAD_NAME` / `DEFAULT_GATEWAY_URL` upstream. */
export const DEFAULT_WORKLOAD_NAME = "main";
export const DEFAULT_PROJECT_SLUG = "rehearsal";
export const DEFAULT_GATEWAY_URL = "https://api.understudylabs.com";

export const BYOK_PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    providerEnvName: "ANTHROPIC_API_KEY",
    endpoint: "/v1/messages",
    authHeader: `x-api-key: $${UNDERSTUDY_API_KEY_ENV}`,
    body: `{"model":"claude-haiku-4-5","max_tokens":32,"messages":[{"role":"user","content":"Say ok."}]}`,
    sdkSnippet: (projectSlug, workloadName, baseUrl) => {
      const projectHeader = projectSlug
        ? `    "x-understudy-project": "${projectSlug}",\n`
        : "";

      return `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.${UNDERSTUDY_API_KEY_ENV} ?? "",
  baseURL: "${baseUrl}",
  defaultHeaders: {
    "x-understudy-upstream-key": process.env.ANTHROPIC_API_KEY ?? "",
${projectHeader}    "x-understudy-workload": "${workloadName}",
  },
});

await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 32,
  messages: [{ role: "user", content: "Say ok." }],
});`;
    },
  },
  openai: {
    label: "OpenAI",
    providerEnvName: "OPENAI_API_KEY",
    endpoint: "/v1/chat/completions",
    authHeader: `Authorization: Bearer $${UNDERSTUDY_API_KEY_ENV}`,
    body: `{"model":"gpt-4o-mini","max_tokens":32,"messages":[{"role":"user","content":"Say ok."}]}`,
    sdkSnippet: (projectSlug, workloadName, baseUrl) => {
      const projectHeader = projectSlug
        ? `    "x-understudy-project": "${projectSlug}",\n`
        : "";

      return `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.${UNDERSTUDY_API_KEY_ENV} ?? "",
  baseURL: "${baseUrl}/v1",
  defaultHeaders: {
    "x-understudy-upstream-key": process.env.OPENAI_API_KEY ?? "",
${projectHeader}    "x-understudy-workload": "${workloadName}",
  },
});

await client.chat.completions.create({
  model: "gpt-4o-mini",
  max_tokens: 32,
  messages: [{ role: "user", content: "Say ok." }],
});`;
    },
  },
};

function normalizeOptional(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeBaseUrl(value) {
  const trimmed = normalizeOptional(value) ?? DEFAULT_GATEWAY_URL;
  return trimmed.replace(/\/+$/, "");
}

/**
 * `understudyKey` is interpolated verbatim when present so the snippet is
 * runnable as pasted; otherwise a placeholder. The key never leaves the
 * machine — these builders run in the webview only.
 */
export function buildByokEnvSnippet(provider, understudyKey) {
  const config = BYOK_PROVIDERS[provider];
  return `export ${UNDERSTUDY_API_KEY_ENV}="${
    normalizeOptional(understudyKey) ?? "sk_live_..."
  }"
export ${config.providerEnvName}="${
    provider === "anthropic" ? "sk-ant-..." : "sk-proj-..."
  }"`;
}

export function buildManagedEnvSnippet(understudyKey) {
  return `export ${UNDERSTUDY_API_KEY_ENV}="${
    normalizeOptional(understudyKey) ?? "sk_live_..."
  }"`;
}

/**
 * Managed-mode smoke test: a catalog model served from Understudy supply
 * needs only the sk_* key — no provider account, no upstream key header.
 */
export function buildManagedCurlSnippet(input) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const projectSlug = normalizeOptional(input.projectSlug);
  const workloadName =
    normalizeOptional(input.workloadName) ?? DEFAULT_WORKLOAD_NAME;
  const lines = [
    `curl ${baseUrl}/v1/chat/completions \\`,
    `  -H "Authorization: Bearer $${UNDERSTUDY_API_KEY_ENV}" \\`,
  ];

  if (projectSlug) {
    lines.push(`  -H "x-understudy-project: ${projectSlug}" \\`);
  }
  lines.push(`  -H "x-understudy-workload: ${workloadName}" \\`);

  lines.push(
    `  -H "content-type: application/json" \\`,
    `  -d '{"model":"${input.modelId}","max_tokens":32,"messages":[{"role":"user","content":"Say ok."}]}'`,
  );

  return lines.join("\n");
}

export function buildManagedSdkSnippet(input) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const projectSlug = normalizeOptional(input.projectSlug);
  const workloadName =
    normalizeOptional(input.workloadName) ?? DEFAULT_WORKLOAD_NAME;
  const scopeHeaders = [
    projectSlug ? `"x-understudy-project": "${projectSlug}"` : null,
    `"x-understudy-workload": "${workloadName}"`,
  ]
    .filter(Boolean)
    .join(", ");

  return `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.${UNDERSTUDY_API_KEY_ENV} ?? "",
  baseURL: "${baseUrl}/v1",
  defaultHeaders: { ${scopeHeaders} },
});

await client.chat.completions.create({
  model: "${input.modelId}",
  max_tokens: 32,
  messages: [{ role: "user", content: "Say ok." }],
});`;
}

export function buildByokCurlSnippet(input) {
  const config = BYOK_PROVIDERS[input.provider];
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const projectSlug = normalizeOptional(input.projectSlug);
  const workloadName =
    normalizeOptional(input.workloadName) ?? DEFAULT_WORKLOAD_NAME;
  const lines = [
    `curl ${baseUrl}${config.endpoint} \\`,
    `  -H "${config.authHeader}" \\`,
    `  -H "x-understudy-upstream-key: $${config.providerEnvName}" \\`,
  ];

  if (projectSlug) {
    lines.push(`  -H "x-understudy-project: ${projectSlug}" \\`);
  }
  lines.push(`  -H "x-understudy-workload: ${workloadName}" \\`);

  if (input.provider === "anthropic") {
    lines.push(`  -H "anthropic-version: 2023-06-01" \\`);
  }

  lines.push(
    `  -H "content-type: application/json" \\`,
    `  -d '${config.body}'`,
  );

  return lines.join("\n");
}

export function buildByokSdkSnippet(input) {
  return BYOK_PROVIDERS[input.provider].sdkSnippet(
    normalizeOptional(input.projectSlug),
    normalizeOptional(input.workloadName) ?? DEFAULT_WORKLOAD_NAME,
    normalizeBaseUrl(input.baseUrl),
  );
}

export function maskSecret(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const tail = trimmed.slice(-4);
  return `•••• ${tail}`;
}

/**
 * The web page prefers the canonical default project, then the legacy
 * `main` slug for orgs created before the `rehearsal` rename, then anything.
 */
export function pickDefaultProjectSlug(projects, preferred) {
  if (preferred && projects.some((project) => project.slug === preferred)) {
    return preferred;
  }
  return (
    projects.find((project) => project.slug === DEFAULT_PROJECT_SLUG)?.slug ??
    projects.find((project) => project.slug === "main")?.slug ??
    projects[0]?.slug ??
    ""
  );
}
