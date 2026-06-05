import { readCredentials } from "../config/credentials.js";
import { readProjectConfig } from "../config/index.js";

/**
 * Resolved Understudy environment for the current process. This is
 * what an SDK call needs: an org id, a project slug, an API key, and
 * the gateway URL to point the SDK at.
 */
export interface UnderstudyEnv {
  org_id: string;
  project_slug: string;
  api_key: string;
  gateway_url: string;
}

/**
 * Read `.understudy/config.json` (nearest ancestor of cwd) and
 * `~/.understudy/credentials.json`, validate them, and return the
 * combined `UnderstudyEnv`. Throws a single clear error if anything
 * is missing or malformed.
 *
 * The snippets that route traffic through Understudy use this helper so that
 * a misconfigured shell can never produce a silent 400 from the
 * gateway — the failure surfaces at `import` time.
 */
export function requireUnderstudyEnv(): UnderstudyEnv {
  const config = readProjectConfig();
  if (!config) {
    throw new Error(
      [
        "No Understudy config found.",
        "Run `understudy-tools login` in your project root to create .understudy/config.json.",
      ].join(" "),
    );
  }

  const credentials = readCredentials();
  if (!credentials) {
    throw new Error(
      [
        "No Understudy credentials found.",
        "Run `understudy-tools login` to create ~/.understudy/credentials.json.",
      ].join(" "),
    );
  }

  const orgCredentials = credentials.orgs[config.org_id];
  if (!orgCredentials) {
    throw new Error(
      [
        `No credentials for org_id=${config.org_id} in ~/.understudy/credentials.json.`,
        "Run `understudy-tools login` to sign in to this org.",
      ].join(" "),
    );
  }

  return {
    org_id: config.org_id,
    project_slug: config.project_slug,
    api_key: orgCredentials.api_key,
    gateway_url: orgCredentials.gateway_url,
  };
}

/**
 * Non-throwing companion to `requireUnderstudyEnv`. Writes a single
 * warning line to stderr when config is missing or invalid and
 * returns `null`. Intended for app startup to surface configuration
 * issues without crashing.
 */
export function precheck(): UnderstudyEnv | null {
  try {
    return requireUnderstudyEnv();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`understudy: ${message}\n`);
    return null;
  }
}
