// Owner/TTL tagging convention for training-arm deployments.
//
// Every deployment an arm creates must carry an owner and a time-to-live so an
// automated reaper can tell "still needed" from "orphaned". Tags are read from
// whichever string map the provider exposes (annotations, labels, metadata) and,
// as a fallback, from a `key=value;key=value` string in the description field.

export const TAG_OWNER = "understudy.owner";
export const TAG_TTL_HOURS = "understudy.ttl-hours";
export const TAG_EXPIRES_AT = "understudy.expires-at";
export const TAG_ARM = "understudy.arm";

export interface DeploymentTags {
  owner: string | null;
  ttlHours: number | null;
  expiresAt: string | null;
  arm: string | null;
}

export interface TagSources {
  annotations?: Record<string, unknown> | null;
  labels?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  description?: string | null;
}

function fromDescription(description: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const part of description.split(/[;\n]/)) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) pairs.set(key, value);
  }
  return pairs;
}

function collect(sources: TagSources): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const map of [sources.metadata, sources.labels, sources.annotations]) {
    if (!map) continue;
    for (const [key, value] of Object.entries(map)) {
      if (typeof value === "string" || typeof value === "number") {
        pairs.set(key.trim(), String(value).trim());
      }
    }
  }
  if (sources.description) {
    for (const [key, value] of fromDescription(sources.description)) {
      if (!pairs.has(key)) pairs.set(key, value);
    }
  }
  return pairs;
}

function positiveNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isoTimestamp(raw: string | undefined): string | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Read the owner/TTL convention out of a provider deployment record. */
export function parseDeploymentTags(sources: TagSources): DeploymentTags {
  const pairs = collect(sources);
  return {
    owner: pairs.get(TAG_OWNER)?.trim() || null,
    ttlHours: positiveNumber(pairs.get(TAG_TTL_HOURS)),
    expiresAt: isoTimestamp(pairs.get(TAG_EXPIRES_AT)),
    arm: pairs.get(TAG_ARM)?.trim() || null,
  };
}

/** True when the deployment carries enough signal for the reaper to act on it. */
export function isReapable(tags: DeploymentTags): boolean {
  return Boolean(tags.owner) && (tags.ttlHours !== null || tags.expiresAt !== null);
}

/** Absolute expiry for a deployment, from an explicit stamp or createTime + TTL. */
export function expiryIso(tags: DeploymentTags, createTime: string | null): string | null {
  if (tags.expiresAt) return tags.expiresAt;
  if (tags.ttlHours === null || !createTime) return null;
  const created = Date.parse(createTime);
  if (Number.isNaN(created)) return null;
  return new Date(created + tags.ttlHours * 3_600_000).toISOString();
}

/** Tag map an arm should attach when it creates a deployment. */
export function buildDeploymentTags(input: {
  owner: string;
  ttlHours: number;
  arm?: string;
  createdAt?: string;
}): Record<string, string> {
  if (!input.owner.trim()) throw new Error("owner is required");
  if (!Number.isFinite(input.ttlHours) || input.ttlHours <= 0) throw new Error("ttlHours must be > 0");
  const created = input.createdAt ? Date.parse(input.createdAt) : Date.now();
  if (Number.isNaN(created)) throw new Error("createdAt must be an ISO timestamp");
  const tags: Record<string, string> = {
    [TAG_OWNER]: input.owner.trim(),
    [TAG_TTL_HOURS]: String(input.ttlHours),
    [TAG_EXPIRES_AT]: new Date(created + input.ttlHours * 3_600_000).toISOString(),
  };
  if (input.arm?.trim()) tags[TAG_ARM] = input.arm.trim();
  return tags;
}
