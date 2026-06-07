import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";

import { readCredentials } from "../config/credentials.js";
import { DEFAULT_GATEWAY_URL } from "../config/defaults.js";
import { readProjectConfig } from "../config/index.js";
import { globalTelemetryPath } from "../config/paths.js";

const TELEMETRY_TIMEOUT_MS = 3_000;
const EVENT_VERSION = 1;
const CLI_VERSION = "0.0.0";

const TelemetryStateSchema = z.object({
  install_id: z.string().min(1),
});

type TelemetryProperties = Record<string, string | number | boolean | null>;

interface TrackCliEventOpts {
  apiKey?: string;
  gatewayUrl?: string;
  properties?: TelemetryProperties;
}

interface LoginCompletedEvent {
  apiKey: string;
  gatewayUrl: string;
  mode: "auth.md" | "manual";
  orgId: string | null;
  userId?: string | null;
  signupIntentId?: string | null;
}

interface LoginAttemptEvent {
  mode: "auth.md" | "manual";
  gatewayUrl?: string;
  signupIntentId?: string | null;
  errorKind?: string;
}

interface SetupCompletedEvent {
  skill: string;
  global: boolean;
  referenceCount: number;
}

interface RunEvent {
  apiKey: string;
  gatewayUrl: string;
  commandKind: string;
  orgId: string | null;
  projectSlug: string | null;
  authSource: "env" | "stored";
}

interface RunCompletedEvent extends RunEvent {
  exitCode: number;
  durationMs: number;
}

interface StatusCheckedEvent {
  configured: boolean;
  signedIn: boolean;
}

interface ControlPlaneEvent {
  resource: "api_keys" | "projects" | "models" | "workload_routes";
  action: "listed" | "created" | "revoked" | "switched" | "deleted" | "updated" | "cleared";
  orgId: string | null;
  projectSlug?: string | null;
  resultCount?: number;
}

export async function trackLoginStarted(event: LoginAttemptEvent): Promise<void> {
  await trackCliEvent("cli_login_started", {
    gatewayUrl: event.gatewayUrl,
    properties: {
      mode: event.mode,
      signup_intent_id: event.signupIntentId ?? null,
    },
  });
}

export async function trackLoginCompleted(
  event: LoginCompletedEvent,
): Promise<void> {
  await trackCliEvent("cli_login_completed", {
    apiKey: event.apiKey,
    gatewayUrl: event.gatewayUrl,
    properties: {
      mode: event.mode,
      org_id: event.orgId,
      user_id: event.userId ?? null,
      signup_intent_id: event.signupIntentId ?? null,
    },
  });
}

export async function trackLoginFailed(event: LoginAttemptEvent): Promise<void> {
  await trackCliEvent("cli_login_failed", {
    gatewayUrl: event.gatewayUrl,
    properties: {
      mode: event.mode,
      signup_intent_id: event.signupIntentId ?? null,
      error_kind: event.errorKind ?? "unknown",
    },
  });
}

export async function trackSetupCompleted(
  event: SetupCompletedEvent,
): Promise<void> {
  await trackCliEvent("cli_skill_installed", {
    properties: {
      skill: event.skill,
      global: event.global,
      reference_count: event.referenceCount,
    },
  });
}

export function trackRunStarted(event: RunEvent): void {
  void trackCliEvent("cli_run_started", {
    apiKey: event.apiKey,
    gatewayUrl: event.gatewayUrl,
    properties: runProperties(event),
  });
}

export async function trackRunCompleted(
  event: RunCompletedEvent,
): Promise<void> {
  await trackCliEvent(event.exitCode === 0 ? "cli_run_completed" : "cli_run_failed", {
    apiKey: event.apiKey,
    gatewayUrl: event.gatewayUrl,
    properties: {
      ...runProperties(event),
      exit_code: event.exitCode,
      duration_ms: event.durationMs,
    },
  });
}

export async function trackStatusChecked(event: StatusCheckedEvent): Promise<void> {
  await trackCliEvent("cli_activation_status_checked", {
    properties: {
      configured: event.configured,
      signed_in: event.signedIn,
    },
  });
}

