import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { pidAlive, probeDaemonHealth } from "./daemon.js";

export const DESKTOP_API_SCHEMA = "understudy.desktop_api.v2";
export const DESKTOP_API_OPENAPI_VERSION = "2.2.0";

export function desktopApiContractPath(): string {
  return fileURLToPath(
    new URL("../../schemas/understudy.desktop_api.v2.openapi.json", import.meta.url),
  );
}

export function readDesktopApiContract(): Record<string, unknown> {
  const path = desktopApiContractPath();
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`desktop API contract is malformed: ${path}`);
  }
  const contract = value as Record<string, unknown>;
  const info = contract.info;
  if (
    contract.openapi !== "3.1.0" ||
    !info ||
    typeof info !== "object" ||
    Array.isArray(info) ||
    (info as Record<string, unknown>).version !== DESKTOP_API_OPENAPI_VERSION
  ) {
    throw new Error(`desktop API contract version is incompatible: ${path}`);
  }
  return contract;
}

export interface DesktopApiCapability {
  schemaVersion: string;
  baseUrl: string;
  token: string;
  pid: number;
  appVersion: string | null;
  path: string;
}

export interface DesktopSlotProviderTarget {
  slotId: number;
  artifactId: string;
  baseUrl: string;
  model: string;
}

export function desktopApiPath(): string {
  return process.env.UNDERSTUDY_DESKTOP_API_FILE ??
    join(homedir(), ".understudy", "desktop-api.json");
}

function loopbackBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("desktop API capability has no base_url");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("desktop API capability must use http://127.0.0.1");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("desktop API capability has an invalid base_url");
  }
  return url.origin;
}

export function readDesktopApiCapability(path: string = desktopApiPath()): DesktopApiCapability {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`desktop API capability must be a regular file: ${path}`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`desktop API capability permissions are too broad; expected mode 0600: ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read desktop API capability at ${path}: ${String(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("desktop API capability is malformed");
  }
  const row = value as Record<string, unknown>;
  if (row.schema_version !== DESKTOP_API_SCHEMA) {
    throw new Error(
      `desktop API capability schema ${String(row.schema_version ?? "missing")} is incompatible; ` +
        "update or restart Understudy Desktop",
    );
  }
  if (typeof row.token !== "string" || row.token.length < 32) {
    throw new Error("desktop API capability has no valid bearer token");
  }
  if (typeof row.pid !== "number" || !Number.isInteger(row.pid) || row.pid <= 0) {
    throw new Error("desktop API capability has no valid pid");
  }
  return {
    schemaVersion: row.schema_version,
    baseUrl: loopbackBaseUrl(row.base_url),
    token: row.token,
    pid: row.pid,
    appVersion: typeof row.app_version === "string" ? row.app_version : null,
    path,
  };
}

export async function requireDesktopApi(): Promise<DesktopApiCapability> {
  const capability = readDesktopApiCapability();
  if (!pidAlive(capability.pid)) {
    throw new Error(
      `desktop API capability is stale: pid ${capability.pid} is not running; launch Understudy Desktop`,
    );
  }
  if (!(await probeDaemonHealth(capability.baseUrl, 1_500))) {
    throw new Error(
      `Understudy Desktop pid ${capability.pid} is alive but ${capability.baseUrl}/health is unavailable`,
    );
  }
  return capability;
}

export async function desktopApiFetch(
  capability: DesktopApiCapability,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${capability.token}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(new URL(path, capability.baseUrl), { ...init, headers });
}

/**
 * Prefer the stable v1 control-plane route and fall back to its unversioned
 * predecessor for the single native-fallback release. The legacy routes use
 * the same handlers and payloads; this bridge can be deleted once desktop
 * 0.3.2 is the minimum supported version.
 */
export async function desktopApiFetchCompat(
  capability: DesktopApiCapability,
  versionedPath: string,
  legacyPath: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await desktopApiFetch(capability, versionedPath, init);
  if (response.status !== 404) return response;
  return desktopApiFetch(capability, legacyPath, init);
}

/**
 * Resolve one live Desktop residency slot into the exact OpenAI-compatible
 * provider identity used by the app. MLX accepts the weights path reliably;
 * a catalog/artifact alias may not match the model id exposed by the server.
 */
export async function resolveDesktopSlotProviderTarget(
  capability: DesktopApiCapability,
  slotId: number,
  timeoutMs: number = 1_500,
): Promise<DesktopSlotProviderTarget> {
  const response = await desktopApiFetchCompat(
    capability,
    "/v1/residency",
    "/api/residency",
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!response.ok) throw await responseError(response);
  const value = await response.json() as { slots?: unknown };
  const slots = Array.isArray(value.slots) ? value.slots : [];
  const slot = slots.find(
    (candidate): candidate is Record<string, unknown> =>
      Boolean(candidate) &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).id === slotId,
  );
  if (!slot) throw new Error(`desktop residency slot ${slotId} does not exist`);
  if (slot.state !== "running") {
    throw new Error(`desktop residency slot ${slotId} is ${String(slot.state ?? "not running")}`);
  }
  if (
    typeof slot.port !== "number" ||
    !Number.isInteger(slot.port) ||
    slot.port < 1 ||
    slot.port > 65_535
  ) {
    throw new Error(`desktop residency slot ${slotId} has no valid provider port`);
  }
  if (typeof slot.model_path !== "string" || slot.model_path.trim() === "") {
    throw new Error(
      `desktop residency slot ${slotId} does not expose its exact model path; update Understudy Desktop`,
    );
  }
  if (typeof slot.model_id !== "string" || slot.model_id.trim() === "") {
    throw new Error(`desktop residency slot ${slotId} has no assigned model id`);
  }
  return {
    slotId,
    artifactId: slot.model_id,
    baseUrl: `http://127.0.0.1:${slot.port}/v1`,
    model: slot.model_path,
  };
}

export async function responseError(response: Response): Promise<Error> {
  const text = (await response.text()).trim().slice(0, 4_096);
  return new Error(`desktop API returned ${response.status}: ${text || response.statusText}`);
}

export async function desktopMcpCall(
  capability: DesktopApiCapability,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await desktopApiFetch(capability, "/mcp", {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `understudy-cli-${process.pid}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!response.ok) throw await responseError(response);
  const value = await response.json() as {
    error?: { message?: unknown };
    result?: { structuredContent?: unknown };
  };
  if (value.error) {
    throw new Error(`desktop MCP ${name} failed: ${String(value.error.message ?? "unknown error")}`);
  }
  if (!value.result || !("structuredContent" in value.result)) {
    throw new Error(`desktop MCP ${name} returned no structured content`);
  }
  return value.result.structuredContent;
}
