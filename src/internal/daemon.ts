// Desktop-app daemon discovery. The Understudy desktop app is the canonical
// local daemon: while it runs, it maintains the `app` block of
// `~/.understudy/agent-card.json` (written by
// apps/homescreen/src-tauri/src/agent_card.rs — pid, base_url, warm models;
// never the bearer token). Discovery never trusts `running: true` alone: the
// recorded pid must be alive AND the recorded base_url must answer a health
// probe, because a crashed app (no graceful shutdown) leaves a stale card
// behind.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PROBE_TIMEOUT_MS = 800;

export interface DaemonWarmModel {
  id: string;
  port: number | null;
  model_path: string;
}

export interface DaemonStatus {
  /** An agent card with an `app` block exists (the app ran at least once). */
  detected: boolean;
  /** Card says running, the pid is alive, and the health probe answered. */
  running: boolean;
  baseUrl: string | null;
  pid: number | null;
  version: string | null;
  warmModels: DaemonWarmModel[];
  /** Protected local HTTP/MCP calls can be authenticated without exposing the token. */
  controlReady: boolean;
  /** Human-readable reason for the verdict. */
  detail: string;
  cardPath: string;
  capabilityPath: string;
}

export function agentCardPath(): string {
  return join(homedir(), ".understudy", "agent-card.json");
}

export function desktopCapabilityPath(): string {
  return join(homedir(), ".understudy", "desktop-api.json");
}

type DesktopCapability = {
  baseUrl: string;
  mcpUrl: string;
  pid: number;
  token: string;
};

function readDesktopCapability(path: string): DesktopCapability | null {
  try {
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (row.schema_version !== "understudy.desktop_api.v1") return null;
    if (typeof row.base_url !== "string" || typeof row.mcp_url !== "string") return null;
    if (typeof row.pid !== "number" || !Number.isInteger(row.pid) || row.pid <= 0) return null;
    if (typeof row.token !== "string" || row.token.length < 32) return null;
    const base = new URL(row.base_url);
    const mcp = new URL(row.mcp_url);
    if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") return null;
    if (mcp.origin !== base.origin || mcp.pathname !== "/mcp") return null;
    return { baseUrl: base.origin, mcpUrl: mcp.toString(), pid: row.pid, token: row.token };
  } catch {
    return null;
  }
}

/** Parse the agent card; null when missing or unreadable JSON. */
export function readAgentCard(cardPath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(cardPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Signal-0 liveness check. EPERM means the pid exists but belongs to another
 * user — still alive for our purposes.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** GET <baseUrl>/health with a short timeout; the route is unauthenticated. */
export async function probeDaemonHealth(
  baseUrl: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const url = new URL("/health", baseUrl);
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface DaemonStatusOptions {
  /** Override the card location (tests use a temp fixture). */
  cardPath?: string;
  /** Health probe timeout in milliseconds. */
  timeoutMs?: number;
  /** Override the private desktop capability location (tests use a temp fixture). */
  capabilityPath?: string;
}

export async function daemonStatus(options: DaemonStatusOptions = {}): Promise<DaemonStatus> {
  const cardPath = options.cardPath ?? agentCardPath();
  const capabilityPath = options.capabilityPath ?? desktopCapabilityPath();
  const notRunning = (detail: string, extra: Partial<DaemonStatus> = {}): DaemonStatus => ({
    detected: false,
    running: false,
    baseUrl: null,
    pid: null,
    version: null,
    warmModels: [],
    controlReady: false,
    detail,
    cardPath,
    capabilityPath,
    ...extra,
  });

  const card = readAgentCard(cardPath);
  if (!card) {
    return notRunning(`no agent card at ${cardPath} (desktop app not installed or never started)`);
  }
  const app = card.app;
  if (typeof app !== "object" || app === null || Array.isArray(app)) {
    return notRunning("agent card has no app block (desktop app has not run)");
  }
  const appBlock = app as Record<string, unknown>;
  const pid = typeof appBlock.pid === "number" ? appBlock.pid : null;
  const baseUrl = typeof appBlock.base_url === "string" ? appBlock.base_url : null;
  const version = typeof appBlock.version === "string" ? appBlock.version : null;
  const detected: Partial<DaemonStatus> = { detected: true, pid, baseUrl, version };

  if (appBlock.running !== true) {
    const stoppedAt = typeof appBlock.stopped_at === "string" ? ` at ${appBlock.stopped_at}` : "";
    return notRunning(`desktop app marked stopped${stoppedAt}`, detected);
  }
  // Never trust `running: true` alone: a crash skips the graceful-shutdown
  // card update, so verify the pid before believing the card.
  if (pid === null || !pidAlive(pid)) {
    return notRunning(
      `agent card claims running but pid ${pid ?? "?"} is not alive (stale card)`,
      detected,
    );
  }
  if (!baseUrl) {
    return notRunning("agent card has no base_url for the local server", detected);
  }
  const healthy = await probeDaemonHealth(baseUrl, options.timeoutMs);
  if (!healthy) {
    return notRunning(
      `pid ${pid} is alive but ${baseUrl}/health did not respond`,
      detected,
    );
  }

  const warmModels: DaemonWarmModel[] = Array.isArray(appBlock.warm_models)
    ? appBlock.warm_models.flatMap((entry: unknown): DaemonWarmModel[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const row = entry as Record<string, unknown>;
        if (typeof row.id !== "string") return [];
        return [
          {
            id: row.id,
            port: typeof row.port === "number" ? row.port : null,
            model_path: typeof row.model_path === "string" ? row.model_path : "",
          },
        ];
      })
    : [];
  const capability = readDesktopCapability(capabilityPath);
  const controlReady =
    capability !== null && capability.pid === pid && capability.baseUrl === new URL(baseUrl).origin;

  return {
    detected: true,
    running: true,
    baseUrl,
    pid,
    version,
    warmModels,
    controlReady,
    detail: `desktop app daemon running at ${baseUrl}${controlReady ? ", control ready" : ", health only"}`,
    cardPath,
    capabilityPath,
  };
}

export async function daemonMcpRequest(
  method: "tools/list" | "tools/call",
  params: Record<string, unknown> = {},
  options: DaemonStatusOptions = {},
): Promise<unknown> {
  const status = await daemonStatus(options);
  if (!status.running) throw new Error(`desktop app is not running: ${status.detail}`);
  if (!status.controlReady) {
    throw new Error(
      `desktop app control is unavailable: no matching owner-only capability at ${status.capabilityPath}`,
    );
  }
  const capability = readDesktopCapability(status.capabilityPath);
  if (!capability) throw new Error("desktop app capability became unavailable");
  const response = await fetch(capability.mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${capability.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "understudy-cli", method, params }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`desktop app returned HTTP ${response.status}`);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("desktop app returned an invalid MCP response");
  }
  const envelope = body as Record<string, unknown>;
  if (envelope.error) throw new Error(`desktop MCP error: ${JSON.stringify(envelope.error)}`);
  return envelope.result;
}

/** One-line summary for doctor-style output. */
export function describeDaemon(status: DaemonStatus): string {
  return status.running
    ? `running at ${status.baseUrl}`
    : `not detected (${status.detail})`;
}
