#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDir, "..");

const CLI_JSON_SOURCES = [
  { path: "package.json", pointers: [["version"]] },
  { path: "package-lock.json", pointers: [["version"], ["packages", "", "version"]] },
  { path: ".agents/plugins/marketplace.json", pointers: [["metadata", "version"]] },
  { path: ".claude-plugin/marketplace.json", pointers: [["metadata", "version"]] },
  { path: ".claude-plugin/plugin.json", pointers: [["version"]] },
  { path: ".codex-plugin/plugin.json", pointers: [["version"]] },
  { path: ".cursor-plugin/plugin.json", pointers: [["version"]] },
  { path: ".devin/adapter.json", pointers: [["version"]] },
  { path: ".hermes/adapter.json", pointers: [["version"]] },
  { path: ".opencode/adapter.json", pointers: [["version"]] },
];

const DESKTOP_JSON_SOURCES = [
  { path: "apps/homescreen/package.json", pointers: [["version"]] },
  { path: "apps/homescreen/src-tauri/tauri.conf.json", pointers: [["version"]] },
];

const TEXT_SOURCES = [
  {
    path: "apps/homescreen/src-tauri/Cargo.toml",
    group: "desktop",
    pattern: /^(version\s*=\s*")([^"]+)("\s*)$/m,
    label: "Cargo package version",
  },
  {
    path: "apps/homescreen/src-tauri/Cargo.lock",
    group: "desktop",
    pattern: /(\[\[package\]\]\s*\nname\s*=\s*"understudy"\s*\nversion\s*=\s*")([^"]+)(")/m,
    label: "Cargo lock package version",
  },
  {
    path: "apps/homescreen/src-tauri/src/conversation_runtime.rs",
    group: "desktop",
    pattern: /(RUNTIME_VERSION:\s*&str\s*=\s*")([^"]+)(")/,
    label: "Rust conversation runtime version",
  },
  {
    path: "src/runtime/conversation/contract.ts",
    group: "desktop",
    pattern: /(RUNTIME_VERSION\s*=\s*")([^"]+)(")/,
    label: "TypeScript conversation runtime version",
  },
  {
    path: "apps/homescreen/src-tauri/src/bootstrap.rs",
    group: "cli",
    pattern: /(MIN_UNDERSTUDY_CLI_VERSION:\s*&str\s*=\s*")([^"]+)(")/,
    label: "Desktop minimum CLI version",
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function semver(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`${label} must be an exact x.y.z version`);
  }
  return normalized;
}

