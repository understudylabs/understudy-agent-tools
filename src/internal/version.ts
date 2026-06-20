import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Compiled to dist/internal/version.js, so the package root is two levels up.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The CLI version from package.json. Single source of truth for
 * `--version`, telemetry payloads, and doctor's version-consistency
 * check against the plugin manifests.
 */
export function readCliVersion(): string {
  return readManifestVersion(join(packageRoot, "package.json")) ?? "0.0.0";
}

/**
 * Versions that must move together on catalog-changing releases.
 * Installed plugins have no other staleness signal — see
 * docs/release-checklist.md.
 */
export function readManifestVersions(): {
  cli: string | null;
  plugin: string | null;
  marketplace: string | null;
  cursorPlugin: string | null;
  codexPlugin: string | null;
  codexMarketplace: string | null;
  opencodeAdapter: string | null;
} {
  return {
    cli: readManifestVersion(join(packageRoot, "package.json")),
    plugin: readManifestVersion(join(packageRoot, ".claude-plugin", "plugin.json")),
    marketplace: readManifestVersion(
      join(packageRoot, ".claude-plugin", "marketplace.json"),
      (parsed) => (parsed as { metadata?: { version?: string } }).metadata?.version,
    ),
    cursorPlugin: readManifestVersion(join(packageRoot, ".cursor-plugin", "plugin.json")),
    codexPlugin: readManifestVersion(join(packageRoot, ".codex-plugin", "plugin.json")),
    codexMarketplace: readManifestVersion(
      join(packageRoot, ".agents", "plugins", "marketplace.json"),
      (parsed) => (parsed as { metadata?: { version?: string } }).metadata?.version,
    ),
    opencodeAdapter: readManifestVersion(join(packageRoot, ".opencode", "adapter.json")),
  };
}

function readManifestVersion(
  path: string,
  pick: (parsed: unknown) => string | undefined = (parsed) =>
    (parsed as { version?: string }).version,
): string | null {
  try {
    return pick(JSON.parse(readFileSync(path, "utf8"))) ?? null;
  } catch {
    return null;
  }
}
