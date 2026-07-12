import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

import { CONFORMANCE_SCHEMA, EVENT_SCHEMA, RUNTIME_ID, RUNTIME_VERSION } from "./contract.js";

export type ConversationRuntimeState = {
  schema_version: string;
  pid: number;
  base_url: string;
  runtime_id: string;
  runtime_version: string;
  event_schema: string;
  started_at: string;
};

export type ConversationRuntimeStatus = {
  installed: boolean;
  running: boolean;
  healthy: boolean;
  runtime_id: string;
  runtime_version: string;
  event_schema: string;
  conformance_schema: string;
  pid: number | null;
  base_url: string | null;
  detail: string;
  state_dir: string;
  token_path: string;
  tool_token_path: string;
};

export function conversationRuntimeHome(): string {
  return resolve(
    process.env.UNDERSTUDY_CONVERSATION_RUNTIME_HOME ??
      join(homedir(), ".understudy", "runtime", "conversation"),
  );
}
function paths() {
  const root = conversationRuntimeHome();
  return {
    root,
    state: join(root, "state.json"),
    token: join(root, "token"),
    toolToken: join(root, "tool-token"),
    log: join(root, "runtime.log"),
  };
}

export function conversationSidecarEntry(): string {
  return fileURLToPath(new URL("./sidecar.js", import.meta.url));
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writeSecret(path: string): string {
  const value = randomBytes(32).toString("hex");
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return value;
}

function readState(path: string): ConversationRuntimeState | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ConversationRuntimeState;
    if (!Number.isInteger(value.pid) || !value.base_url || !value.runtime_version) return null;
    return value;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(1_500),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { event_schema?: string; runtime_version?: string };
    return (
      payload.event_schema === EVENT_SCHEMA && payload.runtime_version === RUNTIME_VERSION
    );
  } catch {
    return false;
  }
}

export function installConversationRuntime(): ConversationRuntimeStatus {
  const location = paths();
  ensurePrivateDir(location.root);
  const entry = conversationSidecarEntry();
  if (!existsSync(entry)) {
    throw new Error(`bundled conversation runtime is missing: ${entry}`);
  }
  return {
    installed: true,
    running: false,
    healthy: false,
    runtime_id: RUNTIME_ID,
    runtime_version: RUNTIME_VERSION,
    event_schema: EVENT_SCHEMA,
    conformance_schema: CONFORMANCE_SCHEMA,
    pid: null,
    base_url: null,
    detail: "bundled runtime installed; run `understudy runtime start`",
    state_dir: location.root,
    token_path: location.token,
    tool_token_path: location.toolToken,
  };
}

export async function conversationRuntimeStatus(): Promise<ConversationRuntimeStatus> {
  const location = paths();
  const installed = existsSync(conversationSidecarEntry());
  const state = readState(location.state);
  const running = state !== null && pidAlive(state.pid);
  const healthy = running && state ? await health(state.base_url) : false;
  let detail = "not installed";
  if (installed && !state) detail = "installed but stopped";
  else if (installed && state && !running) detail = "stale runtime state; run repair";
  else if (running && !healthy) detail = "runtime process is running but health failed";
  else if (healthy) detail = "runtime is ready";
  return {
    installed,
    running,
    healthy,
    runtime_id: state?.runtime_id ?? RUNTIME_ID,
    runtime_version: state?.runtime_version ?? RUNTIME_VERSION,
    event_schema: state?.event_schema ?? EVENT_SCHEMA,
    conformance_schema: CONFORMANCE_SCHEMA,
    pid: state?.pid ?? null,
    base_url: state?.base_url ?? null,
    detail,
    state_dir: location.root,
    token_path: location.token,
    tool_token_path: location.toolToken,
  };
}

export async function startConversationRuntime(): Promise<ConversationRuntimeStatus> {
  const current = await conversationRuntimeStatus();
  if (current.healthy) return current;
  const location = paths();
  installConversationRuntime();
  rmSync(location.state, { force: true });
  const token = writeSecret(location.token);
  const toolToken = writeSecret(location.toolToken);
  const logFd = openSync(location.log, "a", 0o600);
  const child = spawn(
    process.execPath,
    [conversationSidecarEntry(), "--port", "0", "--state-file", location.state],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        UNDERSTUDY_RUNTIME_TOKEN: token,
        UNDERSTUDY_RUNTIME_TOOL_TOKEN: toolToken,
      },
    },
  );
  closeSync(logFd);
  child.unref();

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await new Promise((accept) => setTimeout(accept, 50));
    const status = await conversationRuntimeStatus();
    if (status.healthy) return status;
    if (child.exitCode !== null) break;
  }
  throw new Error(`conversation runtime failed to start; inspect ${location.log}`);
}

export async function stopConversationRuntime(): Promise<ConversationRuntimeStatus> {
  const location = paths();
  const state = readState(location.state);
  if (state && pidAlive(state.pid)) {
    process.kill(state.pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && pidAlive(state.pid)) {
      await new Promise((accept) => setTimeout(accept, 50));
    }
    if (pidAlive(state.pid)) {
      throw new Error(`runtime pid ${state.pid} did not stop after SIGTERM`);
    }
  }
  rmSync(location.state, { force: true });
  rmSync(location.token, { force: true });
  rmSync(location.toolToken, { force: true });
  return conversationRuntimeStatus();
}

export async function repairConversationRuntime(): Promise<ConversationRuntimeStatus> {
  await stopConversationRuntime();
  installConversationRuntime();
  return startConversationRuntime();
}

export async function doctorConversationRuntime(): Promise<{
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  status: ConversationRuntimeStatus;
  repair_command: string;
}> {
  const status = await conversationRuntimeStatus();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const checks = [
    {
      name: "node",
      ok: Number.isInteger(nodeMajor) && nodeMajor >= 20,
      detail: process.version,
    },
    {
      name: "runtime_asset",
      ok: status.installed,
      detail: conversationSidecarEntry(),
    },
    {
      name: "event_schema",
      ok: status.event_schema === EVENT_SCHEMA,
      detail: status.event_schema,
    },
    {
      name: "runtime_health",
      ok: status.healthy,
      detail: status.detail,
    },
  ];
  return {
    ok: checks.every((check) => check.ok),
    checks,
    status,
    repair_command: "understudy runtime repair",
  };
}
