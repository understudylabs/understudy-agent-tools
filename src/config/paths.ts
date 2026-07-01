import { homedir } from "node:os";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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
 *
 * `$HOME` is never a project root: `~/.understudy/` is the *global*
 * config dir (credentials.json, profile.json, agent-card.json), not a
 * project marker. Matching it made every walk that reached the home
 * directory "find" a project there, and per-repo state (the active
 * project) ended up written to `~/.understudy/config.json`.
 */
export function findProjectRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);
  const root = resolve("/");
  const home = canonicalDir(resolve(homedir()));

  while (true) {
    if (canonicalDir(current) !== home) {
      const candidate = join(current, PROJECT_CONFIG_DIR);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current || parent === root) {
      return resolve(startDir);
    }
    current = parent;
  }
}

/**
 * Resolve symlinks so paths compare structurally — on macOS `$HOME` can
 * arrive as `/var/...` while `process.cwd()` reports `/private/var/...`
 * for the same directory. Falls back to the input when it doesn't exist.
 */
function canonicalDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when `path` resolves to the global `~/.understudy/config.json`.
 * That file is never a *project* config — readers must treat it as
 * "no project" and writers must refuse it, or the global dir starts
 * claiming an active project for every directory under `$HOME`.
 */
export function isGlobalProjectConfigPath(path: string): boolean {
  const global = join(globalConfigDir(), PROJECT_CONFIG_FILE);
  const target = resolve(path);
  if (target === global) {
    return true;
  }
  // The file itself may not exist yet; canonicalize the parent dirs so
  // symlinked forms of the same location still match.
  return (
    basename(target) === basename(global) &&
    canonicalDir(dirname(target)) === canonicalDir(dirname(global))
  );
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
