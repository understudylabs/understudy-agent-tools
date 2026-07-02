#!/usr/bin/env node

// Deterministic trigger + eval-row recorder for the watch-logs skill.
//
//   watch-logs.mjs check  --config <watch.json> [--state-dir <dir>] [--json]
//   watch-logs.mjs record [--state-dir <dir>] [--row <review.json>] [--json]
//
// `check` snapshots every configured source (log-file tails, command output),
// hashes the result, and compares against the last state under the state dir.
// Exit codes are scheduler-friendly: 0 = unchanged, 1 = changed (state and a
// snapshot payload were written; fire the cheap model review), 2 = error.
// `record` appends one review as an understudy.eval_result.v1 row to
// reviews/reviews.jsonl so the workload accumulates training-grade evidence.
//
// Local-only: this script never makes network calls. Command sources run
// whatever shell command the user configured (which may reach the network,
// e.g. curl to a health endpoint) — that is the user's explicit choice.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SNAPSHOT_SCHEMA = "understudy.watch_logs_snapshot.v1";
const EVAL_ROW_SCHEMA = "understudy.eval_result.v1";
const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function defaultStateDir() {
  return join(homedir(), ".understudy", "watch-logs");
}

/** Expand a file source into a sorted list of matching paths.
 *  Supports a literal `path`, or a `glob` whose pattern lives in the
 *  basename only (e.g. /var/log/workers/*.log). */
