import { input } from "@inquirer/prompts";
import { Command } from "commander";
import kleur from "kleur";
import { z } from "zod";

import { writeProjectConfig } from "../config/index.js";
import { readCredentials, writeCredentials } from "../config/credentials.js";
import {
  globalCredentialsPath,
  PROJECT_CONFIG_DIR,
} from "../config/paths.js";
import { DEFAULT_GATEWAY_URL } from "../config/defaults.js";
import { isJsonMode, runAction } from "../internal/output.js";
import {
  telemetryEnabled,
  trackLoginCompleted,
  trackLoginFailed,
  trackLoginStarted,
} from "../internal/telemetry.js";

interface LoginOpts {
  email?: string;
  apiKey?: string;
  org?: string;
  project?: string;
  gatewayUrl?: string;
  signupIntentId?: string;
}

const AuthMdMetadataSchema = z.object({
  agent_auth: z.object({
    register_uri: z.string().url(),
    claim_uri: z.string().url().optional(),
  }),
});

const AgentRegisterResponseSchema = z.object({
  registration_id: z.string(),
  claim_token: z.string(),
  claim_url: z.string().optional(),
  post_claim_scopes: z.array(z.string()).optional(),
});

const AgentClaimResponseSchema = z.object({
  credential_type: z.literal("api_key"),
  credential: z.string().startsWith("sk_"),
  scopes: z.array(z.string()).optional(),
  org_id: z.string().optional(),
  organization_id: z.string().optional(),
  api_key_id: z.string().optional(),
  user_id: z.string().optional(),
  email: z.string().email().optional(),
  gateway_url: z.string().url().optional(),
  default_project: z
    .object({
      slug: z.string().min(1),
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
});

type AgentClaimResponse = z.infer<typeof AgentClaimResponseSchema>;

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Sign in or register with Understudy.")
    .option("--email <email>", "Use the auth.md email code registration flow.")
    .option(
      "--api-key <key>",
      "Non-interactive escape hatch: save this sk_* directly. Requires --org and --project.",
    )
    .option(
      "--org <id>",
      "Non-interactive escape hatch: org id for --api-key.",
    )
    .option(
      "--project <slug>",
      "Non-interactive escape hatch: default project slug for --api-key.",
    )
    .option(
      "--gateway-url <url>",
      `Gateway base URL (default: ${DEFAULT_GATEWAY_URL}).`,
    )
    .option(
      "--signup-intent-id <id>",
      "Optional browser/dashboard signup intent id for attribution.",
    )
    .action(async function (this: Command, opts: LoginOpts) {
      await runAction(this, () => runLogin(opts, isJsonMode(this)));
    });
}

async function runLogin(opts: LoginOpts, json: boolean): Promise<void> {
  const gatewayUrl =
    opts.gatewayUrl ?? process.env.UNDERSTUDY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL;

  if (opts.email) {
    const signupIntentId = opts.signupIntentId ?? signupIntentFromEnv();
    await trackLoginStarted({ mode: "auth.md", gatewayUrl, signupIntentId });
    try {
      const result = await runAuthMdLogin(
        opts.email,
        gatewayUrl,
        json,
        signupIntentId,
      );
      saveApiKeyResult(result, gatewayUrl, signupIntentId);
      emitApiKeySuccess(result, json, "auth.md");
      await trackLoginCompleted({
        apiKey: result.credential,
        gatewayUrl,
        mode: "auth.md",
        orgId: result.org_id ?? result.organization_id ?? null,
        userId: result.user_id ?? null,
        signupIntentId: opts.signupIntentId ?? signupIntentFromEnv() ?? null,
      });
    } catch (err) {
      await trackLoginFailed({
        mode: "auth.md",
        gatewayUrl,
        signupIntentId,
        errorKind: loginErrorKind(err),
      });
      throw err;
    }
    return;
  }

  if (opts.apiKey || opts.org || opts.project) {
    const signupIntentId = opts.signupIntentId ?? signupIntentFromEnv();
    await trackLoginStarted({ mode: "manual", gatewayUrl, signupIntentId });
    try {
      const result = runManualLogin(opts, gatewayUrl);
      saveApiKeyResult(result, gatewayUrl, opts.signupIntentId);
      emitApiKeySuccess(result, json, "manual");
      await trackLoginCompleted({
        apiKey: result.credential,
        gatewayUrl,
        mode: "manual",
        orgId: result.org_id ?? result.organization_id ?? null,
        signupIntentId: opts.signupIntentId ?? signupIntentFromEnv() ?? null,
      });
    } catch (err) {
      await trackLoginFailed({
        mode: "manual",
        gatewayUrl,
        signupIntentId,
        errorKind: loginErrorKind(err),
      });
      throw err;
    }
    return;
  }

  throw new Error(
    "Run `understudy login --email <email>` to sign in with an email code.",
  );
}

function runManualLogin(
  opts: LoginOpts,
  gatewayUrl: string,
): AgentClaimResponse {
  if (!opts.apiKey || !opts.org || !opts.project) {
    throw new Error(
      "Manual login requires --api-key, --org, and --project. For normal sign-in, run `understudy login` with no flags.",
    );
  }
  if (!opts.apiKey.startsWith("sk_")) {
    throw new Error("Expected a key starting with sk_.");
  }
  if (!opts.org.startsWith("org_")) {
    throw new Error("Expected an org id starting with org_.");
  }
  return {
    credential_type: "api_key",
    credential: opts.apiKey,
    org_id: opts.org,
    default_project: { slug: opts.project },
    gateway_url: gatewayUrl,
  };
}

async function runAuthMdLogin(
  email: string,
  gatewayUrl: string,
  json: boolean,
  signupIntentId?: string,
): Promise<AgentClaimResponse> {
  const metadata = await fetchAuthMdMetadata(gatewayUrl);
  const register = await postJson(metadata.agent_auth.register_uri, {
    type: "identity_assertion",
    assertion_type: "verified_email",
    assertion: email,
    requested_credential_type: "api_key",
    ...(signupIntentId ? { signup_intent_id: signupIntentId } : {}),
  });
  const reg = AgentRegisterResponseSchema.parse(register);

  if (!json) {
    process.stdout.write(
      `${kleur.gray(`Sent a one-time code to ${email}.`)}\n`,
    );
  }
  const code = await input({ message: "One-time code:" });

  const completeUrl = resolveClaimCompleteUrl(
    reg.claim_url,
    metadata.agent_auth.claim_uri,
    metadata.agent_auth.register_uri,
  );
  const claim = await postJson(completeUrl, {
    claim_token: reg.claim_token,
    code,
  });
  return AgentClaimResponseSchema.parse(claim);
}

async function fetchAuthMdMetadata(gatewayUrl: string) {
  const url = `${gatewayUrl.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Could not read auth.md metadata (${res.status}).`);
  }
  return AuthMdMetadataSchema.parse(await res.json());
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text.length === 0 ? null : JSON.parse(text);
  if (!res.ok) {
    const message =
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
        ? parsed.message
        : `Request to ${url} failed with status ${res.status}.`;
    throw new Error(message);
  }
  return parsed;
}

