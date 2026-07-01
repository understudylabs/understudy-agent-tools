import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { input } from "@inquirer/prompts";
import { Command } from "commander";
import kleur from "kleur";
import { z } from "zod";

import { writeProjectConfig } from "../config/index.js";
import { readCredentials, writeCredentials } from "../config/credentials.js";
import {
  globalCredentialsPath,
  globalLoginPendingPath,
  isGlobalProjectConfigPath,
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
  code?: string;
  sendCode?: boolean;
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

/**
 * In-flight email-code sign-in, persisted at
 * `~/.understudy/login-pending.json` (mode 600 — the claim token is
 * sensitive). Written when a code is sent, consumed by
 * `understudy login --code <code>`, removed on success. This is what
 * lets a coding agent drive sign-in as two plain shell commands
 * instead of holding an interactive prompt open.
 */
const PendingLoginSchema = z.object({
  email: z.string().email(),
  gateway_url: z.string().url(),
  claim_token: z.string().min(1),
  complete_url: z.string().url(),
  signup_intent_id: z.string().optional(),
  sent_at: z.string(),
});

type PendingLogin = z.infer<typeof PendingLoginSchema>;

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description(
      "Sign in or register with Understudy. `--email` sends a one-time code; in a non-interactive shell, finish with `understudy login --code <code>`.",
    )
    .option("--email <email>", "Use the auth.md email code registration flow.")
    .option(
      "--send-code",
      "Send the one-time code and exit without prompting; finish with `understudy login --code <code>`.",
    )
    .option(
      "--code <code>",
      "Complete a pending email sign-in with the one-time code from the inbox.",
    )
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

  if (opts.code) {
    await completePendingLogin(opts.code, json);
    return;
  }

  if (opts.sendCode && !opts.email) {
    throw new Error("--send-code requires --email <email>.");
  }

  if (opts.email) {
    const signupIntentId = opts.signupIntentId ?? signupIntentFromEnv();
    // Without a TTY (an agent's shell, a script) the inline code prompt
    // cannot work — degrade to send-and-exit so the caller can finish
    // with `understudy login --code <code>`.
    const sendOnly = Boolean(opts.sendCode) || !process.stdin.isTTY;
    await trackLoginStarted({ mode: "auth.md", gatewayUrl, signupIntentId });
    try {
      const result = await runAuthMdLogin(
        opts.email,
        gatewayUrl,
        json,
        sendOnly,
        signupIntentId,
      );
      if (!result) {
        return; // code sent; completion happens via `login --code`
      }
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
    "Run `understudy login --email <email>` to send a one-time code, then `understudy login --code <code>` to finish.",
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
  sendOnly: boolean,
  signupIntentId?: string,
): Promise<AgentClaimResponse | null> {
  const metadata = await fetchAuthMdMetadata(gatewayUrl);
  const register = await postJson(metadata.agent_auth.register_uri, {
    type: "identity_assertion",
    assertion_type: "verified_email",
    assertion: email,
    requested_credential_type: "api_key",
    ...(signupIntentId ? { signup_intent_id: signupIntentId } : {}),
  });
  const reg = AgentRegisterResponseSchema.parse(register);
  const completeUrl = resolveClaimCompleteUrl(
    reg.claim_url,
    metadata.agent_auth.claim_uri,
    metadata.agent_auth.register_uri,
  );

  // Persist the claim so the sign-in survives this process: an agent
  // (or an interrupted prompt) finishes with `understudy login --code`.
  const pending: PendingLogin = {
    email,
    gateway_url: gatewayUrl,
    claim_token: reg.claim_token,
    complete_url: completeUrl,
    ...(signupIntentId ? { signup_intent_id: signupIntentId } : {}),
    sent_at: new Date().toISOString(),
  };
  writePendingLogin(pending);

  if (sendOnly) {
    emitCodeSent(pending, json);
    return null;
  }

  if (!json) {
    process.stdout.write(
      `${kleur.gray(`Sent a one-time code to ${email}.`)}\n`,
    );
  }
  const code = await input({ message: "One-time code:" });

  const claim = await postJson(completeUrl, {
    claim_token: reg.claim_token,
    code,
  });
  const result = AgentClaimResponseSchema.parse(claim);
  clearPendingLogin();
  return result;
}

/**
 * Phase two of the email-code flow: `understudy login --code <code>`.
 * Reads the pending claim written by phase one, completes it, saves
 * credentials, and clears the pending file. The pending file is kept
 * on failure so a mistyped code can simply be retried.
 */
async function completePendingLogin(code: string, json: boolean): Promise<void> {
  const pending = readPendingLogin();
  if (!pending) {
    throw new Error(
      "No pending sign-in found. Run `understudy login --email <email>` first to send a one-time code.",
    );
  }
  try {
    const claim = await postJson(pending.complete_url, {
      claim_token: pending.claim_token,
      code: code.trim(),
    });
    const result = AgentClaimResponseSchema.parse(claim);
    saveApiKeyResult(result, pending.gateway_url, pending.signup_intent_id);
    clearPendingLogin();
    emitApiKeySuccess(result, json, "auth.md");
    await trackLoginCompleted({
      apiKey: result.credential,
      gatewayUrl: result.gateway_url ?? pending.gateway_url,
      mode: "auth.md",
      orgId: result.org_id ?? result.organization_id ?? null,
      userId: result.user_id ?? null,
      signupIntentId: pending.signup_intent_id ?? null,
    });
  } catch (err) {
    await trackLoginFailed({
      mode: "auth.md",
      gatewayUrl: pending.gateway_url,
      signupIntentId: pending.signup_intent_id,
      errorKind: loginErrorKind(err),
    });
    if (err instanceof Error) {
      err.message += ` If the code expired (about 10 minutes), run \`understudy login --email ${pending.email}\` to send a fresh one.`;
    }
    throw err;
  }
}

function writePendingLogin(pending: PendingLogin): void {
  const path = globalLoginPendingPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(pending, null, 2)}\n`, {
    encoding: "utf8",
  });
  chmodSync(path, 0o600);
}

function readPendingLogin(): PendingLogin | null {
  const path = globalLoginPendingPath();
  if (!existsSync(path)) {
    return null;
  }
  return PendingLoginSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function clearPendingLogin(): void {
  const path = globalLoginPendingPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function emitCodeSent(pending: PendingLogin, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        pending: true,
        code_sent_to: pending.email,
        gateway_url: pending.gateway_url,
        complete_with: "understudy login --code <code>",
        expires_in_minutes: 10,
        pending_path: globalLoginPendingPath(),
      })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${kleur.green("✓")} One-time code sent to ${kleur.bold(pending.email)}\n` +
      `  Get the code from the inbox, then finish with:\n` +
      `    ${kleur.cyan("understudy login --code <code>")}\n` +
      `  ${kleur.dim("The code expires in about 10 minutes.")}\n`,
  );
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
    const target = `${PROJECT_CONFIG_DIR}/config.json`;
    if (isGlobalProjectConfigPath(target)) {
      // Running from `$HOME`: `.understudy/` there is the global config
      // dir, not a project. Credentials are saved; the project pin waits
      // for a real repo.
      process.stderr.write(
        "note: current directory is your home directory, so no project config was written. cd into your project and run `understudy projects use <slug>`.\n",
      );
    } else {
      writeProjectConfig(target, {
        org_id: orgId,
        project_slug: result.default_project.slug,
      });
    }
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
