// Immutable artifact contracts for the fleet scoreboard and the reap plan.
//
// These are the only shapes that cross a workflow boundary. They carry cost,
// ownership, and TTL facts plus content hashes — never traces, prompts, labels,
// credentials, or weights. A consumer passes the ref (uri + sha256), not the body.

import { createHash } from "node:crypto";

import type { ReapPlan } from "./reaper.js";
import type { Scoreboard } from "./scoreboard.js";

export const SCOREBOARD_SCHEMA = "understudy.fleet_scoreboard.v1";
export const REAP_PLAN_SCHEMA = "understudy.fleet_reap_plan.v1";
export const FLEET_EVENT_SCHEMA = "understudy.fleet_event.v1";

export interface ArtifactRef {
  schema_version: string;
  uri: string;
  sha256: string;
  bytes: number;
}

export interface FleetEvent {
  schema_version: typeof FLEET_EVENT_SCHEMA;
  at: string;
  kind: "scoreboard" | "reap_plan" | "reap_action" | "usage" | "error";
  experiment_id: string;
  candidate_id: string | null;
  attempt: number;
  /** Small scalar facts only — never payloads. */
  fields: Record<string, string | number | boolean | null>;
}

/** Stable key ordering so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Content-addressed reference to an artifact body already written at `uri`. */
export function artifactRef(artifact: { schema_version: string }, uri: string): ArtifactRef {
  const body = canonicalJson(artifact);
  return {
    schema_version: artifact.schema_version,
    uri,
    sha256: sha256Hex(body),
    bytes: Buffer.byteLength(body),
  };
}

export interface ScoreboardArtifact {
  schema_version: typeof SCOREBOARD_SCHEMA;
  experiment_id: string;
  account: string | null;
  generated_at: string;
  totals: Scoreboard["totals"];
  rows: {
    arm: string;
    candidate_id: string | null;
    deployment: string | null;
    owner: string | null;
    score: number | null;
    split: string | null;
    usd_per_hr: number;
    score_per_usd_hr: number | null;
    live: boolean;
    tagged: boolean;
    expires_at: string | null;
    flags: string[];
  }[];
}

export function toScoreboardArtifact(input: {
  scoreboard: Scoreboard;
  experimentId: string;
  account?: string | null;
}): ScoreboardArtifact {
  return {
    schema_version: SCOREBOARD_SCHEMA,
    experiment_id: input.experimentId,
    account: input.account ?? null,
    generated_at: input.scoreboard.generatedAt,
    totals: input.scoreboard.totals,
    rows: input.scoreboard.rows.map((row) => ({
      arm: row.arm,
      candidate_id: row.arm,
      deployment: row.deployment,
      owner: row.owner,
      score: row.score,
      split: row.split,
      usd_per_hr: row.usdPerHr,
      score_per_usd_hr: row.scorePerUsdHr,
      live: row.live,
      tagged: row.tagged,
      expires_at: row.expiresAt,
      flags: row.flags,
    })),
  };
}

export interface ReapPlanArtifact {
  schema_version: typeof REAP_PLAN_SCHEMA;
  experiment_id: string;
  candidate_id: string | null;
  attempt: number;
  idempotency_key: string;
  account: string | null;
  generated_at: string;
  mode: "dry-run" | "apply";
  policy: ReapPlan["policy"];
  counts: ReapPlan["counts"];
  savings_usd_per_hr: number;
  decisions: {
    name: string;
    action: string;
    reason: string;
    owner: string | null;
    arm: string | null;
    usd_per_hr: number;
    overdue_hours: number | null;
  }[];
  applied: { name: string; action: string; outcome: "applied" | "already-absent" }[];
}

export function toReapPlanArtifact(input: {
  plan: ReapPlan;
  experimentId: string;
  candidateId?: string | null;
  attempt: number;
  idempotencyKey: string;
  account?: string | null;
  mode: "dry-run" | "apply";
  applied?: ReapPlanArtifact["applied"];
}): ReapPlanArtifact {
  return {
    schema_version: REAP_PLAN_SCHEMA,
    experiment_id: input.experimentId,
    candidate_id: input.candidateId ?? null,
    attempt: input.attempt,
    idempotency_key: input.idempotencyKey,
    account: input.account ?? null,
    generated_at: input.plan.generatedAt,
    mode: input.mode,
    policy: input.plan.policy,
    counts: input.plan.counts,
    savings_usd_per_hr: input.plan.savingsUsdPerHr,
    decisions: input.plan.decisions.map((decision) => ({
      name: decision.name,
      action: decision.action,
      reason: decision.reason,
      owner: decision.owner,
      arm: decision.arm,
      usd_per_hr: decision.usdPerHr,
      overdue_hours: decision.overdueHours,
    })),
    applied: input.applied ?? [],
  };
}

export function fleetEvent(input: {
  kind: FleetEvent["kind"];
  experimentId: string;
  candidateId?: string | null;
  attempt: number;
  at?: string;
  fields?: FleetEvent["fields"];
}): FleetEvent {
  return {
    schema_version: FLEET_EVENT_SCHEMA,
    at: input.at ?? new Date().toISOString(),
    kind: input.kind,
    experiment_id: input.experimentId,
    candidate_id: input.candidateId ?? null,
    attempt: input.attempt,
    fields: input.fields ?? {},
  };
}