export function expandFileSource(source) {
  if (source.path) {
    return [resolve(source.path)];
  }
  const glob = source.glob;
  const dir = dirname(glob);
  const pattern = basename(glob);
  if (/[*?]/.test(dir)) {
    throw new Error(`glob wildcards are only supported in the basename: ${glob}`);
  }
  if (!existsSync(dir)) {
    return [];
  }
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`,
  );
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && regex.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();
}

/** Read the last `tailBytes` bytes of a file without loading the whole file. */
export function readTail(path, tailBytes) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString("utf8"), size };
  } finally {
    closeSync(fd);
  }
}

/** Produce the canonical content string for one source. Deterministic for
 *  identical underlying state; changes whenever the watched state changes. */
export function snapshotSource(source) {
  if (source.type === "file") {
    const tailBytes = source.tail_bytes ?? DEFAULT_TAIL_BYTES;
    const paths = expandFileSource(source);
    if (paths.length === 0) {
      return { content: "no files matched\n", detail: "0 files" };
    }
    const parts = [];
    for (const path of paths) {
      if (!existsSync(path)) {
        parts.push(`==> ${path} (missing) <==\n`);
        continue;
      }
      const { text, size } = readTail(path, tailBytes);
      parts.push(`==> ${path} (size ${size}) <==\n${text}`);
    }
    return { content: parts.join("\n"), detail: `${paths.length} file(s)` };
  }
  if (source.type === "command") {
    const result = spawnSync("/bin/sh", ["-c", source.command], {
      encoding: "utf8",
      timeout: source.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
    const exit = result.status ?? `signal:${result.signal ?? "unknown"}`;
    return {
      content: `exit=${exit}\n--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`,
      detail: `exit ${exit}`,
    };
  }
  throw new Error(`unknown source type: ${JSON.stringify(source.type)}`);
}

export function loadConfig(path) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!config.watch_id || typeof config.watch_id !== "string") {
    throw new Error("config needs a string watch_id");
  }
  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    throw new Error("config needs a non-empty sources array");
  }
  for (const source of config.sources) {
    if (!source.id) throw new Error("every source needs an id");
    if (source.type === "file" && !source.path && !source.glob) {
      throw new Error(`file source ${source.id} needs path or glob`);
    }
    if (source.type === "command" && !source.command) {
      throw new Error(`command source ${source.id} needs a command`);
    }
  }
  return config;
}

export function runCheck({ config, stateDir, now = new Date() }) {
  const statePath = join(stateDir, "state", `${config.watch_id}.json`);
  const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;

  const sources = {};
  const changed = [];
  const unchanged = [];
  for (const source of config.sources) {
    const snapshot = snapshotSource(source);
    const digest = sha256(snapshot.content);
    sources[source.id] = { sha256: digest, bytes: Buffer.byteLength(snapshot.content), detail: snapshot.detail };
    const prevDigest = previous?.sources?.[source.id]?.sha256 ?? null;
    if (prevDigest === digest) {
      unchanged.push(source.id);
    } else {
      changed.push({ id: source.id, prev_sha256: prevDigest, sha256: digest, content: snapshot.content });
    }
  }
  const combined = sha256(config.sources.map((s) => `${s.id}:${sources[s.id].sha256}`).join("\n"));

  const state = {
    watch_id: config.watch_id,
    updated_at: now.toISOString(),
    combined_sha256: combined,
    sources,
  };
  mkdirSync(dirname(statePath), { recursive: true });

  if (changed.length === 0) {
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    return { changed: false, watch_id: config.watch_id, combined_sha256: combined };
  }

  const runId = `${config.watch_id}-${now.toISOString().replace(/[:.]/g, "-")}`;
  const snapshotPath = join(stateDir, "snapshots", `${runId}.json`);
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(
    snapshotPath,
    `${JSON.stringify(
      {
        schema_version: SNAPSHOT_SCHEMA,
        run_id: runId,
        watch_id: config.watch_id,
        created_at: now.toISOString(),
        first_run: previous === null,
        combined_sha256: combined,
        changed,
        unchanged,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return {
    changed: true,
    first_run: previous === null,
    watch_id: config.watch_id,
    run_id: runId,
    snapshot_path: snapshotPath,
    changed_sources: changed.map((entry) => entry.id),
    combined_sha256: combined,
  };
}

/** Turn a review result into an understudy.eval_result.v1 row and append it. */
export function recordReview({ review, stateDir, now = new Date() }) {
  if (!review || typeof review !== "object") {
    throw new Error("review must be a JSON object");
  }
  const watchId = review.watch_id ?? null;
  const runId = review.run_id ?? (watchId ? `watch-logs:${watchId}` : null);
  const taskId = review.task_id ?? review.snapshot_id ?? null;
  if (!runId || !taskId) {
    throw new Error("review needs run_id (or watch_id) and task_id (or snapshot_id)");
  }
  const verdict = review.verdict;
  if (verdict !== "nothing-wrong" && verdict !== "anomaly" && verdict !== "review-failed") {
    throw new Error('verdict must be "nothing-wrong", "anomaly", or "review-failed"');
  }
  if (typeof review.summary !== "string" || review.summary.length === 0) {
    throw new Error("review needs a non-empty summary string");
  }
  const anomalies = Array.isArray(review.anomalies) ? review.anomalies : [];
  if (verdict === "anomaly" && anomalies.length === 0) {
    throw new Error('verdict "anomaly" requires at least one anomalies entry');
  }
  if (verdict === "nothing-wrong" && anomalies.length > 0) {
    throw new Error('verdict "nothing-wrong" requires an empty anomalies array');
  }
  const score = typeof review.score === "number" ? review.score : null;
  const status = verdict === "review-failed" ? "error" : score === null ? "unscored" : "ok";
  const row = {
    schema_version: EVAL_ROW_SCHEMA,
    run_id: runId,
    task_id: taskId,
    split: "none",
    score,
    status,
    model: review.model ?? null,
    route: review.route ?? null,
    latency_ms: typeof review.latency_ms === "number" ? review.latency_ms : null,
    created_at: now.toISOString(),
    provenance: {
      harness_sha256: review.prompt_sha256 ?? null,
      artifact_refs: review.snapshot_path ? [review.snapshot_path] : [],
    },
    review: {
      verdict,
      summary: review.summary,
      anomalies,
    },
  };
  const reviewsPath = join(stateDir, "reviews", "reviews.jsonl");
  mkdirSync(dirname(reviewsPath), { recursive: true });
  appendFileSync(reviewsPath, `${JSON.stringify(row)}\n`);
  return { row, reviews_path: reviewsPath };
}

function parseArgs(argv) {
  const args = { command: null, config: null, stateDir: defaultStateDir(), row: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!args.command && !arg.startsWith("--")) args.command = arg;
    else if (arg === "--config") args.config = argv[++index];
    else if (arg === "--state-dir") args.stateDir = argv[++index];
    else if (arg === "--row") args.row = argv[++index];
    else if (arg === "--json") args.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.command === "check") {
      if (!args.config) throw new Error("check requires --config <watch.json>");
      const result = runCheck({ config: loadConfig(args.config), stateDir: args.stateDir });
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else console.log(result.changed ? `changed: ${result.changed_sources.join(", ")}` : "unchanged");
      process.exit(result.changed ? 1 : 0);
    }
    if (args.command === "record") {
      const text = args.row ? readFileSync(args.row, "utf8") : readFileSync(0, "utf8");
      const result = recordReview({ review: JSON.parse(text), stateDir: args.stateDir });
      console.log(args.json ? JSON.stringify(result.row, null, 2) : `recorded → ${result.reviews_path}`);
      process.exit(0);
    }
    throw new Error('usage: watch-logs.mjs <check|record> [--config <path>] [--state-dir <dir>] [--row <path>] [--json]');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