function resolveClaimCompleteUrl(
  claimUrl: string | undefined,
  claimUri: string | undefined,
  registerUri: string,
): string {
  if (claimUrl?.startsWith("http://") || claimUrl?.startsWith("https://")) {
    return claimUrl;
  }
  const base = new URL(claimUri ?? registerUri);
  if (claimUrl) {
    return new URL(claimUrl, `${base.origin}/`).toString();
  }
  return new URL("/agent/auth/claim/complete", base.origin).toString();
}

function saveApiKeyResult(
  result: AgentClaimResponse,
  fallbackGatewayUrl: string,
  signupIntentId?: string,
): void {
  const gatewayUrl = result.gateway_url ?? fallbackGatewayUrl;
  const orgId = result.org_id ?? result.organization_id;
  const existing = readCredentials();
  const next = {
    ...(existing ?? { orgs: {} }),
    api_key: result.credential,
    gateway_url: gatewayUrl,
    user_id: result.user_id ?? existing?.user_id,
    email: result.email ?? existing?.email,
    signup_intent_id: signupIntentId ?? signupIntentFromEnv() ?? existing?.signup_intent_id,
    orgs: { ...(existing?.orgs ?? {}) },
  };
  if (orgId) {
    next.orgs[orgId] = { api_key: result.credential, gateway_url: gatewayUrl };
  }
  writeCredentials(next);

  if (orgId && result.default_project) {
    writeProjectConfig(`${PROJECT_CONFIG_DIR}/config.json`, {
      org_id: orgId,
      project_slug: result.default_project.slug,
    });
  }
}

function signupIntentFromEnv(): string | undefined {
  const value = process.env.UNDERSTUDY_SIGNUP_INTENT_ID?.trim();
  return value && value.length > 0 ? value : undefined;
}

function loginErrorKind(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  if (err.name === "AbortError") return "network_timeout";
  if (/metadata|fetch|request|status/i.test(err.message)) return "network";
  if (/code|claim|credential|parse|invalid/i.test(err.message)) return "auth";
  return "other";
}

function emitApiKeySuccess(
  result: AgentClaimResponse,
  json: boolean,
  mode: "auth.md" | "manual",
): void {
  const orgId = result.org_id ?? result.organization_id ?? null;
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mode,
        org_id: orgId,
        project_slug: result.default_project?.slug ?? null,
        api_key_suffix: result.credential.slice(-4),
        gateway_url: result.gateway_url ?? DEFAULT_GATEWAY_URL,
        credentials_path: globalCredentialsPath(),
        telemetry_enabled: telemetryEnabled(),
      })}\n`,
    );
    return;
  }

  process.stdout.write(
    `${kleur.green("✓")} Signed in\n` +
      `${kleur.gray("mode")}     ${mode}\n` +
      `${kleur.gray("org")}      ${orgId ?? "(credential only)"}\n` +
      `${kleur.gray("project")}  ${result.default_project?.slug ?? "(none)"}\n` +
      `${kleur.gray("key")}      sk_••••${result.credential.slice(-4)}\n` +
      `${kleur.gray("saved")}    ${globalCredentialsPath()}\n`,
  );
  if (telemetryEnabled()) {
    process.stdout.write(
      `${kleur.dim("Signed-in sessions send bounded usage telemetry (docs/telemetry.md); disable with UNDERSTUDY_TELEMETRY=0.")}\n`,
    );
  }
}
