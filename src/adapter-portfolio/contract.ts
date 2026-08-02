import { createHash } from "node:crypto";

import {
  AdapterPortfolioRegistrySchema,
  type AdapterPortfolioRegistry,
} from "./types.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function refSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function registrySha256(registry: AdapterPortfolioRegistry): string {
  return refSha256(AdapterPortfolioRegistrySchema.parse(registry));
}
