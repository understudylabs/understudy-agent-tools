import { homedir } from "node:os";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The per-repo config directory name. Sits alongside `.git/`.
 */
export const PROJECT_CONFIG_DIR = ".understudy";

/**
 * Per-repo config filename.
 */
export const PROJECT_CONFIG_FILE = "config.json";

/**
 * Global credentials directory under the user's home.
 */
export const GLOBAL_CONFIG_DIR = ".understudy";

/**
 * Global credentials filename.
 */
export const GLOBAL_CREDENTIALS_FILE = "credentials.json";

export const GLOBAL_TELEMETRY_FILE = "telemetry.json";

/**
 * In-flight email-code sign-in state. Written when a one-time code is
 * sent, consumed by `understudy login --code`, removed on success.
 */
export const GLOBAL_LOGIN_PENDING_FILE = "login-pending.json";

/**
 * Walk upward from `startDir` looking for the nearest directory that
 * contains a `.understudy/` folder. If none exists, fall back to
 * `startDir` itself.
 *
 * This is the same pattern as `package.json` / `.git` lookup — the CLI
 * should "just work" from any subdirectory of a repo that's been
 * signed in with `understudy login`.
 */
export function findProjectRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);
  const root = resolve("/");

  while (true) {
    const candidate = join(current, PROJECT_CONFIG_DIR);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current || parent === root) {
      return resolve(startDir);
    }
    current = parent;
  }
}

export function projectConfigPath(startDir: string = process.cwd()): string {
  return join(findProjectRoot(startDir), PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
}

export function globalConfigDir(): string {
  return join(homedir(), GLOBAL_CONFIG_DIR);
}

export function globalCredentialsPath(): string {
  return join(globalConfigDir(), GLOBAL_CREDENTIALS_FILE);
}

export function globalTelemetryPath(): string {
  return join(globalConfigDir(), GLOBAL_TELEMETRY_FILE);
}

export function globalLoginPendingPath(): string {
  return join(globalConfigDir(), GLOBAL_LOGIN_PENDING_FILE);
}
