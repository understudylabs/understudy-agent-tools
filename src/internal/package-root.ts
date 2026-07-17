import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

declare const __UNDERSTUDY_DESKTOP_BUNDLE__: boolean;

/**
 * Bun standalone executables expose bundled modules from its virtual `$bunfs`
 * filesystem. The Desktop build deliberately keeps mutable/public assets next
 * to the executable instead, so commands can inspect the exact shipped
 * package without requiring Node or npm on the user's machine.
 */
export function isStandaloneExecutable(): boolean {
  return import.meta.url.includes("/$bunfs/");
}

export function isDesktopSingleFileBundle(): boolean {
  return (
    typeof __UNDERSTUDY_DESKTOP_BUNDLE__ === "boolean" &&
    __UNDERSTUDY_DESKTOP_BUNDLE__
  );
}

function standalonePackageRoot(): string | null {
  if (!isStandaloneExecutable()) return null;
  const executableDir = dirname(process.execPath);
  const candidates = [
    join(executableDir, "resources"),
    join(executableDir, "..", "Resources", "understudy-cli-resources"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "package.json"))) ?? null;
}

/** Resolve the public package root for npm, linked-checkout, and Desktop builds. */
export function installedPackageRoot(): string {
  const configured = process.env.UNDERSTUDY_PACKAGE_ROOT?.trim();
  if (configured) return resolve(configured);
  const standalone = standalonePackageRoot();
  if (standalone) return resolve(standalone);
  if (isDesktopSingleFileBundle() && process.argv[1]) {
    return resolve(dirname(process.argv[1]), "..");
  }
  // Compiled to dist/internal/package-root.js, so the package root is two
  // levels above this module. The same relative shape holds in src/ for tests.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function packagePath(...parts: string[]): string {
  return join(installedPackageRoot(), ...parts);
}
