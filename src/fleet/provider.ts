// Thin HTTP client for the dedicated-deployment provider (Fireworks control
// plane). Kept separate from the planners so every planner stays offline-testable.

import { type RawDeployment, readDeploymentList } from "./deployments.js";

export interface ProviderConfig {
  account: string;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.fireworks.ai/v1";

function client(config: ProviderConfig) {
  if (!config.account) throw new Error("account is required");
  if (!config.apiKey) throw new Error("API key is required (never hard-code it)");
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = config.fetchImpl ?? fetch;
  const prefix = `${baseUrl}/accounts/${encodeURIComponent(config.account)}`;
  return async (path: string, init: RequestInit = {}) => {
    const response = await doFetch(`${prefix}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`provider API error ${response.status}: ${await response.text()}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  };
}

export async function listDeployments(config: ProviderConfig): Promise<RawDeployment[]> {
  const call = client(config);
  return readDeploymentList(await call("/deployments?pageSize=200"));
}

export async function scaleDeploymentToZero(config: ProviderConfig, name: string): Promise<void> {
  const call = client(config);
  await call(`/deployments/${encodeURIComponent(name)}?updateMask=desiredReplicaCount`, {
    method: "PATCH",
    body: JSON.stringify({ desiredReplicaCount: 0 }),
  });
}

export async function deleteDeployment(config: ProviderConfig, name: string): Promise<void> {
  const call = client(config);
  await call(`/deployments/${encodeURIComponent(name)}`, { method: "DELETE" });
}
