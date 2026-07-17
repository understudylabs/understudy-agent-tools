#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectReleaseVersionSources,
  repositoryRoot,
} from "./desktop-release-plan.mjs";

export const PUBLIC_UPDATER_URL =
  "https://github.com/understudylabs/understudy-agent-tools/releases/latest/download/latest.json";

const HELP = `Usage: desktop-dev-status [options]

Report local Git, version compatibility, and Desktop release-source eligibility as JSON.

Options:
  --check-updater              Query the public updater manifest (network request).
  --require-release-eligible   Exit non-zero when source-state release blockers exist.
  -h, --help                   Show this help and exit.
`;

function captureGit(root, args, { optional = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

function boundedChangedPaths(status) {
  if (!status) return [];
  return status
    .split("\n")
    .filter(Boolean)
    .slice(0, 100)
    .map((line) => line.slice(3, 500));
}

async function inspectPublicUpdater(fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(PUBLIC_UPDATER_URL, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { checked: true, reachable: false, status: response.status, error: "http_error" };
    }
    const value = await response.json();
    const platform = value?.platforms?.["darwin-aarch64"];
    return {
      checked: true,
      reachable: true,
      status: response.status,
      version: typeof value?.version === "string" ? value.version : null,
      published_at: typeof value?.pub_date === "string" ? value.pub_date : null,
      artifact_url: typeof platform?.url === "string" ? platform.url : null,
      signature_present: typeof platform?.signature === "string" && platform.signature.length > 20,
    };
  } catch (error) {
    return {
      checked: true,
      reachable: false,
      status: null,
      error: error?.name === "TimeoutError" ? "timeout" : "request_failed",
    };
  }
}

export async function collectDesktopDeveloperStatus({
  root = repositoryRoot,
  checkUpdater = false,
  fetchImpl = fetch,
  updaterTimeoutMs = 5_000,
} = {}) {
  const worktreeRoot = captureGit(root, ["rev-parse", "--show-toplevel"]);
  const gitCommonDir = captureGit(root, ["rev-parse", "--git-common-dir"]);
  const branch = captureGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    optional: true,
  });
  const head = captureGit(root, ["rev-parse", "HEAD"]);
  const originMain = captureGit(root, ["rev-parse", "refs/remotes/origin/main"], {
    optional: true,
  });
  const porcelain = captureGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const changedPaths = boundedChangedPaths(porcelain);
  const versions = inspectReleaseVersionSources(root);
  const releaseBlockers = [];
  if (porcelain) releaseBlockers.push("worktree_dirty");
  if (!originMain) releaseBlockers.push("origin_main_missing");
  else if (head !== originMain) releaseBlockers.push("head_not_origin_main");
  if (versions.errors.length > 0) releaseBlockers.push("version_sources_drifted");
  const publicUpdater = checkUpdater
    ? await inspectPublicUpdater(fetchImpl, updaterTimeoutMs)
    : { checked: false, reachable: null };

  return {
    schema_version: "understudy.desktop_developer_status.v1",
    generated_at: new Date().toISOString(),
    git: {
      worktree_root: worktreeRoot,
      git_common_dir: resolve(root, gitCommonDir),
      branch,
      detached: branch === null,
      head,
      origin_main: originMain,
      head_matches_origin_main: originMain !== null && head === originMain,
      clean: !porcelain,
      changed_path_count: porcelain ? porcelain.split("\n").filter(Boolean).length : 0,
      changed_paths: changedPaths,
      changed_paths_truncated: Boolean(porcelain) && porcelain.split("\n").filter(Boolean).length > 100,
    },
    versions,
    release: {
      eligible_from_source_state: releaseBlockers.length === 0,
      blockers: releaseBlockers,
      note:
        "Source eligibility is necessary but not sufficient; exact-commit CI, protected signing, notarization, round-trip checks, and publication remain release workflow gates.",
    },
    public_updater: {
      url: PUBLIC_UPDATER_URL,
      ...publicUpdater,
    },
    privacy: {
      network_request_made: checkUpdater,
      secrets_read: false,
      telemetry_sent: false,
    },
  };
}

async function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const report = await collectDesktopDeveloperStatus({
    checkUpdater: args.includes("--check-updater"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.includes("--require-release-eligible") && !report.release.eligible_from_source_state) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
