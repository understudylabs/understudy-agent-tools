#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function usage() {
  return `Usage:
  node scripts/automationbench-fusion-status.mjs [--session <tmux-session>] [--log <path>] [--out-dir <dir>] [--json]

Summarizes a long-running Understudy Fusion AutomationBench run without touching it.
`;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function tmuxStatus(session) {
  const list = run("tmux", ["list-sessions"]);
  if (!list.ok) return { active: false, session, error: list.stderr || "tmux unavailable" };
  const active = list.stdout
    .split("\n")
    .some((line) => line.startsWith(`${session}:`));
  if (!active) return { active: false, session };
  const pane = run("tmux", ["capture-pane", "-pt", session, "-S", "-80"]);
  return {
    active: true,
    session,
    tail: pane.ok ? lastLines(pane.stdout, 20) : [],
  };
}

function processStatus() {
  const result = run("pgrep", ["-fl", "automationbench-fusion-matrix|auto-bench"]);
  if (!result.ok && !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function resultFiles(outDir) {
  const dir = resolve(outDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = resolve(dir, name);
      const stat = statSync(path);
      return {
        name,
        path,
        bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
      };
    });
}

function lastLines(text, count) {
  return text
    .split(/[\r\n]+/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count);
}

function latestProgressLine(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.includes("Processing ") && line.includes("/")) return line.replace(/\u001b\[[0-9;]*m/g, "");
  }
  return null;
}

function logStatus(logPath) {
  const path = resolve(logPath);
  if (!existsSync(path)) return { path, exists: false, tail: [], progress: null };
  const content = readFileSync(path, "utf8");
  const tail = lastLines(content, 40);
  return {
    path,
    exists: true,
    bytes: statSync(path).size,
    progress: latestProgressLine(tail),
    tail: tail.slice(-12),
  };
}

function printText(status) {
  console.log(`session: ${status.tmux.session} (${status.tmux.active ? "active" : "inactive"})`);
  if (status.log.progress) console.log(`progress: ${status.log.progress}`);
  console.log(`processes: ${status.processes.length}`);
  for (const line of status.processes) console.log(`  ${line}`);
  console.log(`results: ${status.results.length}`);
  for (const file of status.results) console.log(`  ${file.name} (${file.bytes} bytes, ${file.modified_at})`);
  if (!status.log.progress && status.tmux.tail?.length) {
    const progress = latestProgressLine(status.tmux.tail);
    if (progress) console.log(`pane_progress: ${progress}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(usage());
    return;
  }
  const session = argValue(args, "--session") ?? "understudy-final-ab";
  const log = argValue(args, "--log") ?? ".understudy/fusion-benchmark/logs/final-comparison-20260630T144104Z.log";
  const outDir = argValue(args, "--out-dir") ?? ".understudy/fusion-benchmark/runs-final-20260630T144104Z";
  const status = {
    schema_version: "understudy.automationbench_fusion_status.v1",
    tmux: tmuxStatus(session),
    processes: processStatus(),
    log: logStatus(log),
    results: resultFiles(outDir),
  };
  if (args.includes("--json")) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  printText(status);
}

main();
