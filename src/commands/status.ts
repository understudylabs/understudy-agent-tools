import { Command } from "commander";
import kleur from "kleur";

import { readCredentials } from "../config/credentials.js";
import { readProjectConfig } from "../config/index.js";
import { isJsonMode, runAction } from "../internal/output.js";
import { telemetryEnabled, trackStatusChecked } from "../internal/telemetry.js";

/**
 * `understudy status` — print active org, project, key suffix, and
 * gateway URL. Reads local config only; performs no I/O beyond the
 * filesystem. Safe to use on any machine, including fresh ones with
 * no config (prints a clear "not signed in" message and exits 0).
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Print the active Understudy org, project, key suffix, and gateway URL.")
    .action(async function (this: Command) {
      await runAction(this, async () => {
        process.exitCode = await runStatus(isJsonMode(this));
      });
    });
}

/**
 * Exported so tests can call it without spinning up a Command tree.
 *
 * Writes to `process.stdout` / `process.stderr`. Returns the exit
 * code the caller should use — `0` for success or "no config",
 * `1` only when config is present but invalid (since that means
 * the user's repo is broken).
 */
export async function runStatus(json = false): Promise<0 | 1> {
  const config = (() => {
    try {
      return readProjectConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${kleur.red("error")}: ${message}\n`);
      return "invalid" as const;
    }
  })();

  if (config === "invalid") {
    return 1;
  }

  const credentials = (() => {
    try {
      return readCredentials();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${kleur.red("error")}: ${message}\n`);
      return "invalid" as const;
    }
  })();

  if (credentials === "invalid") {
    return 1;
  }

  // A credential in the `orgs` map signs the user in just like the legacy
  // top-level `api_key` — `resolveAuth` sends requests with it, so status
  // must agree (and so must the desktop app, which mirrors this order).
  const orgIds = credentials ? Object.keys(credentials.orgs) : [];
  const envApiKey = process.env.UNDERSTUDY_API_KEY;
  const authMode = envApiKey
    ? "env_api_key"
    : credentials?.api_key || orgIds.length > 0
      ? "api_key"
      : null;

  if (!config && !authMode) {
    await trackStatusChecked({ configured: false, signedIn: false });
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, configured: false, signed_in: false, hint: "Run `understudy login`." })}\n`,
      );
      return 0;
    }
    process.stdout.write(
      `${kleur.yellow("not signed in")} — run ${kleur.bold("understudy login")} to sign in or register.\n`,
    );
    return 0;
  }

  // Active org: the project config names one; otherwise a sole entry in
  // the orgs map is unambiguous (same rule as `resolveOrgId`).
  const activeOrgId =
    config?.org_id ?? (orgIds.length === 1 ? orgIds[0] : undefined);
  const orgCredentials = activeOrgId ? credentials?.orgs[activeOrgId] : undefined;
  const storedApiKey = orgCredentials?.api_key ?? credentials?.api_key;
  const gatewayUrl =
    orgCredentials?.gateway_url ??
    credentials?.gateway_url ??
    null;

  if (json) {
    await trackStatusChecked({
      configured: Boolean(config),
      signedIn: Boolean(authMode),
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        configured: Boolean(config),
        signed_in: Boolean(authMode),
        auth_mode: authMode,
        org_id: activeOrgId ?? null,
        project_slug: config?.project_slug ?? null,
        api_key_suffix: storedApiKey ? storedApiKey.slice(-4) : null,
        gateway_url: gatewayUrl,
        telemetry_enabled: telemetryEnabled(),
      })}\n`,
    );
    return 0;
  }

  const lines = [
    `${kleur.bold("signed_in")}     ${authMode ? "yes" : "no"}`,
    `${kleur.bold("auth_mode")}     ${authMode ?? kleur.yellow("none")}`,
    `${kleur.bold("org_id")}        ${activeOrgId ?? kleur.dim("(none)")}`,
    `${kleur.bold("project_slug")}  ${config?.project_slug ?? kleur.dim("(none)")}`,
    `${kleur.bold("api_key")}       ${storedApiKey ? maskKey(storedApiKey) : kleur.dim("(none)")}`,
    `${kleur.bold("gateway_url")}   ${gatewayUrl ?? kleur.dim("(unknown)")}`,
    `${kleur.bold("telemetry")}     ${
      telemetryEnabled()
        ? `on ${kleur.dim("(bounded usage events; disable with UNDERSTUDY_TELEMETRY=0)")}`
        : "off"
    }`,
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
  await trackStatusChecked({
    configured: Boolean(config),
    signedIn: Boolean(authMode),
  });
  return 0;
}

/**
 * Render `sk_abc...xyz1` style preview. Never prints more than the
 * first 3 and last 4 characters.
 */
function maskKey(key: string): string {
  if (key.length <= 7) {
    return "•".repeat(key.length);
  }
  const head = key.slice(0, 3);
  const tail = key.slice(-4);
  return `${head}${"•".repeat(Math.max(4, key.length - 7))}${tail}`;
}
