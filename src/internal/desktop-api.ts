import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { pidAlive, probeDaemonHealth } from "./daemon.js";

export const DESKTOP_API_SCHEMA = "understudy.desktop_api.v2";

export interface DesktopApiCapability {
  schemaVersion: string;
  baseUrl: string;
  token: string;
  pid: number;
  appVersion: string | null;
  path: string;
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

export async function responseError(response: Response): Promise<Error> {
  const text = (await response.text()).trim().slice(0, 4_096);
  return new Error(`desktop API returned ${response.status}: ${text || response.statusText}`);
}