function compareSemver(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function pointerLabel(pointer) {
  return pointer.reduce(
    (label, key) => label + (
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
        ? `.${key}`
        : `[${JSON.stringify(key)}]`
    ),
    "$",
  );
}

function readPointer(value, pointer) {
  let current = value;
  for (const key of pointer) {
    if (!current || typeof current !== "object" || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

function setPointer(value, pointer, next) {
  let current = value;
  for (const key of pointer.slice(0, -1)) current = current[key];
  current[pointer.at(-1)] = next;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeAtomic(path, contents) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const mode = statSync(path).mode & 0o777;
  writeFileSync(temporary, contents, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

export function inspectReleaseVersionSources(root = repositoryRoot) {
  const sources = [];
  const errors = [];
  for (const source of [...CLI_JSON_SOURCES, ...DESKTOP_JSON_SOURCES]) {
    const group = CLI_JSON_SOURCES.includes(source) ? "cli" : "desktop";
    try {
      const absolute = join(root, source.path);
      const value = readJson(absolute);
      for (const pointer of source.pointers) {
        const version = readPointer(value, pointer);
        sources.push({
          path: source.path,
          selector: pointerLabel(pointer),
          group,
          version: typeof version === "string" ? version : null,
        });
        if (typeof version !== "string") {
          errors.push(`${source.path} ${pointerLabel(pointer)} has no string version`);
        }
      }
    } catch (error) {
      errors.push(`${source.path}: ${error.message}`);
    }
  }
  for (const source of TEXT_SOURCES) {
    try {
      const text = readFileSync(join(root, source.path), "utf8");
      const match = text.match(source.pattern);
      sources.push({
        path: source.path,
        selector: source.label,
        group: source.group,
        version: match?.[2] ?? null,
      });
      if (!match) errors.push(`${source.path}: could not read ${source.label}`);
    } catch (error) {
      errors.push(`${source.path}: ${error.message}`);
    }
  }

  const valuesFor = (group) => sources
    .filter((source) => source.group === group && source.version)
    .map((source) => source.version);
  const desktopValues = [...new Set(valuesFor("desktop"))];
  const cliValues = [...new Set(valuesFor("cli"))];
  if (desktopValues.length !== 1) {
    errors.push(`Desktop versions drifted: ${desktopValues.join(", ") || "none"}`);
  }
  if (cliValues.length !== 1) {
    errors.push(`CLI and adapter versions drifted: ${cliValues.join(", ") || "none"}`);
  }
  const packageCli = sources.find(
    (source) => source.path === "package.json" && source.selector === "$.version",
  )?.version ?? null;
  const desktopCliFloor = sources.find(
    (source) => source.selector === "Desktop minimum CLI version",
  )?.version ?? null;
  return {
    schema_version: "understudy.desktop_release_versions.v1",
    desktop_version: desktopValues.length === 1 ? desktopValues[0] : null,
    cli_version: cliValues.length === 1 ? cliValues[0] : null,
    compatibility: {
      desktop_runtime_aligned: desktopValues.length === 1,
      cli_adapters_aligned: cliValues.length === 1,
      desktop_cli_floor_matches_package:
        packageCli !== null && desktopCliFloor !== null && packageCli === desktopCliFloor,
      desktop_cli_floor: desktopCliFloor,
      package_cli: packageCli,
    },
    sources,
    errors,
  };
}

export function createDesktopReleasePlan({
  root = repositoryRoot,
  desktopVersion,
  cliVersion,
}) {
  const targetDesktop = semver(desktopVersion, "Desktop version");
  const targetCli = semver(cliVersion, "CLI version");
  const current = inspectReleaseVersionSources(root);
  if (current.errors.length > 0) {
    throw new Error(`cannot plan a release from drifted sources:\n${current.errors.join("\n")}`);
  }
  if (compareSemver(targetDesktop, current.desktop_version) !== 1) {
    throw new Error(`Desktop target ${targetDesktop} must advance ${current.desktop_version}`);
  }
  if (compareSemver(targetCli, current.cli_version) !== 1) {
    throw new Error(`CLI target ${targetCli} must advance ${current.cli_version}`);
  }
  const byPath = new Map();
  for (const source of current.sources) {
    const row = byPath.get(source.path) ?? {
      path: source.path,
      before_sha256: sha256(readFileSync(join(root, source.path))),
      replacements: [],
    };
    row.replacements.push({
      selector: source.selector,
      group: source.group,
      from: source.version,
      to: source.group === "desktop" ? targetDesktop : targetCli,
    });
    byPath.set(source.path, row);
  }
  return {
    schema_version: "understudy.desktop_release_plan.v1",
    generated_at: new Date().toISOString(),
    from: {
      desktop_version: current.desktop_version,
      cli_version: current.cli_version,
    },
    target: { desktop_version: targetDesktop, cli_version: targetCli },
    operations: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    verification: [
      "npm run build",
      "npm run typecheck",
      "npm test",
      "npm run desktop:release-check -- --stage source --allow-dirty --allow-unmerged",
      "git diff --check",
    ],
    note:
      "Canonical product versions only. Version-bound historical test fixtures and release documentation remain deliberate review items.",
  };
}

export function applyDesktopReleasePlan(plan, root = repositoryRoot) {
  if (plan?.schema_version !== "understudy.desktop_release_plan.v1") {
    throw new Error("unsupported Desktop release plan schema");
  }
  const expected = createDesktopReleasePlan({
    root,
    desktopVersion: plan.target?.desktop_version,
    cliVersion: plan.target?.cli_version,
  });
  if (!Array.isArray(plan.operations)) {
    throw new Error("release plan operations must be an array");
  }
  const expectedByPath = new Map(expected.operations.map((operation) => [operation.path, operation]));
  const planPaths = new Set(plan.operations.map((operation) => operation.path));
  if (
    expectedByPath.size !== plan.operations.length ||
    planPaths.size !== plan.operations.length
  ) {
    throw new Error("release plan does not cover every canonical version source");
  }
  for (const operation of plan.operations) {
    const live = expectedByPath.get(operation.path);
    if (!live || live.before_sha256 !== operation.before_sha256) {
      throw new Error(`release plan is stale for ${operation.path}; regenerate it`);
    }
    if (JSON.stringify(operation.replacements) !== JSON.stringify(live.replacements)) {
      throw new Error(`release plan operation changed for ${operation.path}; regenerate it`);
    }
  }

  const jsonByPath = new Map(
    [...CLI_JSON_SOURCES, ...DESKTOP_JSON_SOURCES].map((source) => [source.path, source]),
  );
  const textByPath = new Map(TEXT_SOURCES.map((source) => [source.path, source]));
  for (const operation of plan.operations) {
    const absolute = join(root, operation.path);
    const jsonSource = jsonByPath.get(operation.path);
    if (jsonSource) {
      const value = readJson(absolute);
      for (const replacement of operation.replacements) {
        const pointer = jsonSource.pointers.find(
          (candidate) => pointerLabel(candidate) === replacement.selector,
        );
        if (!pointer || readPointer(value, pointer) !== replacement.from) {
          throw new Error(`release plan source changed at ${operation.path} ${replacement.selector}`);
        }
        setPointer(value, pointer, replacement.to);
      }
      writeAtomic(absolute, `${JSON.stringify(value, null, 2)}\n`);
      continue;
    }
    const textSource = textByPath.get(operation.path);
    if (!textSource || operation.replacements.length !== 1) {
      throw new Error(`release plan has no safe writer for ${operation.path}`);
    }
    const replacement = operation.replacements[0];
    const text = readFileSync(absolute, "utf8");
    const match = text.match(textSource.pattern);
    if (!match || match[2] !== replacement.from) {
      throw new Error(`release plan source changed at ${operation.path}`);
    }
    writeAtomic(
      absolute,
      text.replace(textSource.pattern, `$1${replacement.to}$3`),
    );
  }
  const result = inspectReleaseVersionSources(root);
  if (
    result.errors.length > 0 ||
    result.desktop_version !== plan.target.desktop_version ||
    result.cli_version !== plan.target.cli_version
  ) {
    throw new Error(`release plan did not converge:\n${result.errors.join("\n")}`);
  }
  return result;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const HELP = `Usage:
  desktop-release-plan --verify
  desktop-release-plan --desktop-version x.y.z --cli-version x.y.z [--write path] [--apply]

Create or verify one fail-closed plan for every canonical Desktop, runtime, CLI, and adapter version source.

Options:
  --verify                 Verify current canonical version sources without changing them.
  --desktop-version x.y.z  Required target Desktop and bundled-runtime version.
  --cli-version x.y.z      Required target CLI and adapter compatibility version.
  --write path             Write the generated JSON plan with owner-only permissions.
  --apply                  Apply the freshly generated plan after integrity checks.
  -h, --help               Show this help and exit.
`;

async function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("--verify")) {
    const report = inspectReleaseVersionSources();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.errors.length > 0) process.exitCode = 1;
    return;
  }
  const desktopVersion = valueAfter(args, "--desktop-version");
  const cliVersion = valueAfter(args, "--cli-version");
  if (!desktopVersion || !cliVersion) {
    throw new Error(
      "usage: desktop-release-plan --desktop-version x.y.z --cli-version x.y.z [--write path] [--apply]",
    );
  }
  const plan = createDesktopReleasePlan({ desktopVersion, cliVersion });
  const writePath = valueAfter(args, "--write");
  if (writePath) {
    const target = resolve(writePath);
    writeFileSync(target, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
    chmodSync(target, 0o600);
  }
  if (args.includes("--apply")) applyDesktopReleasePlan(plan);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
