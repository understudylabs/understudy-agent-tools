#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDir, "..");
export const EXPECTED_BUN_REVISION = "1.3.14+0d9b296af";
export const EXPECTED_NODE_VERSION = "v22.23.0";

const RESOURCE_ENTRIES = [
  ".agents",
  ".claude-plugin",
  ".codex-plugin",
  ".cursor-plugin",
  ".devin",
  ".hermes",
  ".opencode",
  "AGENTS.md",
  "LICENSE",
  "README.md",
  "dist",
  "docs",
  "experiments/desktop-tool-proof",
  "package.json",
  "runtime-assets",
  "schemas",
  "skills",
];

const EXTERNAL_RUNTIME_MODULES = [
  {
    specifier: "@silvia-odwyer/photon-node",
    source:
      "node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node",
  },
  {
    specifier: "undici",
    source: "node_modules/@earendil-works/pi-coding-agent/node_modules/undici",
  },
];

export function desktopTargetTriple(platform = process.platform, arch = process.arch) {
  const key = `${platform}/${arch}`;
  const triples = {
    "darwin/arm64": "aarch64-apple-darwin",
    "darwin/x64": "x86_64-apple-darwin",
    "linux/arm64": "aarch64-unknown-linux-gnu",
    "linux/x64": "x86_64-unknown-linux-gnu",
    "win32/x64": "x86_64-pc-windows-msvc",
  };
  const triple = triples[key];
  if (!triple) throw new Error(`unsupported Desktop CLI build target: ${key}`);
  return triple;
}

export function desktopCliPaths(root = repositoryRoot, target = desktopTargetTriple()) {
  const tauriRoot = join(root, "apps", "homescreen", "src-tauri");
  const resourceRoot = join(tauriRoot, "resources", "understudy-cli");
  return {
    nodeBinary: join(tauriRoot, "binaries", `understudy-node-${target}`),
    entry: join(resourceRoot, "bundle", "understudy.js"),
    resourceRoot,
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stageResources(root, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const relative of RESOURCE_ENTRIES) {
    const source = join(root, relative);
    if (!existsSync(source)) throw new Error(`Desktop CLI resource is missing: ${relative}`);
    cpSync(source, join(destination, relative), { recursive: true, dereference: false });
  }
  // These package adapters intentionally use repo-relative symlinks during
  // development. The npm package excludes them, and a Desktop resource copy
  // must do the same: cpSync resolves them to machine-specific absolute links
  // that both leak the builder path and make Tauri walk the skills twice.
  rmSync(join(destination, ".devin", "skills"), { force: true });
  rmSync(join(destination, ".opencode", "skills"), { force: true });
}

function stageExternalRuntimeModules(root, resourceRoot) {
  return EXTERNAL_RUNTIME_MODULES.map(({ specifier, source }) => {
    const sourceRoot = join(root, source);
    const packageJsonPath = join(sourceRoot, "package.json");
    if (!existsSync(packageJsonPath)) {
      throw new Error(`Desktop CLI external module is missing: ${specifier}`);
    }
    const destination = join(resourceRoot, "bundle", "node_modules", ...specifier.split("/"));
    cpSync(sourceRoot, destination, { recursive: true, dereference: false });
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return { name: specifier, version: packageJson.version };
  });
}

function nodeLicensePath(nodeBinary) {
  const configured = process.env.UNDERSTUDY_DESKTOP_NODE_LICENSE?.trim();
  const candidates = [
    configured,
    resolve(dirname(nodeBinary), "..", "LICENSE"),
    resolve(dirname(nodeBinary), "..", "..", "LICENSE"),
    resolve(dirname(nodeBinary), "LICENSE"),
  ].filter(Boolean);
  const license = candidates.find((candidate) => existsSync(candidate));
  if (!license) {
    throw new Error(
      `Could not locate the license for bundled Node ${nodeBinary}; set ` +
        "UNDERSTUDY_DESKTOP_NODE_LICENSE",
    );
  }
  return license;
}

function assertPinnedNodeVersion(version) {
  if (String(version).trim() !== EXPECTED_NODE_VERSION) {
    throw new Error(
      `Desktop Node ${version} does not match pinned ${EXPECTED_NODE_VERSION}; set ` +
        "UNDERSTUDY_DESKTOP_NODE_BIN to the pinned executable",
    );
  }
}

export function buildDesktopCli({ root = repositoryRoot, target = desktopTargetTriple() } = {}) {
  if (target !== desktopTargetTriple()) {
    throw new Error(
      `Desktop CLI build cannot copy host Node for ${target}; build on the target platform`,
    );
  }
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const paths = desktopCliPaths(root, target);
  const nodeSource = resolve(process.env.UNDERSTUDY_DESKTOP_NODE_BIN ?? process.execPath);
  const nodeVersion = execFileSync(nodeSource, ["--version"], { encoding: "utf8" }).trim();
  assertPinnedNodeVersion(nodeVersion);
  const bunRevision = execFileSync("bun", ["--revision"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (bunRevision !== EXPECTED_BUN_REVISION) {
    throw new Error(
      `Desktop CLI bundler ${bunRevision} does not match pinned ${EXPECTED_BUN_REVISION}`,
    );
  }

  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  stageResources(root, paths.resourceRoot);
  mkdirSync(dirname(paths.entry), { recursive: true });
  const embedNode = process.env.UNDERSTUDY_DESKTOP_EMBED_NODE === "true";
  if (embedNode) {
    mkdirSync(dirname(paths.nodeBinary), { recursive: true });
    cpSync(nodeSource, paths.nodeBinary);
    chmodSync(paths.nodeBinary, 0o755);
  }
  execFileSync(
    "bun",
    [
      "build",
      "src/bin.ts",
      "--target=node",
      "--format=esm",
      "--define",
      "__UNDERSTUDY_DESKTOP_BUNDLE__=true",
      ...EXTERNAL_RUNTIME_MODULES.flatMap(({ specifier }) => ["--external", specifier]),
      "--outfile",
      paths.entry,
    ],
    { cwd: root, stdio: "inherit" },
  );
  const externalModules = stageExternalRuntimeModules(root, paths.resourceRoot);
  const bundleSource = readFileSync(paths.entry, "utf8");
  if (bundleSource.includes(root)) {
    throw new Error("Desktop CLI bundle contains the machine-specific repository path");
  }
  const nodeLicense = nodeLicensePath(nodeSource);
  const stagedNodeLicense = join(paths.resourceRoot, "third-party", "node", "LICENSE");
  mkdirSync(dirname(stagedNodeLicense), { recursive: true });
  cpSync(nodeLicense, stagedNodeLicense);
  const manifest = {
    schema_version: "understudy.desktop_cli_bundle.v1",
    cli_version: packageJson.version,
    target,
    bun_revision: bunRevision,
    node_version: nodeVersion,
    node_sha256: sha256(nodeSource),
    cli_bundle_sha256: sha256(paths.entry),
    external_modules: externalModules,
  };
  writeFileSync(
    join(paths.resourceRoot, "desktop-cli-bundle.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { ...paths, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildDesktopCli();
    process.stdout.write(
      `Desktop CLI ${result.manifest.cli_version} bundled for ${result.manifest.target}\n` +
        `${result.nodeBinary}\n${result.entry}\n${result.resourceRoot}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
