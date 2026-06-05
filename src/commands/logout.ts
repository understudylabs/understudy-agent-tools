import { existsSync, unlinkSync } from "node:fs";

import { Command } from "commander";
import kleur from "kleur";

import { readCredentials, writeCredentials } from "../config/credentials.js";
import { globalCredentialsPath } from "../config/paths.js";
import { isJsonMode } from "../internal/output.js";

/**
 * `understudy logout` — clear local credentials.
 *
 * Default behavior removes `~/.understudy/credentials.json` entirely
 * (logs out of every org). `--org <id>` clears just one org's entry
 * and rewrites the file; if that was the last org, the file is
 * removed.
 *
 * Idempotent: re-running after the file is gone prints a friendly
 * "already logged out" message and exits 0.
 */
interface LogoutOpts {
  org?: string;
}

export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Clear local Understudy credentials.")
    .option("--org <id>", "Log out of just this org. Default: clear all orgs.")
    .action(function (this: Command, opts: LogoutOpts) {
      runLogout(opts, isJsonMode(this));
    });
}

function runLogout(opts: LogoutOpts, json: boolean): void {
  const path = globalCredentialsPath();
  const existing = readCredentials();

  if (!existing) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, already_logged_out: true })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${kleur.gray("Already logged out — no credentials file found.")}\n`,
    );
    return;
  }

  if (!opts.org) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, removed: path })}\n`);
      return;
    }
    process.stdout.write(
      `${kleur.green("✓")} Logged out — removed ${path}\n`,
    );
    return;
  }

  if (!existing.orgs[opts.org]) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, org: opts.org, removed: false })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${kleur.yellow("•")} No credentials for ${opts.org} — nothing to do.\n`,
    );
    return;
  }

  const remaining = Object.fromEntries(
    Object.entries(existing.orgs).filter(([id]) => id !== opts.org),
  );

  if (Object.keys(remaining).length === 0) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, org: opts.org, removed: path })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${kleur.green("✓")} Logged out of ${opts.org} — credentials file is now empty, removed.\n`,
    );
    return;
  }

  writeCredentials({ ...existing, orgs: remaining });
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, org: opts.org, removed: true })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${kleur.green("✓")} Logged out of ${opts.org}.\n`,
  );
}
