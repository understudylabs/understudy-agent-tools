#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDir, "..");

function valueAfter(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function buildDesktopUpdaterManifest({ version, signature, pubDate, notes, url }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid Desktop version ${version}`);
  if (!signature.trim()) throw new Error("updater signature is empty");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") throw new Error("updater URL must use HTTPS");
  if (Number.isNaN(Date.parse(pubDate))) throw new Error(`invalid updater publication date ${pubDate}`);
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      "darwin-aarch64": {
        signature: signature.trim(),
        url,
      },
    },
  };
}

export function desktopUpdaterPaths(root = repositoryRoot) {
  const bundle = join(root, "apps", "homescreen", "src-tauri", "target", "release", "bundle", "macos");
  return {
    archive: join(bundle, "Understudy.app.tar.gz"),
    signature: join(bundle, "Understudy.app.tar.gz.sig"),
    manifest: join(bundle, "latest.json"),
  };
}

function main(args = process.argv.slice(2)) {
  const root = resolve(valueAfter(args, "--root") ?? repositoryRoot);
  const packageJson = JSON.parse(
    readFileSync(join(root, "apps", "homescreen", "package.json"), "utf8"),
  );
  const version = valueAfter(args, "--version") ?? packageJson.version;
  const paths = desktopUpdaterPaths(root);
  const signaturePath = resolve(valueAfter(args, "--signature") ?? paths.signature);
  const outputPath = resolve(valueAfter(args, "--output") ?? paths.manifest);
  if (!existsSync(paths.archive)) throw new Error(`updater archive is missing: ${paths.archive}`);
  if (!existsSync(signaturePath)) throw new Error(`updater signature is missing: ${signaturePath}`);
  const archiveName = paths.archive.split("/").at(-1);
  const tag = `desktop-v${version}-mvp`;
  const manifest = buildDesktopUpdaterManifest({
    version,
    signature: readFileSync(signaturePath, "utf8"),
    pubDate: valueAfter(args, "--pub-date") ?? new Date().toISOString(),
    notes: valueAfter(args, "--notes") ?? `Understudy Desktop ${version}`,
    url:
      valueAfter(args, "--url") ??
      `https://github.com/understudylabs/understudy-agent-tools/releases/download/${tag}/${archiveName}`,
  });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`wrote ${outputPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
