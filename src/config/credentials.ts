import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { globalCredentialsPath } from "./paths.js";

/**
 * `~/.understudy/credentials.json` shape. Keyed by `org_id` so a user
 * who belongs to multiple Understudy orgs can carry one credential
 * per org.
 */
export const CredentialsSchema = z.object({
  api_key: z.string().min(1).optional(),
  gateway_url: z.string().url().optional(),
  user_id: z.string().min(1).optional(),
  email: z.string().email().optional(),
  signup_intent_id: z.string().min(1).max(200).optional(),
  orgs: z.record(
    z.string().min(1),
    z.object({
      api_key: z.string().min(1),
      gateway_url: z.string().url(),
    }),
  ),
});

export type Credentials = z.infer<typeof CredentialsSchema>;

/**
 * Read `~/.understudy/credentials.json`. Returns `null` if absent.
 *
 * Emits a warning to stderr if the file is world- or group-readable;
 * does not refuse to read. The warning makes the next credentials write
 * the right mode.
 */
export function readCredentials(): Credentials | null {
  const path = globalCredentialsPath();
  if (!existsSync(path)) {
    return null;
  }
  warnIfPermissive(path);
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Failed to parse ${path} as JSON: ${(cause as Error).message}`, {
      cause,
    });
  }
  return CredentialsSchema.parse(parsed);
}

/**
 * Write `~/.understudy/credentials.json` with mode 600. Creates the
 * `~/.understudy/` directory if needed.
 */
export function writeCredentials(credentials: Credentials): void {
  CredentialsSchema.parse(credentials);
  const path = globalCredentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8" });
  chmodSync(path, 0o600);
}

function warnIfPermissive(path: string): void {
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      const display = mode.toString(8).padStart(3, "0");
      process.stderr.write(
        `warning: ${path} mode is ${display}; expected 600. Anyone on this machine can read your Understudy API key.\n`,
      );
    }
  } catch {
    // Best-effort. If we can't stat the file we'll fail in readFileSync.
  }
}
