import { createHash } from "node:crypto";

import type { ServingContract } from "./contract.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contractSha256(contract: ServingContract): string {
  return sha256(canonicalJson(contract));
}

export function contractFingerprint(contract: ServingContract): string {
  return sha256(canonicalJson({
    schema_version: contract.schema_version,
    base_id: contract.base_id,
    renderer: {
      id: contract.renderer.id,
      template_source: contract.renderer.template_source,
      stop_sequences: contract.renderer.stop_sequences,
    },
    tool_protocol: contract.tool_protocol,
    sampling: contract.sampling,
  }));
}

export function renderedPromptFingerprint(
  renderedPrompt: string,
): string {
  return sha256(renderedPrompt);
}
