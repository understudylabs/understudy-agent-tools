import { spawn } from "node:child_process";

import { Command } from "commander";
import kleur from "kleur";

import { DEFAULT_GATEWAY_URL } from "../config/defaults.js";
import { readCredentials } from "../config/credentials.js";
import { readProjectConfig } from "../config/index.js";
import { isJsonMode, runAction } from "../internal/output.js";
import {
  trackRunCompleted,
  trackRunStarted,
} from "../internal/telemetry.js";

interface ResolvedRunEnv {
  apiKey: string;
  gatewayUrl: string;
  orgId: string | null;
  projectSlug: string | null;
  source: "env" | "stored";
}

/**
 * `understudy run -- <command>` — run an arbitrary child command with the
 * authenticated Understudy key injected into that process only.
 *
 * This is the agent-first bridge: skills can execute local inference
 * or cookbook scripts through Understudy without reading the credential
 * file, echoing a secret, or writing keys into repo files.
 */
export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Run a command with the authenticated Understudy API key injected.")
    .allowUnknownOption(true)
    .argument("<command...>", "Command to run after --, for example: understudy run -- npm run gepa")
    .action(async function (this: Command, command: string[]) {
      await runAction(this, () => runWithUnderstudyEnv(command, isJsonMode(this)));
    });
}

async function runWithUnderstudyEnv(
  command: string[],
  json: boolean,
): Promise<void> {
  const resolved = resolveRunEnv();
  const [bin, ...args] = command;
  if (!bin) {
    throw new Error("Usage: understudy run -- <command>");
  }

  const startedAt = Date.now();
  const commandKind = classifyCommand(bin, args);
  trackRunStarted({
    apiKey: resolved.apiKey,
    gatewayUrl: resolved.gatewayUrl,
    commandKind,
    orgId: resolved.orgId,
    projectSlug: resolved.projectSlug,
    authSource: resolved.source,
  });

  if (json) {
    process.stderr.write(
      `${JSON.stringify({
        ok: true,
        command: [bin, ...args],
        injected: ["UNDERSTUDY_API_KEY", "UNDERSTUDY_GATEWAY_URL"],
        org_id: resolved.orgId,
        project_slug: resolved.projectSlug,
        source: resolved.source,
      })}\n`,
    );
  } else {
    process.stderr.write(
      `${kleur.gray("understudy")} injecting UNDERSTUDY_API_KEY into child process\n`,
    );
  }

  const child = spawn(bin, args, {
    env: {
      ...process.env,
      UNDERSTUDY_API_KEY: resolved.apiKey,
      UNDERSTUDY_GATEWAY_URL: resolved.gatewayUrl,
    },
    stdio: "inherit",
  });

  const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (signal) {
        resolvePromise(1);
        return;
      }
      resolvePromise(code ?? 0);
    });
  });

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
  await trackRunCompleted({
    apiKey: resolved.apiKey,
    gatewayUrl: resolved.gatewayUrl,
    commandKind,
    orgId: resolved.orgId,
    projectSlug: resolved.projectSlug,
    authSource: resolved.source,
    exitCode,
    durationMs: Date.now() - startedAt,
  });
}

function classifyCommand(bin: string, args: string[]): string {
  if ((bin === "npm" || bin === "pnpm" || bin === "yarn") && args[0] === "run") {
    return `${bin} run`;
  }
  if (bin === "node") return "node";
  return "other";
}

function resolveRunEnv(): ResolvedRunEnv {
  const envApiKey = process.env.UNDERSTUDY_API_KEY;
  if (envApiKey) {
    const config = safeReadProjectConfig();
    return {
      apiKey: envApiKey,
      gatewayUrl:
        process.env.UNDERSTUDY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL,
      orgId: config?.org_id ?? null,
      projectSlug: config?.project_slug ?? null,
      source: "env",
    };
  }

  const config = readProjectConfig();
  const credentials = readCredentials();
  if (!credentials) {
    throw new Error("Not signed in. Run `understudy login` once, then re-run this command.");
  }

  const orgCredentials = config ? credentials.orgs[config.org_id] : undefined;
  const apiKey = orgCredentials?.api_key ?? credentials.api_key;
  const gatewayUrl =
    orgCredentials?.gateway_url ??
    credentials.gateway_url ??
    DEFAULT_GATEWAY_URL;

  if (!apiKey) {
    throw new Error("Not signed in. Run `understudy login` once, then re-run this command.");
  }

  return {
    apiKey,
    gatewayUrl,
    orgId: config?.org_id ?? null,
    projectSlug: config?.project_slug ?? null,
    source: "stored",
  };
}

function safeReadProjectConfig(): ReturnType<typeof readProjectConfig> {
  try {
    return readProjectConfig();
  } catch {
    return null;
  }
}
