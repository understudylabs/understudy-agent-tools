import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { Command } from "commander";
import kleur from "kleur";

import { DEFAULT_GATEWAY_URL } from "../config/defaults.js";
import { readCredentials } from "../config/credentials.js";
import { isJsonMode, runAction } from "../internal/output.js";

/**
 * `understudy instrument --check` — local, no-network sanity check for the
 * zero-code instrumentation path (skills/instrument/SKILL.md).
 *
 * Reports three things:
 *   - which SDK base-URL redirect env vars are set, and whether they point
 *     at the active Understudy gateway;
 *   - whether stored credentials exist (so `understudy run` can inject a key);
 *   - whether any local captures exist under `.understudy/captures` (or
 *     `--source`), for the provider-log-import fallback path.
 *
 * Exit code 0 when at least one capture path is wired (a redirect env var is
 * set, or local captures exist); 1 otherwise. Reads only the filesystem and
 * the process environment — never the network.
 */

const REDIRECT_ENV_VARS = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"] as const;

interface InstrumentCheckOpts {
  source?: string;
  env?: NodeJS.ProcessEnv;
  json?: boolean;
}

interface RedirectEnvReport {
  name: string;
  value: string | null;
  points_at_gateway: boolean;
}

export interface InstrumentCheckReport {
  ok: boolean;
  gateway_url: string;
  gateway_url_source: "env" | "default";
  redirect_env: RedirectEnvReport[];
  redirect_wired: boolean;
  credentials_present: boolean;
  captures_dir: string;
  captures_present: boolean;
  capture_count: number;
  newest_capture_mtime: string | null;
  next_step: string;
}

export function registerInstrumentCommand(program: Command): void {
  program
    .command("instrument")
    .description("Check that capture instrumentation is wired: redirect env vars, credentials, local captures.")
    .option("--check", "Run the local instrumentation check (the only mode; kept explicit for clarity).")
    .option("--source <path>", "Local capture directory to check.", ".understudy/captures")
    .action(async function (this: Command, opts: { source?: string }) {
      await runAction(this, async () => {
        process.exitCode = runInstrumentCheck({ source: opts.source, json: isJsonMode(this) });
      });
    });
}

/**
 * Exported so tests can call it without spinning up a Command tree.
 * Returns the exit code the caller should use.
 */
export function runInstrumentCheck(opts: InstrumentCheckOpts = {}): 0 | 1 {
  const report = buildInstrumentCheckReport(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    printHuman(report);
  }
  return report.ok ? 0 : 1;
}

export function buildInstrumentCheckReport(opts: InstrumentCheckOpts = {}): InstrumentCheckReport {
  const env = opts.env ?? process.env;
  const gatewayFromEnv = trimUrl(env.UNDERSTUDY_GATEWAY_URL);
  const gatewayUrl = gatewayFromEnv ?? DEFAULT_GATEWAY_URL;
  const gatewayHost = hostOf(gatewayUrl);

  const redirectEnv: RedirectEnvReport[] = REDIRECT_ENV_VARS.map((name) => {
    const value = trimUrl(env[name]);
    return {
      name,
      value: value ?? null,
      points_at_gateway: value !== null && gatewayHost !== null && hostOf(value) === gatewayHost,
    };
  });
  const redirectWired = redirectEnv.some((entry) => entry.points_at_gateway);

  const credentialsPresent = (() => {
    try {
      return readCredentials() !== null;
    } catch {
      return false;
    }
  })();

  const capturesDir = opts.source ?? ".understudy/captures";
  const { count, newestMtime } = scanCaptures(capturesDir);

  const ok = redirectWired || count > 0;
  return {
    ok,
    gateway_url: gatewayUrl,
    gateway_url_source: gatewayFromEnv ? "env" : "default",
    redirect_env: redirectEnv,
    redirect_wired: redirectWired,
    credentials_present: credentialsPresent,
    captures_dir: capturesDir,
    captures_present: count > 0,
    capture_count: count,
    newest_capture_mtime: newestMtime,
    next_step: nextStep(redirectWired, credentialsPresent, count),
  };
}

function nextStep(redirectWired: boolean, credentialsPresent: boolean, captureCount: number): string {
  if (!credentialsPresent && captureCount === 0) {
    return "Sign in first (understudy login --email you@company.com), then redirect your app: ANTHROPIC_BASE_URL=\"$UNDERSTUDY_GATEWAY_URL\" understudy run -- <your app command>.";
  }
  if (!redirectWired && captureCount === 0) {
    return "Set a redirect env var and make one call: ANTHROPIC_BASE_URL=\"$UNDERSTUDY_GATEWAY_URL\" understudy run -- <your app command>, then verify with understudy captures list --json.";
  }
  if (redirectWired && captureCount === 0) {
    return "Redirect is wired. Trigger one test call, then verify with understudy captures list --json (gateway captures are hosted, not local).";
  }
  return "Captures exist. Hand off to skills/ingest-traces to turn them into local eval sets.";
}

function scanCaptures(dir: string): { count: number; newestMtime: string | null } {
  if (!existsSync(dir)) {
    return { count: 0, newestMtime: null };
  }
  let count = 0;
  let newest = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    count += 1;
    if (stats.mtimeMs > newest) newest = stats.mtimeMs;
  }
  return { count, newestMtime: newest > 0 ? new Date(newest).toISOString() : null };
}

function trimUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function printHuman(report: InstrumentCheckReport): void {
  const mark = (ok: boolean) => (ok ? kleur.green("ok") : kleur.yellow("--"));
  process.stdout.write(`${kleur.bold("instrument check")}\n`);
  process.stdout.write(`  gateway url        ${report.gateway_url} (${report.gateway_url_source})\n`);
  for (const entry of report.redirect_env) {
    const detail = entry.value
      ? entry.points_at_gateway
        ? `${entry.value} → gateway`
        : `${entry.value} (not the gateway)`
      : "unset";
    process.stdout.write(`  ${mark(entry.points_at_gateway)} ${entry.name.padEnd(18)} ${detail}\n`);
  }
  process.stdout.write(`  ${mark(report.credentials_present)} credentials        ${report.credentials_present ? "stored" : "not signed in"}\n`);
  process.stdout.write(
    `  ${mark(report.captures_present)} local captures     ${report.capture_count} file(s) in ${report.captures_dir}` +
      `${report.newest_capture_mtime ? ` (newest ${report.newest_capture_mtime})` : ""}\n`,
  );
  process.stdout.write(`\n  next: ${report.next_step}\n`);
}