export function trackControlPlaneAction(event: ControlPlaneEvent): void {
  const eventName = `cli_${event.resource}_${event.action}`;
  void trackCliEvent(eventName, {
    properties: {
      resource: event.resource,
      action: event.action,
      org_id: event.orgId,
      project_slug: event.projectSlug ?? null,
      result_count: event.resultCount ?? null,
    },
  });
}

async function trackCliEvent(
  eventName: string,
  opts: TrackCliEventOpts = {},
): Promise<void> {
  if (process.env.UNDERSTUDY_TELEMETRY === "0") return;

  const context = resolveTelemetryContext(opts);
  if (!context) return;

  const body = {
    event_name: eventName,
    event_version: EVENT_VERSION,
    install_id: readOrCreateInstallId(),
    created_at_ms: Date.now(),
    version: CLI_VERSION,
    properties: sanitizeProperties({
      ...context.properties,
      ...(opts.properties ?? {}),
    }),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  timer.unref();
  try {
    await fetch(`${context.gatewayUrl.replace(/\/+$/, "")}/v1/agent/events`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${context.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Telemetry must never affect CLI behavior.
  } finally {
    clearTimeout(timer);
  }
}

function runProperties(event: RunEvent): TelemetryProperties {
  return {
    command_kind: event.commandKind,
    org_id: event.orgId,
    project_slug: event.projectSlug,
    auth_source: event.authSource,
  };
}

function resolveTelemetryContext(
  opts: TrackCliEventOpts,
): { apiKey: string; gatewayUrl: string; properties: TelemetryProperties } | null {
  const config = safeReadProjectConfig();
  const credentials = safeReadCredentials();
  const properties = defaultProperties(config, credentials);

  if (opts.apiKey) {
    return {
      apiKey: opts.apiKey,
      gatewayUrl:
        opts.gatewayUrl ??
        process.env.UNDERSTUDY_GATEWAY_URL ??
        DEFAULT_GATEWAY_URL,
      properties,
    };
  }

  const envApiKey = process.env.UNDERSTUDY_API_KEY;
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      gatewayUrl:
        process.env.UNDERSTUDY_GATEWAY_URL ??
        DEFAULT_GATEWAY_URL,
      properties,
    };
  }

  if (!credentials) return null;

  const orgCredentials = config ? credentials.orgs[config.org_id] : undefined;
  const apiKey = orgCredentials?.api_key ?? credentials.api_key;
  if (!apiKey) return null;

  return {
    apiKey,
    gatewayUrl:
      orgCredentials?.gateway_url ??
      credentials.gateway_url ??
      DEFAULT_GATEWAY_URL,
    properties,
  };
}

function defaultProperties(
  config: ReturnType<typeof readProjectConfig>,
  credentials: ReturnType<typeof readCredentials>,
): TelemetryProperties {
  return {
    app: "understudy_cli",
    command_platform: process.platform,
    command_arch: process.arch,
    org_id: config?.org_id ?? null,
    project_slug: config?.project_slug ?? null,
    user_id: credentials?.user_id ?? null,
    signup_intent_id:
      process.env.UNDERSTUDY_SIGNUP_INTENT_ID ??
      credentials?.signup_intent_id ??
      null,
  };
}

function safeReadCredentials(): ReturnType<typeof readCredentials> {
  try {
    return readCredentials();
  } catch {
    return null;
  }
}

function safeReadProjectConfig(): ReturnType<typeof readProjectConfig> {
  try {
    return readProjectConfig();
  } catch {
    return null;
  }
}

function sanitizeProperties(
  properties: TelemetryProperties,
): TelemetryProperties {
  const sanitized: TelemetryProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!/^[a-zA-Z0-9_.$-]{1,80}$/.test(key)) continue;
    if (typeof value === "string") {
      if (value.startsWith("sk_")) continue;
      sanitized[key] = value.slice(0, 200);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function readOrCreateInstallId(): string {
  const path = globalTelemetryPath();
  if (existsSync(path)) {
    const parsed = TelemetryStateSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    if (parsed.success) return parsed.data.install_id;
  }

  const state = { install_id: randomUUID() };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  chmodSync(path, 0o600);
  return state.install_id;
}
